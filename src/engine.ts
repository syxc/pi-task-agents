import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { TaskStore } from './store.ts';
import { TaskDomain } from './task-domain.ts';
import { normalizeTaskError } from './vendor/mcode-background-task/errors.ts';
import { ACTIVE_TASK_STATUSES } from './vendor/mcode-background-task/status.ts';
import type {
  AgentProfile, ChildSession, CreateChild, TaskEngineOptions, TaskInput, TaskOutput,
  TaskOutputOptions, TaskQuery, TaskRecord, TaskRequestOptions, TaskState, TaskStatus, TaskSummary,
} from './types.ts';

interface TaskRuntime {
  accepting: boolean;
  sealed?: boolean;
  started?: Promise<ChildSession>;
  ready?: Promise<ChildSession>;
  done?: Promise<void>;
  delivery?: Promise<void>;
  aborting?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  stopReason?: string;
  stopStatus?: 'canceled' | 'failed';
  resultStatus?: 'succeeded' | 'failed';
}

interface SessionRuntime {
  child?: ChildSession;
  active?: TaskRecord;
}

const pending = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const aborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
};

export class TaskEngine {
  readonly parentId: string;
  readonly cwd: string;
  readonly store: TaskStore;
  readonly maxConcurrency: number;
  createChild: CreateChild;
  readonly notify: TaskEngineOptions['notify'];
  readonly onChange: TaskEngineOptions['onChange'];
  readonly runtimes: Map<string, TaskRuntime>;
  readonly sessions: Map<string, SessionRuntime>;
  readonly waiters: Set<() => void>;
  readonly operations: Map<string, Promise<TaskSummary>>;
  state?: TaskState;
  private readonly domain: TaskDomain;
  private gate: Promise<unknown>;
  private closed = false;
  private closing?: Promise<void>;
  private storageError: unknown;

