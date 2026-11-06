import { Type } from 'typebox';
import type { ExtensionFactory, ExtensionToolContext, SessionManager } from '@earendil-works/pi-coding-agent';
import { DefaultBackgroundTaskManager } from './vendor/mcode-background-task/manager.ts';
import type { BackgroundTask } from './vendor/mcode-background-task/types.ts';
import { isTerminalTaskStatus } from './vendor/mcode-background-task/status.ts';
import { createChildBashLifecycle, waitForChildBashTaskChange } from './vendor/mcode-child-bash/child-bash-lifecycle.ts';
import { CommandJournal, CommandLogs } from './command-journal.ts';
import { CommandOutput } from './command-output.ts';

interface Run { id: string; signal: AbortSignal; last?: unknown }
interface Execution { run: Run; controller: AbortController; output: CommandOutput; cleanupUnconfirmed?: true; settled?: true;
  admit(): void; reject(error: unknown): void; done: Promise<void> }
interface Receipt { id: string; offset: number; next: number; bytes: number; terminal: boolean; complete: boolean;
  automatic: boolean; text: string; release(): void }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const textOf = (value: unknown): string => Array.isArray(object(value).content)
  ? (object(value).content as unknown[]).filter(part => object(part).type === 'text').map(part => String(object(part).text ?? '')).join('\n') : '';
function reply(value: Record<string, unknown>, isError = false) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text' as const, text }], details: value, structuredContent: JSON.parse(text), ...(isError ? { isError: true } : {}) };
}
const parameters = Type.Object({ action: Type.Union([Type.Literal('start'), Type.Literal('list'), Type.Literal('output'), Type.Literal('stop')]),
  command: Type.Optional(Type.String()), timeout: Type.Optional(Type.Number({ minimum: 1 })),
  command_id: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })), wait_ms: Type.Optional(Type.Integer({ minimum: 0 })),
});
const cleanupError = (cause: unknown): Error => Object.assign(new Error('Owned command cleanup is unconfirmed', { cause }), { code: 'CHILD_CLEANUP_FAILED' });
async function cleanupDeadline(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(cleanupError('deadline')), 5000); })]); }
  finally { clearTimeout(timer); }
}

