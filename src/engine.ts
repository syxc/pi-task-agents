import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { TaskStore } from './store.ts';
import { TaskDomain } from './task-domain.ts';
import { TaskAdmissions } from './engine-admission.ts';
import { TaskOutputReads } from './engine-output.ts';
import { appendTask } from './engine-append.ts';
import { admittedFacts, recordChildFacts, recordChildFailure, resolvedProfile } from './engine-facts.ts';
import { appendTerminalOutput, exceptionOutcome, runnerOutcome, type TaskTerminalOutcome } from './engine-terminal.ts';
import { SessionSafety } from './engine-session-safety.ts';
import { aborted, clone, freeze, normalizeTaskInput, trimmedContent, waitForChange } from './engine-helpers.ts';
import { normalizeTaskError } from './vendor/mcode-background-task/errors.ts';
import { ACTIVE_TASK_STATUSES } from './vendor/mcode-background-task/status.ts';
import type {
  AgentProfile, ChildSession, CreateChild, TaskEngineOptions, TaskInput, TaskOutput,
  TaskOutputOptions, TaskQuery, TaskRecord, TaskRequestOptions, TaskState, TaskStatus, TaskSummary,
} from './types.ts';

interface TaskRuntime {
  accepting: boolean;
  activity?: string;
  backgroundRunner?: boolean;
  shutdownReason?: string;
  sealed?: boolean;
  started?: Promise<ChildSession>;
  ready?: Promise<ChildSession>;
  done?: Promise<void>;
  delivery?: Promise<void>;
  aborting?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  stopReason?: string;
  stopStatus?: 'canceled' | 'failed';
}

interface SessionRuntime {
  child?: ChildSession;
  active?: TaskRecord;
}