  constructor({ rootDir, parentId, cwd, maxConcurrency = 4, createChild, notify, onChange }: TaskEngineOptions) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('Invalid maxConcurrency');
    this.parentId = parentId;
    this.cwd = resolve(cwd);
    this.store = new TaskStore(rootDir, parentId);
    this.maxConcurrency = maxConcurrency;
    this.createChild = createChild;
    this.notify = notify;
    this.onChange = onChange;
    this.runtimes = new Map();
    this.sessions = new Map();
    this.waiters = new Set();
    this.operations = new Map();
    this.gate = Promise.resolve();
    this.domain = new TaskDomain(() => this.getState());
  }

  async init(): Promise<this> {
    if (this.state || this.closed) throw new Error('Engine already initialized or closed');
    this.state = await this.store.init();
    for (const task of this.getState().tasks) {
      if (task.parent_id !== this.parentId) {
        await this.store.close();
        this.state = undefined;
        throw new Error('Task owner mismatch');
      }
      if (pending.has(task.status)) {
        this.domain.transition(task, 'lost');
        task.error = 'Previous task owner exited';
        task.finished_at = new Date().toISOString();
        task.notification_pending = task.notify_completion !== false;
      }
    }
    try { await this.persist(); } catch (error) { await this.store.close(); throw error; }
    return this;
  }

  assertOpen(): void {
    if (!this.state || this.closed) throw new Error('Engine is not open');
    if (this.storageError) throw this.storageError;
  }

  private getState(): TaskState {
    if (!this.state) throw new Error('Engine is not open');
    return this.state;
  }

  exclusive<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    const result = this.gate.then(fn);
    this.gate = result.catch(() => {});
    return result;
  }

  persist(): Promise<void> { return this.store.save(this.getState()); }

  changed(task: TaskRecord): void {
    for (const wake of this.waiters) wake();
    try { Promise.resolve(this.onChange?.(this.summary(task))).catch(() => {}); } catch {}
  }

  summary(task: TaskRecord): TaskSummary {
    const { output, cursor, input, profile, ...result } = task;
    return { ...clone(result), output_bytes: Buffer.byteLength(output) };
  }

  task(id: string): TaskRecord {
    const task = this.getState().tasks.find((item) => item.task_id === id);
    if (!task || task.parent_id !== this.parentId) throw new Error('Unknown task for this parent');
    return task;
  }

  request(key: string | undefined, fn: (key?: string) => Promise<TaskSummary>): Promise<TaskSummary> {
    if (!key) return this.exclusive(fn);
    const existing = this.operations.get(key);
    if (existing) return existing;
    const result = this.exclusive(async () => {
      this.assertOpen();
      const id = this.getState().requests[key];
      return id ? this.summary(this.task(id)) : fn(key);
    });
    this.operations.set(key, result);
    result.catch(() => {}).finally(() => this.operations.delete(key));
    return result;
  }

  async start(input: TaskInput, profile: AgentProfile, { requestId, signal }: TaskRequestOptions = {}): Promise<TaskSummary> {
    aborted(signal);
    const result = await this.request(requestId && `start:${requestId}`, async (key) => {
      this.assertOpen();
      aborted(signal);
      const effective = { ...clone(profile) };
      if (input.model) effective.model = input.model;
      if (input.effort) effective.thinking = input.effort;
      return this.enqueue(input, effective, undefined, key);
    });
    if (input.run_in_background !== false) return result;
    const task = this.task(result.task_id);
    let cancellation: Promise<TaskSummary> | undefined;
    const onAbort = () => {
      cancellation ??= this.cancel(task, 'Foreground request aborted');
      cancellation.catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      await this.waitUntil(() => !pending.has(task.status));
      await this.runtimes.get(task.task_id)?.done;
      await cancellation;
      return { ...this.summary(task), final_text: task.final_text ?? task.output };
    } finally { signal?.removeEventListener('abort', onAbort); }
  }

  async enqueue(input: TaskInput, profile: AgentProfile, previous?: TaskRecord, key?: string): Promise<TaskSummary> {
    const id = this.domain.createId();
    const sessionId = previous?.session_id ?? randomUUID();
    const task: TaskRecord = {
      task_id: id, session_id: sessionId, parent_id: this.parentId,
      childSessionPath: previous?.childSessionPath ?? join(this.store.dir, `${sessionId}.jsonl`),
      profile: freeze(clone(profile)), input: clone(input), status: 'queued',
      description: input.description ?? '', agent_name: input.agent_name ?? profile.name,
      created_at: new Date().toISOString(), output: '', cursor: 0, notification_pending: false,
      notify_completion: input.run_in_background !== false,
    };
    this.getState().tasks.push(task);
    if (key) this.getState().requests[key] = id;
    await this.persist();
    this.changed(task);
    const result = this.summary(task);
    this.pump();
    return result;
  }

  async append(taskId: string, content: string, { requestId, signal }: TaskRequestOptions = {}): Promise<TaskSummary> {
    aborted(signal);
    return this.request(requestId && `append:${taskId}:${requestId}`, async (key) => {
      this.assertOpen();
      aborted(signal);
      const original = this.task(taskId);
      const task = this.getState().tasks.filter((item) => item.session_id === original.session_id).at(-1);
      if (!task) throw new Error('Unknown task for this parent');
      if (task.status === 'stopping') throw new Error('Task is stopping');
      if (task.status === 'queued') {
        task.input.prompt += `\n${content}`;
        if (key) this.getState().requests[key] = task.task_id;
        await this.persist();
        this.changed(task);
        return this.summary(task);
      }
      const runtime = this.runtimes.get(task.task_id);
      if (runtime?.accepting) {
        let release!: () => void;
        let accepted = false;
        let failure: unknown;
        // Reserve delivery before yielding so completion cannot reuse this child.
        runtime.delivery = new Promise((resolve) => { release = resolve; });
        try {
          const child = await runtime.started!;
          if (runtime.accepting && task.status === 'running') {
            await child.steer(content);
            accepted = true;
          }
        } catch (error) { failure = error; }
        finally { release(); runtime.delivery = undefined; }
        if (accepted) {
          if (key) this.getState().requests[key] = task.task_id;
          await this.persist();
          this.changed(task);
          return this.summary(task);
        }
        if (runtime.stopReason) throw failure ?? new Error('Task is stopping');
        if (failure && runtime.accepting) throw failure;
      }
      // A settled prompt can reject steer before its completion reaches this caller.
      await runtime?.done;
      return this.enqueue({ ...task.input, prompt: content, run_in_background: true }, task.profile, task, key);
    });
  }

  pump(): void {
    if (this.closed || this.storageError) return;
    while (this.runtimes.size < this.maxConcurrency) {
      const task = this.getState().tasks.find((item) => item.status === 'queued');
      if (!task) break;
      this.domain.transition(task, 'running');
      task.started_at = new Date().toISOString();
      const runtime: TaskRuntime = { accepting: true };
      this.runtimes.set(task.task_id, runtime);
      runtime.done = this.run(task, runtime);
    }
  }

  async run(task: TaskRecord, runtime: TaskRuntime): Promise<void> {
    let startedResolve!: (child: ChildSession) => void;
    let startedReject!: (error: Error) => void;
    runtime.started = new Promise<ChildSession>((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
    runtime.started.catch(() => {});
    let session = this.sessions.get(task.session_id);
    if (!session) { session = {}; this.sessions.set(task.session_id, session); }
    session.active = task;
    runtime.ready = Promise.resolve().then(async () => {
      if (!session.child) {
        session.child = await this.createChild({
          profile: freeze(clone(task.profile)), cwd: this.cwd, sessionPath: task.childSessionPath,
          onOutput: (chunk) => {
            const current = session.active;
            if (!current || !pending.has(current.status)) return;
            current.output += String(chunk);
            this.persist().catch((error) => { this.storageError = error; });
            this.changed(current);
          },
          onActivity: () => { if (session.active) this.changed(session.active); },
        });
      }
      return session.child;
    });
    runtime.ready.catch(() => {});
    try {
      await this.persist();
      this.changed(task);
      const child = await runtime.ready;
      if (child.sessionPath && child.sessionPath !== task.childSessionPath) {
        throw new Error('Child session path does not match assigned path');
      }
      if (!runtime.stopReason) {
        if (task.profile.timeoutMs > 0) {
          runtime.timer = setTimeout(() => {
            this.cancel(task, 'Task timed out', 'failed').catch(() => {});
          }, task.profile.timeoutMs);
        }
        const prompting = child.prompt(task.input.prompt);
        startedResolve(child);
        const result = await prompting;
        task.final_text = result?.text ?? '';
        if (!task.output && task.final_text) task.output = task.final_text;
        if (result?.usage !== undefined) task.usage = result.usage;
        if (result?.verification !== undefined) task.verification = result.verification;
      }
      runtime.resultStatus = 'succeeded';
    } catch (error) {
      runtime.resultStatus = 'failed';
      if (!runtime.stopReason) task.error = normalizeTaskError(error).message;
    } finally {
      runtime.accepting = false;
      startedReject(new Error('Task ended before prompt dispatch'));
      clearTimeout(runtime.timer);
      if (runtime.delivery) await runtime.delivery;
      // Seal synchronously before manager completion yields, so cancellation cannot reopen this slot.
      if (runtime.aborting) await runtime.aborting;
      runtime.sealed = true;
      session.active = undefined;
      try {
        await this.domain.finish(task, runtime.stopStatus ?? runtime.resultStatus!);
        task.notification_pending = task.status !== 'canceled' && task.notify_completion !== false;
        await this.persist();
        this.changed(task);
        if (task.notification_pending) {
          try { Promise.resolve(this.notify?.(this.summary(task))).catch(() => {}); } catch {}
        }
      } catch (error) { this.storageError = error; }
      this.runtimes.delete(task.task_id);
      this.pump();
    }
  }

  async cancel(task: TaskRecord, reason: string, status: 'canceled' | 'failed' = 'canceled'): Promise<TaskSummary> {
    const runtime = this.runtimes.get(task.task_id);
    if (runtime?.sealed || !pending.has(task.status)) {
      await runtime?.done;
      return this.summary(task);
    }
    if (!runtime) {
      this.domain.transition(task, status);
      task.finished_at = new Date().toISOString();
      task.cancel_reason = reason;
      await this.persist();
      this.changed(task);
      return this.summary(task);
    }
    if (!runtime.stopReason) {
      runtime.stopReason = reason || 'Task canceled';
      runtime.stopStatus = status;
      this.domain.transition(task, 'stopping');
      task.cancel_reason = runtime.stopReason;
      if (status === 'failed') task.error = runtime.stopReason;
      runtime.aborting = runtime.ready!.then((child) => child.abort()).catch(() => {});
      await this.persist();
      this.changed(task);
    }
    await runtime.done;
    return this.summary(task);
  }

  async stop(taskId: string, reason = 'Task canceled'): Promise<TaskSummary> {
    this.assertOpen();
    return this.cancel(this.task(taskId), reason);
  }

  async query(): Promise<TaskSummary[]>;
  async query(query: TaskQuery & { task_id: string }): Promise<TaskSummary>;
  async query(query: TaskQuery & { task_id?: undefined }): Promise<TaskSummary[]>;
  async query(query: TaskQuery): Promise<TaskSummary | TaskSummary[]>;
  async query({ task_id, status }: TaskQuery = {}): Promise<TaskSummary | TaskSummary[]> {
    this.assertOpen();
    if (task_id) return this.summary(this.task(task_id));
    return this.getState().tasks.filter((task) => !status || task.status === status).map((task) => this.summary(task));
  }

  async waitUntil(predicate: () => boolean, timeout?: number): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      this.waiters.add(wake);
      if (timeout !== undefined) timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve();
      }, timeout);
      wake();
    });
  }

  async output(taskId: string, { offset, wait_ms = 0, limitBytes = 65536 }: TaskOutputOptions = {}): Promise<TaskOutput> {
    this.assertOpen();
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('Invalid output offset');
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('Invalid output limit');
    const task = this.task(taskId);
    const automatic = offset === undefined;
    const requested = offset ?? task.cursor;
    const before = task.status;
    const length = Buffer.byteLength(task.output);
    if (requested > length) throw new Error('Output offset exceeds available bytes');
    await this.waitUntil(() => Buffer.byteLength(task.output) > requested || task.status !== before || !pending.has(task.status),
      Math.max(0, Math.min(30000, Number(wait_ms) || 0)));
    return this.exclusive(async () => {
      const bytes = Buffer.from(task.output);
      let start = automatic ? task.cursor : requested;
      // Explicit offsets inside a code point advance to its next boundary.
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      const result = await this.domain.readOutput(taskId, { offset: start, limitBytes });
      const end = result.nextOffset ?? start;
      if (automatic) { task.cursor = end; await this.persist(); }
      return { ...this.summary(task), output: result.content,
        offset: start, next_offset: end, has_more: result.truncated ?? false };
    });
  }

  async pendingNotifications(): Promise<TaskSummary[]> {
    this.assertOpen();
    return this.getState().tasks.filter((task) => task.notification_pending).map((task) => this.summary(task));
  }

  async ackNotification(taskId: string): Promise<TaskSummary> {
    return this.exclusive(async () => {
      this.assertOpen();
      const task = this.task(taskId);
      task.notification_pending = false;
      await this.persist();
      return this.summary(task);
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.gate;
      if (!this.state) return;
      await Promise.all(this.getState().tasks.filter((task) => pending.has(task.status))
        .map((task) => this.cancel(task, 'Parent closed')));
      try {
        const results = await Promise.allSettled([...this.sessions.values()].map((session) => session.child?.dispose()));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
      } finally { await this.store.close(); }
    })();
    return this.closing;
  }
}
