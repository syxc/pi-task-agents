import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession, ExtensionFactory, ModelRuntime } from '@earendil-works/pi-coding-agent';

type Run = { controller: AbortController; settled?: boolean; aborted?: boolean };
interface Admission<T> {
  run: T;
  open: boolean;
  committing: boolean;
  accepted: boolean;
  rejected: boolean;
  done: Promise<void>;
  finish(): void;
}
const notAccepted = () => Object.assign(new Error('Child owning turn no longer accepts this input'), { steerAccepted: false });

/** Keep SDK input processing and queue bookkeeping, but bind its final sink to one owning turn. */
export function createChildSteering<T extends Run>(current: () => T | undefined) {
  const context = new AsyncLocalStorage<Admission<T>>();
  const promptContext = new AsyncLocalStorage<T>();
  // An input handler can send nested input. Its guard is not the outer call's
  // final commit segment, and its queue side effects cannot prove non-admission.
  const inputDepth = new AsyncLocalStorage<number>();
  const pending = new WeakMap<T, Set<Admission<T>>>();
  const closed = new WeakSet<T>();
  const ownsRun = (run: T) => current() === run && !closed.has(run) &&
    !run.settled && !run.aborted && !run.controller.signal.aborted;
  const ownsTurn = (input: Admission<T>) => ownsRun(input.run);
  const valid = (input: Admission<T>) => input.open && ownsTurn(input);

  async function beforeSettle() {
    const run = current();
    const signal = run?.controller.signal;
    if (!run || !signal) return;
    const inputs = pending.get(run);
    if (!inputs?.size) return;
    let aborted!: () => void;
    const cancellation = new Promise<void>((resolve) => { aborted = resolve; });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    try {
      while (inputs.size && !signal.aborted) {
        await Promise.race([Promise.all([...inputs].map((input) => input.done)), cancellation]);
      }
      // The final input guard is synchronous and last. Its commit segment has
      // no third-party await, but must finish before abort/close can release A.
      await Promise.all([...inputs].filter((input) => input.committing).map((input) => input.done));
    } finally { signal.removeEventListener('abort', aborted); }
  }

  const extension: ExtensionFactory = (pi) => {
    pi.on('input', () => {
      const prompt = promptContext.getStore();
      if (prompt && !ownsRun(prompt)) return { action: 'handled' };
      const input = context.getStore();
      if (!input) return;
      if (!valid(input)) { input.rejected = true; return { action: 'handled' }; }
      if (inputDepth.getStore() === 1) input.committing = true;
    });
    pi.on('agent_before_settle', beforeSettle);
  };

  function attach(session: AgentSession) {
    // This wraps only the public synchronous sink. session.steer still runs all
    // input handlers, expansions, and pending-message accounting.
    const runner = session.extensionRunner;
    if (runner?.emitInput) {
      const emitInput = runner.emitInput.bind(runner);
      runner.emitInput = (...args) => inputDepth.run((inputDepth.getStore() ?? 0) + 1, () => emitInput(...args));
    }
    if (session.agent?.prompt) {
      const prompt = session.agent.prompt.bind(session.agent);
      session.agent.prompt = (...args) => {
        const run = promptContext.getStore();
        // Pi can finish async input/auth/start hooks after an idle abort returned.
        if (run && !ownsRun(run)) return Promise.reject(Object.assign(new Error('Child session aborted before model dispatch'), { name: 'AbortError' }));
        return Reflect.apply(prompt, session.agent, args);
      };
    }
    if (!session.agent?.steer) return; // Minimal injected SDK doubles have no Agent.
    const steer = session.agent.steer.bind(session.agent);
    session.agent.steer = (message) => {
      const input = context.getStore();
      if (input) {
        if (!valid(input)) { input.rejected = true; return; }
        input.accepted = true;
      }
      steer(message);
    };
  }

  async function steer(session: AgentSession, text: string): Promise<unknown> {
    const run = current();
    if (!run || run.settled || run.aborted || closed.has(run) || run.controller.signal.aborted) throw notAccepted();
    let finish!: () => void;
    const input: Admission<T> = { run, open: true, committing: false, accepted: false, rejected: false,
      done: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish() };
    const inputs = pending.get(run) ?? new Set<Admission<T>>();
    pending.set(run, inputs); inputs.add(input);
    let refuse!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { refuse = reject; });
    const abort = () => {
      if (!input.committing) {
        input.rejected = true;
        refuse(input.accepted ? new Error('Input aborted after possible SDK queue admission') : notAccepted());
      }
    };
    run.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const operation = context.run(input, () => session.steer(text, undefined, { source: 'extension' }));
      const disposition = await Promise.race([operation, cancelled]);
      if (input.rejected || disposition === 'handled') {
        if (input.accepted) throw new Error('Input handled after possible SDK queue admission');
        throw notAccepted();
      }
      if (disposition === 'queued' && session.agent && !input.accepted) {
        throw new Error('SDK steering did not pass the owning-turn queue sink');
      }
      return disposition;
    } finally {
      run.controller.signal.removeEventListener('abort', abort);
      input.open = false; inputs.delete(input); input.finish();
    }
  }

  async function close(run: T, session: AgentSession) {
    closed.add(run);
    await Promise.all([...(pending.get(run) ?? [])].filter((input) => input.committing).map((input) => input.done));
    // This is normal owner-close cleanup, never a compensating delivery or a
    // replay: a canceled turn's unconsumed input must not enter its successor.
    if (session.pendingMessageCount > 0 || session.agent?.hasQueuedMessages()) session.clearQueue?.();
  }

  return { extension, attach, steer, close,
    scopeRuntime: (runtime: ModelRuntime): ModelRuntime => new Proxy(runtime, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        // Keep the SDK's branded Agent stream function intact so OAuth resolution stays native.
        if (key === 'streamSimple') return (...args: Parameters<ModelRuntime['streamSimple']>) => {
          const run = promptContext.getStore();
          if (run && !ownsRun(run)) throw Object.assign(new Error('Child session aborted before model request'), { name: 'AbortError' });
          return Reflect.apply(value, target, args);
        };
        return typeof value === 'function' && key !== 'constructor' ? value.bind(target) : value;
      },
    }),
    prompt: (session: AgentSession, run: T, ...args: Parameters<AgentSession['prompt']>) =>
      promptContext.run(run, () => session.prompt(...args)),
    staleInput: () => {
      const input = context.getStore(), prompt = promptContext.getStore();
      return !!input && !ownsTurn(input) || !!prompt && !ownsRun(prompt);
    } };
}