const pending = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);

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
  private readonly admission = new TaskAdmissions();
  private readonly safety = new SessionSafety();
  private readonly outputReads: TaskOutputReads;
  private closed = false;
  private closing?: Promise<void>;
  private storageError: unknown;

  constructor({ rootDir, parentId, cwd, maxConcurrency, createChild, notify, onChange }: TaskEngineOptions) {
    if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)) {
      throw new Error('Invalid maxConcurrency');
    }
    this.parentId = parentId;
    this.cwd = resolve(cwd);
    this.store = new TaskStore(rootDir, parentId);
    this.outputReads = new TaskOutputReads(JSON.stringify([this.store.dir, parentId]));
    // Omission adds no cross-session plugin quota; explicit values remain legacy host policy.
    this.maxConcurrency = maxConcurrency ?? Infinity;
    this.createChild = createChild;
    this.notify = notify;
    this.onChange = onChange;
    this.runtimes = new Map();
    this.sessions = new Map();
    this.waiters = new Set();
    this.operations = this.admission.operations;
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
    this.safety.restore(this.getState());
    try { await this.persist(); } catch (error) { await this.store.close(); throw error; }
    return this;
  }

  assertOpen(): void {
    if (!this.state || this.closed) throw new Error('Engine is not open');
    if (this.storageError) throw this.storageError;
  }

  private assertDispatch(): void {
    this.assertOpen();
    this.safety.assertDispatch();
  }

  private getState(): TaskState {
    if (!this.state) throw new Error('Engine is not open');
    return this.state;
  }

  exclusive<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    return this.admission.exclusive(fn);
  }

  persist(): Promise<void> { return this.store.save(this.getState()); }

  changed(task: TaskRecord): void {
    for (const wake of this.waiters) wake();
    try { Promise.resolve(this.onChange?.(this.summary(task))).catch(() => {}); } catch {}
  }

  summary(task: TaskRecord): TaskSummary {
    const { output, cursor, input, profile, legacyVerification, ...result } = task;
    const runtime = this.runtimes.get(task.task_id);
    return { ...clone(result), ...(task.stopError ? { stopError: clone(this.safety.publicStopError(task)) } : {}),
      output_bytes: Buffer.byteLength(output),
      ...(this.safety.retains(task.session_id) || task.stopError && runtime ? { cleanup_pending: true } : {}),
      ...(pending.has(task.status) && runtime?.activity ? { activity: runtime.activity } : {}) };
  }

  task(id: string): TaskRecord {
    const task = this.getState().tasks.find((item) => item.task_id === id);
    if (!task || task.parent_id !== this.parentId) throw new Error('Unknown task for this parent');
    return task;
  }

  request(
    key: string | undefined, fn: (key?: string) => Promise<TaskSummary>,
    duplicate: (result: TaskSummary) => TaskSummary = (result) => result,
  ): Promise<TaskSummary> {
    return this.admission.request(key, fn, (key) => {
      this.assertOpen();
      const id = this.getState().requests[key];
      return id ? this.summary(this.task(id)) : undefined;
    }, duplicate);
  }

  async start(input: TaskInput, profile: AgentProfile, { requestId, signal }: TaskRequestOptions = {}): Promise<TaskSummary> {
    aborted(signal);
    input = normalizeTaskInput(input);
    const result = await this.request(requestId && `start:${requestId}`, async (key) => {
      this.assertOpen();
      aborted(signal);
      const effective = { ...clone(profile) };
      if (input.model) effective.model = input.model;
      if (input.model || input.effort) { effective.effort = input.effort; effective.thinking = undefined; }
      return this.enqueue(input, effective, undefined, key);
    });
    return input.run_in_background === true ? result : this.foreground(result, signal);
  }

  private async foreground(result: TaskSummary, signal?: AbortSignal): Promise<TaskSummary> {
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
      return { ...this.summary(task), mode: result.mode, accepted: result.accepted };
    } finally { signal?.removeEventListener('abort', onAbort); }
  }

  async enqueue(input: TaskInput, profile: AgentProfile, previous?: TaskRecord, key?: string): Promise<TaskSummary> {
    this.assertDispatch();
    if (previous) profile = this.safety.continuation(previous);
    const id = this.domain.createId();
    const sessionId = previous?.session_id ?? randomUUID();
    const task: TaskRecord = {
      task_id: id, session_id: sessionId, parent_id: this.parentId, ...admittedFacts(id, input, profile, previous),
      childSessionPath: previous?.childSessionPath ?? join(this.store.dir, `${sessionId}.jsonl`),
      profile: freeze(clone(profile)), input: clone(input), status: 'queued',
      description: input.description ?? '', agent_name: input.agent_name ?? profile.name,
      created_at: new Date().toISOString(), output: '', cursor: 0, notification_pending: false,
      notify_completion: input.run_in_background === true,
      ...(previous ? { mode: 'activated', accepted: true } as const : {}),
    };
    await this.admission.commit(this.getState(), task, key, () => this.persist(), (error) => { this.storageError = error; });
    this.changed(task);
    const result = this.summary(task);
    this.pump();
    return result;
  }

  append(taskId: string, content: string, options: TaskRequestOptions = {}): Promise<TaskSummary> {
    const poison = (error: unknown) => { this.storageError = error || new Error('Task append persistence failed'); };
    return appendTask({ parentId: this.parentId, runtimes: this.runtimes, state: () => this.getState(),
      assertAdmission: () => this.assertDispatch(),
      request: (key, fn, duplicate) => this.request(key, fn, duplicate),
      storageError: () => this.storageError, pump: () => this.pump(),
      reserve: (task, key) => this.admission.reserveSteering(this.getState(), task, key, () => this.persist(), poison),
      queued: (task, content, key) => this.admission.appendQueued(this.getState(), task, content, key, () => this.persist(), poison),
      enqueue: (task, content, key) => this.enqueue({ ...task.input, prompt: content, run_in_background: true }, task.profile, task, key),
      changed: (task) => this.changed(task), summary: (task) => this.summary(task),
    }, taskId, content, options);
  }

  async send(taskId: string, content: string, options: TaskRequestOptions = {}): Promise<TaskSummary> {
    this.assertOpen();
    aborted(options.signal);
    const target = this.getState().tasks.find((task) => task.task_id === taskId.trim())
      ?? this.getState().tasks.find((task) => task.session_id === taskId.trim());
    const original = this.task(target?.task_id ?? taskId);
    content = trimmedContent(content);
    const result = await this.request(options.requestId && `send:${original.session_id}:${options.requestId}`, async (key) => {
      this.assertDispatch();
      aborted(options.signal);
      const task = this.getState().tasks.filter((item) => item.session_id === original.session_id).at(-1)!;
      // Direct session send is idle-only. It must not join or cancel another caller's Turn.
      if (pending.has(task.status) || this.runtimes.has(task.task_id)) {
        throw Object.assign(new Error('Session already has an active Turn'), { code: 'local_session_busy', status: 409 });
      }
      return this.enqueue({ ...task.input, prompt: content, run_in_background: false }, task.profile, task, key);
    }, (receipt) => ({ ...receipt, mode: 'duplicate', accepted: true }));
    return this.foreground(result, options.signal);
  }

  pump(): void {
    if (this.closed || this.storageError || this.safety.quarantined) return;
    while (this.runtimes.size < this.maxConcurrency) {
      const task = this.getState().tasks.find((item) => item.status === 'queued' && !this.admission.isPending(item.task_id));
      if (!task) break;
      this.domain.transition(task, 'running');
      task.started_at = new Date().toISOString();
      // Later background rows in the same child session use append-completion semantics.
      const runtime: TaskRuntime = { accepting: true,
        backgroundRunner: task.input.run_in_background === true
          && this.getState().tasks.find((item) => item.session_id === task.session_id) === task };
      this.runtimes.set(task.task_id, runtime);
      runtime.done = this.run(task, runtime);
    }
  }

  async run(task: TaskRecord, runtime: TaskRuntime): Promise<void> {
    let outcome!: TaskTerminalOutcome;
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
          onProfileResolved: async (profile: AgentProfile) => {
            if (this.storageError) throw this.storageError;
            resolvedProfile(task, profile);
            try { await this.persist(); }
            catch (error) {
              this.storageError = error || new Error('Profile snapshot persistence failed');
              throw error;
            }
          },
          onOutput: () => { if (session.active) this.changed(session.active); },
          onActivity: (activity) => {
            const active = session.active;
            const current = active && this.runtimes.get(active.task_id);
            if (current && active) { current.activity = activity; this.changed(active); }
          },
        }).catch((error) => {
          if (error?.cleanupChild?.sessionPath === task.childSessionPath) session.child = error.cleanupChild;
          throw error;
        });
      }
      return session.child;
    });
    runtime.ready.catch(() => {});
    try {
      await this.persist();
      this.changed(task);
      const child = await runtime.ready;
      if (this.storageError) throw this.storageError;
      this.safety.assertDispatch();
      if (child.sessionPath && child.sessionPath !== task.childSessionPath) {
        throw new Error('Child session path does not match assigned path');
      }
      if (!runtime.stopReason) {
        if (task.profile.timeoutMs > 0) {
          runtime.timer = setTimeout(() => {
            this.cancel(task, 'Task timed out', 'failed').catch(() => {});
          }, task.profile.timeoutMs);
        }
        const prompting = child.prompt(task.input.prompt, { turnId: task.sub_turn_id });
        startedResolve(child);
        const result = await prompting;
        recordChildFacts(task, result);
        outcome = runnerOutcome(result);
      } else {
        outcome = { status: 'aborted', errorMessage: runtime.stopReason };
      }
    } catch (error) {
      const failure = recordChildFailure(task, error);
      outcome = exceptionOutcome(task.input.run_in_background === true, error, failure.partialResult,
        runtime.backgroundRunner ? runtime.shutdownReason : undefined);
      if (this.safety.record(task, error) && !runtime.stopReason) runtime.stopStatus = 'failed';
      if (!runtime.stopReason && ('failure' in outcome || outcome.status !== 'succeeded')) task.error = failure.message;
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
        const terminal = appendTerminalOutput(task, outcome);
        if (pending.has(task.status) && task.error === undefined && terminal.lastError) task.error = terminal.lastError.message;
        await this.domain.finish(task, runtime.stopStatus ?? terminal.status);
        task.notification_pending = (task.status !== 'canceled' || !runtime.stopReason) && task.notify_completion !== false;
        await this.persist();
        this.changed(task);
        if (task.notification_pending) {
          try { Promise.resolve(this.notify?.(this.summary(task))).catch(() => {}); } catch {}
        }
      } catch (error) { this.storageError = error; this.changed(task); }
      if (!this.safety.retains(task.session_id)) this.runtimes.delete(task.task_id);
      this.pump();
    }
  }

  async cancel(task: TaskRecord, reason: string, status: 'canceled' | 'failed' = 'canceled', shutdown = false): Promise<TaskSummary> {
    const runtime = this.runtimes.get(task.task_id);
    if (runtime && shutdown) runtime.shutdownReason = reason;
    if (runtime?.sealed || !pending.has(task.status)) {
      if (pending.has(task.status)) await runtime?.done;
      return this.summary(task);
    }
    if (!runtime) {
      this.domain.transition(task, status);
      task.finished_at = new Date().toISOString();
      task.cancel_reason = reason;
      const terminal = appendTerminalOutput(task, { status: status === 'canceled' ? 'aborted' : 'failed', errorMessage: reason });
      if (terminal.lastError) task.error = terminal.lastError.message;
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
      runtime.aborting = runtime.ready!.then((child) => child.abort()).catch(async (error) => {
        if (!this.safety.record(task, error)) {
          task.stopError = { code: 'TASK_STOP_FAILED', message: normalizeTaskError(error).message };
          task.error = task.stopError.message;
        }
        runtime.stopStatus = status;
        // Upstream reports a failed explicit stop as canceled + stopError; capacity remains owned independently.
        if (pending.has(task.status)) {
          this.domain.transition(task, status);
          task.finished_at = new Date().toISOString();
          task.notification_pending = status !== 'canceled' && task.notify_completion !== false;
        }
        try { await this.persist(); } catch (failure) { this.storageError = failure; }
        this.changed(task);
      });
      await this.persist();
      this.changed(task);
    }
    await runtime.aborting;
    // A failed abort is observable immediately, but the live child still owns its slot.
    if (!task.stopError) await runtime.done;
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

  waitUntil(predicate: () => boolean, timeout?: number, signal?: AbortSignal): Promise<boolean> {
    return waitForChange(this.waiters, predicate, timeout, signal);
  }

  async output(
    taskId: string, { offset, wait_ms = 0, limitBytes = 65536, signal }: TaskOutputOptions = {},
  ): Promise<TaskOutput> {
    this.assertOpen();
    aborted(signal);
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('Invalid output offset');
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('Invalid output limit');
    const task = this.task(taskId);
    const waitMs = Math.max(0, Math.min(30000, Number(wait_ms) || 0));
    const read = async (requested: number): Promise<TaskOutput> => {
      if (requested > Buffer.byteLength(task.output)) throw new Error('Output offset exceeds available bytes');
      const changed = waitMs === 0 || await this.waitUntil(
        () => Buffer.byteLength(task.output) > requested || !pending.has(task.status), waitMs, signal);
      return this.exclusive(async () => {
        aborted(signal);
        const bytes = Buffer.from(task.output);
        let start = requested;
        // Explicit offsets inside a code point advance to its next boundary.
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
        const result = await this.domain.readOutput(taskId, { offset: start, limitBytes });
        const end = result.nextOffset ?? start;
        const truncated = result.truncated ?? false;
        return { ...this.summary(task), output: result.content, offset: start, next_offset: end,
          has_more: truncated, truncated, ...(waitMs > 0 ? { timed_out: !changed } : {}) };
      });
    };
    return offset === undefined ? this.outputReads.automatic(taskId, signal, read) : read(offset);
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
      await this.admission.settled();
      if (!this.state) return;
      const tasks = this.getState().tasks;
      await Promise.all(tasks.filter((task) => pending.has(task.status)).map((task) => this.cancel(task, 'Parent closed', 'canceled', true)));
      const hadCleanupFailure = this.safety.quarantined;
      const confirmed = await this.safety.dispose(this.sessions, tasks);
      await Promise.all([...this.runtimes].filter(([id]) => confirmed.has(this.task(id).session_id))
        .map(([, runtime]) => runtime.done));
      const recovered = this.safety.confirmDisposed(confirmed, tasks);
      if (hadCleanupFailure || recovered || this.safety.quarantined) {
        try { await this.persist(); } catch (error) { this.storageError = error; throw error; }
      }
      for (const task of tasks) if (task.stopError) this.changed(task);
      this.safety.assertDispatch();
      this.runtimes.clear();
      await this.store.close();
    })().catch((error) => {
      // Keep the lock and readable owner when cleanup remains unproven; close can be retried.
      this.closed = false;
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