/** MCode owns lifecycle/state; native executeTool owns execution, validation, hooks and permissions. */
export async function createChildCommands(options: {
  manager: SessionManager; sessionPath: string; current(): Run | undefined; isNativeBash(): boolean;
  onStarted?(turnId: string): Promise<void>;
}) {
  const journal = new CommandJournal(options.manager);
  await journal.restore();
  const logs = new CommandLogs(options.sessionPath), running = new Map<string, Execution>();
  const receipts = new Map<string, Receipt>(), cursors = new Map<string, number>(), readEnd = new Map<string, number>();
  const readTails = new Map<string, Promise<unknown>>();
  let group: { id: string; read: Set<string>; steering?: AbortController; steeredAfter?: unknown; lifecycle: ReturnType<typeof createChildBashLifecycle> } | undefined;
  let closed = false;
  const tasks = new DefaultBackgroundTaskManager({ store: journal, outputStore: {
    append: async () => { throw new Error('Native output owns the byte stream'); },
    read: async (id, input = {}) => { const value = logs.read(id, input.offset ?? 0, input.limitBytes);
      return { content: value.output, nextOffset: value.next_offset, truncated: value.truncated }; },
    tail: async id => { const size = logs.read(id, 0, 0).output_bytes, value = logs.read(id, Math.max(0, size - 8192));
      return { content: value.output, nextOffset: value.next_offset, truncated: value.truncated }; },
    finalize: async () => {},
  } });
  async function ready(): Promise<void> {
    journal.assertWritable();
    if ([...running.values()].some(execution => execution.cleanupUnconfirmed)) throw cleanupError('Previous stop has not confirmed cleanup');
    if ((await tasks.list({ ownerSessionId: journal.owner, limit: 1, statuses: ['lost'] })).items.length) throw cleanupError('Previous command owner exited; no process is replayed or assumed stopped');
  }
  async function owned(id: string, control = false): Promise<BackgroundTask> {
    const task = await tasks.get(id);
    if (!task || task.ownerSessionId !== journal.owner || task.kind !== 'bash') throw new Error('Owned command not found');
    if (control && (!isTerminalTaskStatus(task.status) || running.has(id)) && task.metadata?.parentTurnId !== options.current()?.id) throw new Error('Command belongs to another child turn');
    return task;
  }
  async function stopExecution(id: string): Promise<void> {
    const execution = running.get(id);
    if (!execution) return;
    execution.controller.abort(new Error('Owned command stopped'));
    execution.reject(new Error('Owned command admission canceled'));
    try { await cleanupDeadline(execution.done); }
    catch (error) {
      if (execution.settled) {
        await execution.output.close();
        running.delete(id); journal.notify(id);
        return;
      }
      execution.cleanupUnconfirmed = true; throw error;
    }
  }
  const service = {
    list: (query: Parameters<typeof tasks.list>[0]) => tasks.list({ ...query, ownerSessionId: journal.owner, kinds: ['bash'] }),
    async stop(id: string, reason?: string) {
      const task = await owned(id, true);
      if (isTerminalTaskStatus(task.status) && running.has(id)) await stopExecution(id);
      try { return await tasks.stop(id, reason); }
      catch (error) { await stopExecution(id); throw error; }
    },
    waitForTaskChange: (ownerSessionId: string, taskIds: readonly string[], signal: AbortSignal) =>
      waitForChildBashTaskChange(journal.waiters, { ownerSessionId, taskIds, signal }, id => tasks.get(id)),
  };
  function current() {
    const run = options.current();
    if (!run || run.signal.aborted || closed) throw new Error('Owned command requires an active child turn');
    if (!group || group.id !== run.id) group = { id: run.id, read: new Set(),
      lifecycle: createChildBashLifecycle(service, { sessionId: journal.owner, turnId: run.id, signal: run.signal }) };
    return { run, group };
  }
  tasks.registerRunner<{ command: string; timeout?: number; ctx: ExtensionToolContext; run: Run; created(id: string): void }>({
    kind: 'bash',
    async start(task, input) {
      const controller = new AbortController(), output = await CommandOutput.create(logs, task.taskId, () => journal.notify(task.taskId));
      let admit!: () => void, reject!: (error: unknown) => void;
      const admission = new Promise<void>((resolve, fail) => { admit = resolve; reject = fail; });
      const onAbort = () => controller.abort(input.run.signal.reason);
      input.run.signal.addEventListener('abort', onAbort, { once: true });
      const execution: Execution = { run: input.run, controller, output, admit, reject, done: Promise.resolve() };
      running.set(task.taskId, execution); input.created(task.taskId);
      execution.done = (async () => {
        let result: unknown, error: unknown, failed = false;
        try {
          await admission;
          if (input.run.signal.aborted) controller.abort(input.run.signal.reason);
          const outcome = await input.ctx.executeTool('bash', { command: input.command, ...(input.timeout === undefined ? {} : { timeout: input.timeout }) },
            { signal: controller.signal, onUpdate: value => output.update(value) });
          result = outcome.result; failed = outcome.isError;
        } catch (failure) { error = failure; failed = true; }
        finally {
          input.run.signal.removeEventListener('abort', onAbort);
          try { await output.finish(result); } catch (failure) { output.incomplete = true; error ??= failure; }
        }
        const structured = object(object(result).structuredContent);
        const faults: unknown[] = [];
        try {
          if (controller.signal.aborted) await tasks.complete(task.taskId, { status: 'canceled' });
          else if (failed) await tasks.fail(task.taskId, new Error(textOf(result) || String(error ?? 'Native Bash failed')));
          else await tasks.complete(task.taskId);
        } catch (failure) { faults.push(failure); }
        try { await journal.patch(task.taskId, { metadata: {
          ...(typeof structured.exit_code === 'number' ? { exitCode: structured.exit_code } : {}), outputIncomplete: output.incomplete,
        } }); } catch (failure) { faults.push(failure); }
        if (!output.hasOpenResources) running.delete(task.taskId);
        else { execution.cleanupUnconfirmed = true; faults.push(cleanupError('Command output resources remain owned')); }
        journal.notify(task.taskId);
        if (faults.length) throw new AggregateError(faults, 'Command journal commit failed');
      })();
      execution.done.then(() => { execution.settled = true; }, () => { execution.settled = true; });
      return { taskId: task.taskId, abortController: controller };
    }, stop: stopExecution,
  });
  async function start(input: { command?: string; timeout?: number }, ctx: ExtensionToolContext, toolCallId: string) {
    const { run } = current();
    await ready();
    if (!options.isNativeBash()) throw new Error('Managed commands require the native Pi Bash tool, not a configured replacement');
    if (typeof input.command !== 'string') throw new Error('command is required');
    let created: string | undefined;
    try {
      const task = await tasks.start({ kind: 'bash', ownerSessionId: journal.owner, toolCallId,
        description: 'Owned background Bash', metadata: { parentTurnId: run.id },
        input: { command: input.command, timeout: input.timeout, ctx, run, created: (id: string) => { created = id; } } });
      if (task.status !== 'running') throw new Error(task.lastError?.message ?? 'Command admission failed');
      await options.onStarted?.(run.id);
      running.get(task.taskId)!.admit();
      return reply({ command_id: task.taskId, status: task.status });
    } catch (error) {
      const execution = created ? running.get(created) : undefined;
      execution?.reject(error); await execution?.done.catch(() => {});
      throw error;
    }
  }
  async function output(toolCallId: string, input: { command_id: string; offset?: number; wait_ms?: number }, signal?: AbortSignal) {
    const automatic = input.offset === undefined;
    let release!: () => void;
    const committed = new Promise<void>(resolve => { release = resolve; });
    const read = async () => {
      if (signal?.aborted) throw signal.reason ?? new Error('Output read aborted');
      const offset = input.offset ?? cursors.get(input.command_id) ?? 0, wait = Math.min(input.wait_ms ?? 0, 30000), deadline = Date.now() + wait;
      let task = await owned(input.command_id, true);
      const bytes = () => running.get(task.taskId)?.output.read(offset) ?? logs.read(task.taskId, offset);
      let value = bytes();
      while (value.next_offset <= offset && !isTerminalTaskStatus(task.status) && Date.now() < deadline && !signal?.aborted) {
        const waiter = journal.waiters.create(task.taskId, signal);
        try {
          task = await owned(task.taskId, true); value = bytes();
          if (value.next_offset > offset || isTerminalTaskStatus(task.status)) break;
          await waiter.wait(Math.max(0, deadline - Date.now()));
        } finally { waiter.cancel(); }
        task = await owned(task.taskId, true); value = bytes();
      }
      if (signal?.aborted) throw signal.reason ?? new Error('Output read aborted');
      const cleanupPending = task.status === 'lost' || isTerminalTaskStatus(task.status) && running.has(task.taskId);
      const incomplete = !!task.metadata?.outputIncomplete || cleanupPending
        || isTerminalTaskStatus(task.status) && value.truncated && value.next_offset <= offset;
      const result = reply({ command_id: task.taskId, status: task.status, ...value,
        ...(cleanupPending ? { cleanup_pending: true } : {}),
        ...(task.metadata?.exitCode === undefined ? {} : { exit_code: task.metadata.exitCode }),
        ...(incomplete ? { output_incomplete: true } : {}), ...(task.lastError ? { error: task.lastError } : {}),
        effective_wait_ms: wait, wait_ms_clamped: (input.wait_ms ?? 0) > wait });
      receipts.set(toolCallId, { id: task.taskId, offset, next: value.next_offset, bytes: value.output_bytes,
        terminal: isTerminalTaskStatus(task.status) && !cleanupPending, complete: !value.truncated && !incomplete,
        automatic, text: JSON.stringify(result.content), release });
      return result;
    };
    const operation = automatic ? (readTails.get(input.command_id) ?? Promise.resolve()).then(read) : read();
    if (automatic) readTails.set(input.command_id, operation.then(() => committed, () => {}));
    return operation;
  }
  const extension: ExtensionFactory = pi => {
    pi.on('tool_call', event => {
      let quarantined = [...running.values()].some(execution => execution.cleanupUnconfirmed);
      try { journal.assertWritable(); } catch { quarantined = true; }
      if (quarantined && !(event.toolName === 'bash_task' && ['list', 'output', 'stop'].includes(String(object(event.input).action)))) {
        return { block: true, reason: 'Owned command cleanup is unconfirmed; only command inspection or stop retry is allowed' };
      }
    });
    pi.registerTool({ name: 'bash_task', label: 'Owned Bash commands',
      description: 'Start, list, read incremental output from, or stop this child turn\'s native background Bash commands. Foreground bash is unchanged. Use command_id, never Agent task IDs. Output offsets are UTF-8 bytes; omit offset for a committed cursor. wait_ms is capped at 30000.',
      parameters, outputSchema: Type.Object({}, { additionalProperties: true }),
      async execute(id, input, signal, _update, ctx) {
        current();
        if (input.action === 'start') return start(input, ctx, id);
        if (input.action === 'list') {
          const rows = input.command_id ? { items: [await owned(input.command_id, true)] } : await service.list({ cursor: input.cursor, limit: 100 });
          return reply({ commands: rows.items.filter(task => isTerminalTaskStatus(task.status) && !running.has(task.taskId) || task.metadata?.parentTurnId === options.current()?.id)
            .map(task => ({ command_id: task.taskId, status: task.status, turn_id: task.metadata?.parentTurnId,
            ...(task.status === 'lost' || isTerminalTaskStatus(task.status) && running.has(task.taskId) ? { cleanup_pending: true } : {}),
            ...(task.lastError ? { error_code: task.lastError.code } : {}) })), ...('nextCursor' in rows && rows.nextCursor ? { next_cursor: rows.nextCursor } : {}) });
        }
        if (!input.command_id) throw new Error('command_id is required');
        if (input.action === 'output') return output(id, { ...input, command_id: input.command_id }, signal);
        const task = await service.stop(input.command_id, 'Stopped by owning child');
        return reply({ command_id: task.taskId, status: task.status,
          ...(task.status === 'lost' || isTerminalTaskStatus(task.status) && running.has(task.taskId) ? { cleanup_pending: true } : {}),
          ...(task.lastError ? { error: task.lastError } : {}) }, task.lastError?.code === 'TASK_STOP_FAILED');
      },
    });
    pi.on('tool_result', event => {
      const receipt = receipts.get(event.toolCallId);
      if (!receipt) return;
      receipts.delete(event.toolCallId);
      if (!event.isError && JSON.stringify(event.content) === receipt.text) {
        if (receipt.automatic) cursors.set(receipt.id, receipt.next);
        const previous = readEnd.get(receipt.id) ?? 0;
        if (receipt.offset <= previous) readEnd.set(receipt.id, Math.max(previous, receipt.next));
        if (receipt.terminal && receipt.complete && (readEnd.get(receipt.id) ?? 0) >= receipt.bytes) group?.read.add(receipt.id);
      }
      receipt.release();
    });
    pi.on('agent_before_settle', async event => {
      const run = options.current();
      if (!run || run.signal.aborted || group?.id !== run.id) return;
      await ready();
      const steering = new AbortController(); group.steering = steering;
      if (group.steeredAfter !== undefined && group.steeredAfter === run.last) steering.abort(new Error('Child received steering'));
      delete group.steeredAfter;
      const notice = await group.lifecycle.poll({ wait: true, readTaskIds: group.read, steeringSignal: steering.signal });
      if (run.signal.aborted) return;
      if (!notice && !steering.signal.aborted) return;
      const last = options.manager.getBranch().findLast(entry => entry.type === 'message' && entry.message === run.last);
      return { entries: [...event.entries, ...(last ? [{ type: 'context_edit' as const, targetId: last.id, replacement: null }] : []),
        ...(notice ? [{ type: 'custom_message' as const, customType: 'pi-task-agents:commands-finished', content: notice, display: false }] : [])], continue: true };
    });
  };
  async function abort(): Promise<void> {
    for (const receipt of receipts.values()) receipt.release();
    receipts.clear();
    const results = await Promise.allSettled([...running.keys()].map(stopExecution));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    try { await journal.flush(); await ready(); } catch (error) { failures.push(error); }
    if (failures.length) throw cleanupError(new AggregateError(failures));
  }
  return { extension, ready, abort,
    async abortWith(abortSession: () => Promise<void>) {
      const [session, commands] = await Promise.allSettled([abortSession(), abort()]);
      if (commands.status === 'rejected') throw cleanupError(commands.reason);
      if (session.status === 'rejected') throw session.reason;
    },
    steered() {
      if (!group) return;
      group.steeredAfter = options.current()?.last;
      group.steering?.abort(new Error('Child received steering'));
    },
    async finish(turnId: string, cancel: boolean) {
      if (cancel) await abort();
      else { await Promise.all([...running.values()].filter(execution => execution.run.id === turnId).map(execution => execution.done)); await journal.flush(); await ready(); }
    },
    async close() { closed = true; await abort(); },
  };
}
