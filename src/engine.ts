import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { TaskStore } from './store.ts'
import { resolveMaxConcurrency } from './concurrency.ts'
import { TaskDomain } from './task-domain.ts'
import { TaskAdmissions } from './engine-admission.ts'
import { TaskOutputReads } from './engine-output.ts'
import { appendTask } from './engine-append.ts'
import {
  admittedFacts,
  recordChildFacts,
  recordChildFailure,
  resolvedProfile
} from './engine-facts.ts'
import {
  appendTerminalOutput,
  exceptionOutcome,
  runnerOutcome,
  type TaskTerminalOutcome
} from './engine-terminal.ts'
import { SessionSafety } from './engine-session-safety.ts'
import {
  captureTaskExecutionContext,
  runWithoutTaskExecutionContext
} from './task-execution-context.ts'
import {
  aborted,
  clone,
  freeze,
  normalizeTaskInput,
  trimmedContent,
  waitForChange
} from './engine-helpers.ts'
import { normalizeTaskError } from './vendor/mcode-background-task/errors.ts'
import { ACTIVE_TASK_STATUSES } from './vendor/mcode-background-task/status.ts'
import type {
  AgentProfile,
  ChildSession,
  CreateChild,
  TaskEngineOptions,
  TaskInput,
  TaskOutput,
  TaskOutputOptions,
  TaskQuery,
  TaskRecord,
  TaskRequestOptions,
  TaskState,
  TaskStatus,
  TaskSummary
} from './types.ts'

interface TaskRuntime {
  accepting: boolean
  controller: AbortController
  initializing: boolean
  initializationCanceled?: boolean
  initializationCleanupPending?: boolean
  stoppingWrite?: Promise<void>
  stopWait?: Promise<void>
  stopReport?: Promise<void>
  settled?: boolean
  activity?: string
  backgroundRunner?: boolean
  shutdownReason?: string
  sealed?: boolean
  started?: Promise<ChildSession>
  rejectStarted?: (error: Error) => void
  ready?: Promise<ChildSession>
  done?: Promise<void>
  delivery?: Promise<void>
  aborting?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  stopReason?: string
  stopStatus?: 'canceled' | 'failed'
}

interface SessionRuntime {
  child?: ChildSession
  active?: TaskRecord
}

const pending = new Set<TaskStatus>(ACTIVE_TASK_STATUSES)
// Bound the caller's initialization-stop wait, never the lifetime of its cleanup owner.
const initializationStopWaitMs = 1000
// Allow the initialization-specific report to finish before the whole-owner close deadline.
const closeReportWaitMs = initializationStopWaitMs * 2 + 100

export class TaskEngine {
  readonly parentId: string
  readonly cwd: string
  readonly store: TaskStore
  readonly maxConcurrency: number
  createChild: CreateChild
  readonly notify: TaskEngineOptions['notify']
  readonly onChange: TaskEngineOptions['onChange']
  readonly runtimes: Map<string, TaskRuntime>
  readonly sessions: Map<string, SessionRuntime>
  readonly waiters: Set<() => void>
  readonly operations: Map<string, Promise<TaskSummary>>
  state?: TaskState
  private readonly domain: TaskDomain
  private readonly admission = new TaskAdmissions()
  private readonly safety = new SessionSafety()
  private readonly executionContexts = new Map<
    string,
    ReturnType<typeof captureTaskExecutionContext>
  >()
  private readonly outputReads: TaskOutputReads
  private closed = false
  private closing?: Promise<void>
  private closingError: unknown
  private disposing?: Promise<Set<string>>
  private storageError: unknown
  private readonly uncommittedTerminals = new Set<string>()

  constructor({
    rootDir,
    parentId,
    cwd,
    maxConcurrency,
    createChild,
    notify,
    onChange
  }: TaskEngineOptions) {
    this.maxConcurrency = resolveMaxConcurrency(maxConcurrency)
    this.parentId = parentId
    this.cwd = resolve(cwd)
    this.store = new TaskStore(rootDir, parentId)
    this.outputReads = new TaskOutputReads(JSON.stringify([this.store.dir, parentId]))
    this.createChild = createChild
    this.notify = notify
    this.onChange = onChange
    this.runtimes = new Map()
    this.sessions = new Map()
    this.waiters = new Set()
    this.operations = this.admission.operations
    this.domain = new TaskDomain(() => this.getState())
  }

  async init(): Promise<this> {
    if (this.state || this.closed) {
      throw new Error('Engine already initialized or closed')
    }
    this.state = await this.store.init()
    for (const task of this.getState().tasks) {
      if (task.parent_id !== this.parentId) {
        // oxlint-disable-next-line no-await-in-loop -- Close the store before rejecting the first mismatched owner.
        await this.store.close()
        this.state = undefined
        throw new Error('Task owner mismatch')
      }
      if (pending.has(task.status)) {
        this.domain.transition(task, 'lost')
        task.error = 'Previous task owner exited'
        task.finished_at = new Date().toISOString()
        task.notification_pending = task.notify_completion !== false
      }
    }
    this.safety.restore(this.getState())
    for (const task of this.getState().tasks) {
      if (task.ownedCommandCleanupPending) {
        this.safety.record(
          task,
          new Error('Managed command cleanup was not confirmed before the previous owner exited'),
          true
        )
      }
    }
    try {
      await this.persist()
    } catch (error) {
      await this.store.close()
      throw error
    }
    return this
  }

  assertOpen(): void {
    if (!this.state || this.closed) {
      throw new Error('Engine is not open')
    }
    if (this.storageError) {
      throw this.storageError
    }
  }

  private latchStorageError(error: unknown): void {
    // In-flight writes can settle after poisoning; the first observed failure remains the owner error.
    this.storageError ??= error || new Error('Task persistence failed', { cause: error })
  }

  private assertDispatch(): void {
    this.assertOpen()
    this.safety.assertDispatch()
  }

  private getState(): TaskState {
    if (!this.state) {
      throw new Error('Engine is not open')
    }
    return this.state
  }

  exclusive<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    return this.admission.exclusive(fn)
  }

  async persist(): Promise<void> {
    try {
      await this.store.save(this.getState())
    } catch (error) {
      // A falsy rejection must not bypass the owner's storage-error latch.
      throw error || new Error('Task persistence failed', { cause: error })
    }
  }

  changed(task: TaskRecord): void {
    for (const wake of this.waiters) {
      wake()
    }
    try {
      Promise.resolve(this.onChange?.(this.summary(task))).catch(() => {})
    } catch {}
  }

  summary(task: TaskRecord): TaskSummary {
    const {
      output,
      cursor: _cursor,
      input: _input,
      profile: _profile,
      legacyVerification: _legacyVerification,
      ownedCommandCleanupPending: _ownedCommandCleanupPending,
      ...result
    } = task
    const runtime = this.runtimes.get(task.task_id)
    return {
      ...clone(result),
      ...(task.stopError ? { stopError: clone(this.safety.publicStopError(task)) } : {}),
      output_bytes: Buffer.byteLength(output),
      ...(this.safety.retains(task.session_id) || (task.stopError && runtime)
        ? { cleanup_pending: true }
        : {}),
      ...(pending.has(task.status) && runtime?.activity ? { activity: runtime.activity } : {})
    }
  }

  task(id: string): TaskRecord {
    const task = this.getState().tasks.find((item) => item.task_id === id)
    if (!task || task.parent_id !== this.parentId) {
      throw new Error('Unknown task for this parent')
    }
    return task
  }

  request(
    key: string | undefined,
    fn: (key?: string) => Promise<TaskSummary>,
    duplicate: (result: TaskSummary) => TaskSummary = (result) => result
  ): Promise<TaskSummary> {
    return this.admission.request(
      key,
      fn,
      (requestKey) => {
        this.assertOpen()
        const id = this.getState().requests[requestKey]
        return id ? this.summary(this.task(id)) : undefined
      },
      duplicate
    )
  }

  async start(
    input: TaskInput,
    profile: AgentProfile,
    { requestId, signal, nestedToolCall }: TaskRequestOptions = {}
  ): Promise<TaskSummary> {
    aborted(signal)
    input = normalizeTaskInput(input)
    const result = await this.request(requestId && `start:${requestId}`, async (key) => {
      this.assertOpen()
      aborted(signal)
      const effective = { ...clone(profile) }
      if (input.model) {
        effective.model = input.model
      }
      if (input.model || input.effort) {
        effective.effort = input.effort
        effective.thinking = undefined
      }
      return this.enqueue(input, effective, undefined, key, nestedToolCall)
    })
    return input.run_in_background === true ? result : this.foreground(result, signal)
  }

  private async foreground(result: TaskSummary, signal?: AbortSignal): Promise<TaskSummary> {
    const task = this.task(result.task_id)
    let cancellation: Promise<TaskSummary> | undefined
    let rejectCancellation!: (error: unknown) => void
    const cancellationFailed = new Promise<never>((_, reject) => {
      rejectCancellation = reject
    })
    const waiting = new AbortController()
    const onAbort = () => {
      cancellation ??= this.cancel(task, 'Foreground request aborted')
      cancellation.catch(rejectCancellation)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
    try {
      const completed = (async () => {
        await this.waitUntil(() => !pending.has(task.status), undefined, waiting.signal)
        const runtime = this.runtimes.get(task.task_id)
        if (runtime?.initializationCanceled && runtime.stopReport) {
          await runtime.stopReport
        } else if (!runtime?.initializationCleanupPending) {
          await runtime?.done
        }
        await cancellation
        // Keep execution facts intact, but do not acknowledge an unconfirmed terminal snapshot.
        if (this.uncommittedTerminals.has(task.task_id)) {
          throw this.storageError
        }
        return { ...this.summary(task), mode: result.mode, accepted: result.accepted }
      })()
      return await Promise.race([completed, cancellationFailed])
    } finally {
      waiting.abort()
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async enqueue(
    input: TaskInput,
    profile: AgentProfile,
    previous?: TaskRecord,
    key?: string,
    nestedToolCall = false
  ): Promise<TaskSummary> {
    const execute = captureTaskExecutionContext()
    this.assertDispatch()
    // The serialized request has already checked durable/in-flight receipts. Count
    // queued predecessors too: their existing claim can consume an apparently free slot.
    if (
      nestedToolCall &&
      input.run_in_background !== true &&
      this.runtimes.size +
        this.getState().tasks.filter((task) => task.status === 'queued').length >=
        this.maxConcurrency
    ) {
      throw Object.assign(
        new Error(
          'TASK_FOREGROUND_BUSY: Nested or unverified-origin foreground work was not admitted; owner capacity is full. ' +
            'Waiting here can deadlock the SDK tool queue. The SDK does not expose its scheduling mode, ' +
            'so this conservative guard also rejects parallel nested foreground calls. ' +
            'Retry after a task completes or stop cleanup is confirmed; use task with ' +
            'run_in_background:true, or task_append for asynchronous continuation.'
        ),
        { code: 'TASK_FOREGROUND_BUSY', status: 409, retryable: true }
      )
    }
    if (previous) {
      profile = this.safety.continuation(previous)
    }
    const id = this.domain.createId()
    const sessionId = previous?.session_id ?? randomUUID()
    const task: TaskRecord = {
      task_id: id,
      session_id: sessionId,
      parent_id: this.parentId,
      ...admittedFacts(id, input, profile, previous),
      ...(previous ? { parent_task_id: previous.task_id } : {}),
      execution_mode:
        input.run_in_background === true ? (previous ? 'append' : 'background') : 'foreground',
      childSessionPath: previous?.childSessionPath ?? join(this.store.dir, `${sessionId}.jsonl`),
      profile: freeze(clone(profile)),
      input: clone(input),
      status: 'queued',
      description: input.description ?? '',
      agent_name: input.agent_name ?? profile.name,
      created_at: new Date().toISOString(),
      output: '',
      cursor: 0,
      notification_pending: false,
      notify_completion: input.run_in_background === true,
      ...(previous ? ({ mode: 'activated', accepted: true } as const) : {})
    }
    // commit releases its pending reservation before this await resumes, so
    // another pump must already be able to find the task's own binding.
    this.executionContexts.set(id, execute)
    try {
      await this.admission.commit(
        this.getState(),
        task,
        key,
        () => this.persist(),
        (error) => this.latchStorageError(error)
      )
    } catch (error) {
      this.executionContexts.delete(id)
      throw error
    }
    this.changed(task)
    const result = this.summary(task)
    this.pump()
    return result
  }

  append(taskId: string, content: string, options: TaskRequestOptions = {}): Promise<TaskSummary> {
    const poison = (error: unknown) => {
      this.latchStorageError(error)
    }
    return appendTask(
      {
        parentId: this.parentId,
        runtimes: this.runtimes,
        state: () => this.getState(),
        assertAdmission: () => this.assertDispatch(),
        request: (key, fn, duplicate) => this.request(key, fn, duplicate),
        storageError: () => this.storageError,
        pump: () => this.pump(),
        reserve: (task, key) =>
          this.admission.reserveSteering(this.getState(), task, key, () => this.persist(), poison),
        queued: (task, appendedContent, key) =>
          this.admission.appendQueued(
            this.getState(),
            task,
            appendedContent,
            key,
            () => this.persist(),
            poison
          ),
        enqueue: (task, appendedContent, key) =>
          this.enqueue(
            { ...task.input, prompt: appendedContent, run_in_background: true },
            task.profile,
            task,
            key
          ),
        changed: (task) => this.changed(task),
        summary: (task) => this.summary(task)
      },
      taskId,
      content,
      options
    )
  }

  async send(
    taskId: string,
    content: string,
    options: TaskRequestOptions = {}
  ): Promise<TaskSummary> {
    this.assertOpen()
    aborted(options.signal)
    const target =
      this.getState().tasks.find((task) => task.task_id === taskId.trim()) ??
      this.getState().tasks.find((task) => task.session_id === taskId.trim())
    const original = this.task(target?.task_id ?? taskId)
    content = trimmedContent(content)
    const result = await this.request(
      options.requestId && `send:${original.session_id}:${options.requestId}`,
      async (key) => {
        this.assertDispatch()
        aborted(options.signal)
        const task = this.getState().tasks.findLast(
          (item) => item.session_id === original.session_id
        )!
        // Direct session send is idle-only. It must not join or cancel another caller's Turn.
        if (pending.has(task.status) || this.runtimes.has(task.task_id)) {
          throw Object.assign(new Error('Session already has an active Turn'), {
            code: 'local_session_busy',
            status: 409
          })
        }
        return this.enqueue(
          { ...task.input, prompt: content, run_in_background: false },
          task.profile,
          task,
          key,
          options.nestedToolCall
        )
      },
      (receipt) => ({ ...receipt, mode: 'duplicate', accepted: true })
    )
    return this.foreground(result, options.signal)
  }

  pump(): void {
    if (this.closed || this.storageError || this.safety.quarantined) {
      return
    }
    while (this.runtimes.size < this.maxConcurrency) {
      const task = this.getState().tasks.find(
        (item) => item.status === 'queued' && !this.admission.isPending(item.task_id)
      )
      if (!task) {
        break
      }
      this.domain.transition(task, 'running')
      task.started_at = new Date().toISOString()
      // Later background rows in the same child session use append-completion semantics.
      const runtime: TaskRuntime = {
        accepting: true,
        controller: new AbortController(),
        initializing: true,
        backgroundRunner:
          task.input.run_in_background === true &&
          this.getState().tasks.find((item) => item.session_id === task.session_id) === task
      }
      this.runtimes.set(task.task_id, runtime)
      const execute = this.executionContexts.get(task.task_id) ?? runWithoutTaskExecutionContext
      this.executionContexts.delete(task.task_id)
      runtime.done = execute(() => this.run(task, runtime)).finally(() => {
        runtime.settled = true
      })
    }
  }

  async run(task: TaskRecord, runtime: TaskRuntime): Promise<void> {
    let outcome!: TaskTerminalOutcome
    let startedResolve!: (child: ChildSession) => void
    let startedReject!: (error: Error) => void
    runtime.started = new Promise<ChildSession>((resolveStarted, reject) => {
      startedResolve = resolveStarted
      startedReject = reject
    })
    runtime.rejectStarted = startedReject
    runtime.started.catch(() => {})
    let session = this.sessions.get(task.session_id)
    if (!session) {
      session = {}
      this.sessions.set(task.session_id, session)
    }
    session.active = task
    runtime.ready = Promise.resolve()
      .then(async () => {
        // Initialization must not outlive a failed running-row write and its owner cleanup.
        try {
          await this.persist()
        } catch (error) {
          this.latchStorageError(error)
          throw error
        }
        this.changed(task)
        aborted(runtime.controller.signal)
        if (!session.child) {
          session.child = await this.createChild({
            signal: runtime.controller.signal,
            profile: freeze(clone(task.profile)),
            cwd: this.cwd,
            sessionPath: task.childSessionPath,
            onProfileResolved: async (profile: AgentProfile) => {
              aborted(runtime.controller.signal)
              if (this.storageError) {
                throw this.storageError
              }
              resolvedProfile(task, profile)
              try {
                await this.persist()
              } catch (error) {
                this.latchStorageError(error)
                throw error
              }
              aborted(runtime.controller.signal)
            },
            onOwnedCommandStarted: async () => {
              const active = session.active,
                owner = active && this.runtimes.get(active.task_id)
              if (this.closed || !active || !owner?.accepting || owner.stopReason || owner.sealed) {
                throw new Error('Command owner is not accepting work')
              }
              this.assertDispatch()
              active.ownedCommandCleanupPending = true
              try {
                await this.persist()
              } catch (error) {
                this.latchStorageError(error)
                throw error
              }
            },
            onOutput: () => {
              if (session.active) {
                this.changed(session.active)
              }
            },
            onActivity: (activity) => {
              const active = session.active
              const current = active && this.runtimes.get(active.task_id)
              if (current && active) {
                current.activity = activity
                this.changed(active)
              }
            }
          }).catch((error) => {
            if (error?.cleanupChild?.sessionPath === task.childSessionPath) {
              session.child = error.cleanupChild
            }
            throw error
          })
        }
        return session.child
      })
      .finally(() => {
        runtime.initializing = false
      })
    runtime.ready.catch(() => {})
    if (task.profile.timeoutMs > 0) {
      runtime.timer = setTimeout(() => {
        this.cancel(task, 'Task timed out', 'failed').catch(() => {})
      }, task.profile.timeoutMs)
    }
    try {
      const child = await runtime.ready
      if (this.storageError) {
        throw this.storageError
      }
      if (!runtime.stopReason && !this.closed) {
        this.safety.assertDispatch()
      }
      if (child.sessionPath && child.sessionPath !== task.childSessionPath) {
        throw new Error('Child session path does not match assigned path')
      }
      if (!runtime.stopReason && !this.closed) {
        const prompting = child.prompt(task.input.prompt, { turnId: task.sub_turn_id })
        startedResolve(child)
        const result = await prompting
        if (result.commandCleanupConfirmed === true) {
          delete task.ownedCommandCleanupPending
        }
        recordChildFacts(task, result)
        outcome = runnerOutcome(result)
      } else {
        runtime.stopReason ??= 'Parent closed'
        task.cancel_reason ??= runtime.stopReason
        outcome = { status: 'aborted', errorMessage: runtime.stopReason }
      }
    } catch (error) {
      const failure = recordChildFailure(task, error)
      if (
        failure.partialResult &&
        typeof failure.partialResult === 'object' &&
        'commandCleanupConfirmed' in failure.partialResult &&
        failure.partialResult.commandCleanupConfirmed === true
      ) {
        delete task.ownedCommandCleanupPending
      }
      outcome = exceptionOutcome(
        task.input.run_in_background === true,
        error,
        failure.partialResult,
        runtime.backgroundRunner ? runtime.shutdownReason : undefined
      )
      if (this.safety.record(task, error) && !runtime.stopReason) {
        runtime.stopStatus = 'failed'
      }
      if (!runtime.stopReason && ('failure' in outcome || outcome.status !== 'succeeded')) {
        task.error = failure.message
      }
    } finally {
      runtime.accepting = false
      startedReject(new Error('Task ended before prompt dispatch'))
      clearTimeout(runtime.timer)
      if (runtime.delivery) {
        await runtime.delivery
      }
      // Seal synchronously before manager completion yields, so cancellation cannot reopen this slot.
      if (runtime.aborting) {
        await runtime.aborting
      }
      if (runtime.initializationCanceled) {
        // Reporting can time out, but the original run still owns every in-flight stop write.
        await runtime.stopWait?.catch(() => {})
      }
      if (task.ownedCommandCleanupPending) {
        this.safety.record(task, new Error('Managed command cleanup is unconfirmed'), true)
        runtime.stopStatus ??= 'failed'
      }
      runtime.sealed = true
      session.active = undefined
      try {
        const terminal = appendTerminalOutput(task, outcome)
        if (pending.has(task.status) && task.error === undefined && terminal.lastError) {
          task.error = terminal.lastError.message
        }
        await this.domain.finish(task, runtime.stopStatus ?? terminal.status)
        task.notification_pending =
          (task.status !== 'canceled' || !runtime.stopReason) && task.notify_completion !== false
        this.uncommittedTerminals.add(task.task_id)
        await this.persist()
        this.uncommittedTerminals.delete(task.task_id)
        this.changed(task)
        if (task.notification_pending) {
          try {
            Promise.resolve(this.notify?.(this.summary(task))).catch(() => {})
          } catch {}
        }
      } catch (error) {
        this.latchStorageError(error)
        this.changed(task)
      }
      if (!this.safety.retains(task.session_id)) {
        this.runtimes.delete(task.task_id)
      }
      this.pump()
    }
  }

  private confirmInitializationCleanup(task: TaskRecord, runtime: TaskRuntime): void {
    this.safety.confirmDisposed(new Set([task.session_id]), this.getState().tasks)
    runtime.initializationCleanupPending = false
  }

  private async abortChild(task: TaskRecord, runtime: TaskRuntime): Promise<void> {
    let child: ChildSession | undefined
    try {
      child = await runtime.ready
    } catch (error) {
      if (!runtime.initializationCanceled) {
        throw error
      }
      child = this.sessions.get(task.session_id)?.child
      if (!child) {
        // A failed factory must either confirm cleanup or explicitly retain unresolved ownership.
        if (this.safety.record(task, error)) {
          throw error
        }
        this.confirmInitializationCleanup(task, runtime)
        return
      }
    }
    await child!.abort()
    if (runtime.initializationCanceled) {
      await child!.dispose()
      const session = this.sessions.get(task.session_id)
      if (session && session.child === child) {
        delete session.child
      }
      this.confirmInitializationCleanup(task, runtime)
    }
  }

  private async waitForInitializationStop(task: TaskRecord, runtime: TaskRuntime): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const stopped = await Promise.race([
        runtime.aborting!.then(() => true),
        new Promise<boolean>((finishWait) => {
          timer = setTimeout(() => finishWait(false), initializationStopWaitMs)
        })
      ])
      if (!stopped) {
        runtime.initializationCleanupPending = true
        this.safety.record(task, new Error('Child initialization cleanup is unconfirmed'), true)
        if (pending.has(task.status)) {
          this.domain.transition(task, runtime.stopStatus!)
          task.finished_at = new Date().toISOString()
          task.notification_pending =
            runtime.stopStatus !== 'canceled' && task.notify_completion !== false
        }
        this.uncommittedTerminals.add(task.task_id)
        this.changed(task)
        const marker = this.persist()
          .then(() => {
            this.uncommittedTerminals.delete(task.task_id)
          })
          .catch((error) => {
            this.latchStorageError(error)
            this.changed(task)
          })
        await Promise.allSettled([runtime.stoppingWrite, marker])
        this.changed(task)
      } else {
        await runtime.stoppingWrite?.catch(() => {})
      }
      if (this.storageError) {
        throw this.storageError
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async initializationStopReport(task: TaskRecord, runtime: TaskRuntime): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        runtime.stopWait!.then(async () => {
          if (!runtime.initializationCleanupPending) {
            await runtime.done
          }
          if (this.storageError) {
            throw this.storageError
          }
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              this.storageError ??
                Object.assign(
                  new Error('Child initialization stop or persistence is unconfirmed'),
                  { code: 'CHILD_CLEANUP_FAILED' }
                )
            )
          }, initializationStopWaitMs * 2)
        })
      ])
      if (this.uncommittedTerminals.has(task.task_id)) {
        throw this.storageError ?? new Error('Task stop persistence is unconfirmed')
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async cancel(
    task: TaskRecord,
    reason: string,
    status: 'canceled' | 'failed' = 'canceled',
    shutdown = false
  ): Promise<TaskSummary> {
    const runtime = this.runtimes.get(task.task_id)
    if (runtime && shutdown) {
      runtime.shutdownReason = reason
    }
    if (runtime?.initializationCanceled && runtime.stopReport && !(shutdown && runtime.settled)) {
      await runtime.stopReport.catch((error) => {
        // A cached deadline is not allowed to hide the first real write failure arriving later.
        throw this.storageError ?? error
      })
      return this.summary(task)
    }
    if (runtime?.sealed || !pending.has(task.status)) {
      if (pending.has(task.status) || runtime?.sealed) {
        await runtime?.done
      }
      if (this.uncommittedTerminals.has(task.task_id)) {
        await this.persist()
        this.uncommittedTerminals.delete(task.task_id)
        this.changed(task)
      }
      return this.summary(task)
    }
    if (!runtime) {
      this.executionContexts.delete(task.task_id)
      this.domain.transition(task, status)
      task.finished_at = new Date().toISOString()
      task.cancel_reason = reason
      const terminal = appendTerminalOutput(task, {
        status: status === 'canceled' ? 'aborted' : 'failed',
        errorMessage: reason
      })
      if (terminal.lastError) {
        task.error = terminal.lastError.message
      }
      // A failed save may have committed; retain the terminal producer and retry only the write.
      this.uncommittedTerminals.add(task.task_id)
      await this.persist()
      this.uncommittedTerminals.delete(task.task_id)
      this.changed(task)
      return this.summary(task)
    }
    if (!runtime.stopReason) {
      runtime.initializationCanceled = runtime.initializing
      runtime.accepting = false
      clearTimeout(runtime.timer)
      runtime.stopReason = reason || 'Task canceled'
      runtime.stopStatus = status
      this.domain.transition(task, 'stopping')
      task.cancel_reason = runtime.stopReason
      runtime.rejectStarted?.(new Error(runtime.stopReason))
      if (status === 'failed') {
        task.error = runtime.stopReason
      }
      runtime.aborting = this.abortChild(task, runtime).catch(async (error) => {
        if (runtime.initializationCanceled) {
          runtime.initializationCleanupPending = true
        }
        if (!this.safety.record(task, error, runtime.initializationCanceled)) {
          task.stopError = {
            code: 'TASK_STOP_FAILED',
            message: normalizeTaskError(error).message
          }
          task.error = task.stopError.message
        }
        runtime.stopStatus = status
        // Upstream reports a failed explicit stop as canceled + stopError; capacity remains owned independently.
        if (pending.has(task.status)) {
          this.domain.transition(task, status)
          task.finished_at = new Date().toISOString()
          task.notification_pending = status !== 'canceled' && task.notify_completion !== false
        }
        try {
          await this.persist()
        } catch (failure) {
          this.latchStorageError(failure)
        }
        this.changed(task)
      })
      // Install both cleanup and bounded reporting before the first stopping-row write can fail.
      if (runtime.initializationCanceled) {
        runtime.stoppingWrite = this.persist().catch((error) => {
          this.latchStorageError(error)
          this.changed(task)
          throw this.storageError
        })
        runtime.stoppingWrite.catch(() => {})
        runtime.stopWait = this.waitForInitializationStop(task, runtime)
        runtime.stopWait.catch(() => {})
        runtime.stopReport = this.initializationStopReport(task, runtime)
        runtime.stopReport.catch(() => {})
      }
      runtime.controller.abort()
      if (!runtime.initializationCanceled) {
        try {
          await this.persist()
        } catch (error) {
          this.latchStorageError(error)
          this.changed(task)
          throw this.storageError
        }
      }
      this.changed(task)
    }
    if (runtime.initializationCanceled) {
      await runtime.stopReport
      return this.summary(task)
    }
    await runtime.aborting
    // A failed abort is observable immediately, but the live child still owns its slot.
    if (!task.stopError) {
      await runtime.done
    }
    return this.summary(task)
  }

  async stop(taskId: string, reason = 'Task canceled'): Promise<TaskSummary> {
    this.assertOpen()
    return this.cancel(this.task(taskId), reason)
  }

  async query(): Promise<TaskSummary[]>
  async query(query: TaskQuery & { task_id: string }): Promise<TaskSummary>
  async query(query: TaskQuery & { task_id?: undefined }): Promise<TaskSummary[]>
  async query(query: TaskQuery): Promise<TaskSummary | TaskSummary[]>
  async query({ task_id, status }: TaskQuery = {}): Promise<TaskSummary | TaskSummary[]> {
    this.assertOpen()
    if (task_id) {
      return this.summary(this.task(task_id))
    }
    return this.getState()
      .tasks.filter((task) => !status || task.status === status)
      .map((task) => this.summary(task))
  }

  waitUntil(predicate: () => boolean, timeout?: number, signal?: AbortSignal): Promise<boolean> {
    return waitForChange(this.waiters, predicate, timeout, signal)
  }

  async output(
    taskId: string,
    { offset, wait_ms = 0, limitBytes = 65536, signal }: TaskOutputOptions = {}
  ): Promise<TaskOutput> {
    this.assertOpen()
    aborted(signal)
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
      throw new Error('Invalid output offset')
    }
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
      throw new Error('Invalid output limit')
    }
    const task = this.task(taskId)
    const waitMs = Math.max(0, Math.min(30000, Number(wait_ms) || 0))
    const read = async (requested: number): Promise<TaskOutput> => {
      if (requested > Buffer.byteLength(task.output)) {
        throw new Error('Output offset exceeds available bytes')
      }
      const changed =
        waitMs === 0 ||
        (await this.waitUntil(
          () => Buffer.byteLength(task.output) > requested || !pending.has(task.status),
          waitMs,
          signal
        ))
      return this.exclusive(async () => {
        aborted(signal)
        const bytes = Buffer.from(task.output)
        let start = requested
        // Explicit offsets inside a code point advance to its next boundary.
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
          start++
        }
        const result = await this.domain.readOutput(taskId, { offset: start, limitBytes })
        const end = result.nextOffset ?? start
        const truncated = result.truncated ?? false
        return {
          ...this.summary(task),
          output: result.content,
          offset: start,
          next_offset: end,
          has_more: truncated,
          truncated,
          ...(waitMs > 0 ? { timed_out: !changed } : {})
        }
      })
    }
    return offset === undefined ? this.outputReads.automatic(taskId, signal, read) : read(offset)
  }

  async pendingNotifications(): Promise<TaskSummary[]> {
    this.assertOpen()
    return this.getState()
      .tasks.filter((task) => task.notification_pending)
      .map((task) => this.summary(task))
  }

  async ackNotification(taskId: string): Promise<TaskSummary> {
    return this.exclusive(async () => {
      this.assertOpen()
      const task = this.task(taskId)
      task.notification_pending = false
      await this.persist()
      return this.summary(task)
    })
  }

  private async disposeSessions(tasks: TaskRecord[]): Promise<Set<string>> {
    // A timed-out close must retain and reuse the same in-flight cleanup attempt.
    this.disposing ??= this.safety.dispose(this.sessions, tasks)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      let disposal = this.disposing
      if ([...this.runtimes.values()].some((runtime) => runtime.initializationCanceled)) {
        disposal = Promise.race([
          disposal,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                Object.assign(new Error('Child initialization cleanup is unconfirmed'), {
                  code: 'CHILD_CLEANUP_FAILED'
                })
              )
            }, initializationStopWaitMs)
          })
        ])
      }
      const confirmed = await disposal
      this.disposing = undefined
      return confirmed
    } finally {
      clearTimeout(timer)
    }
  }

  private async reportClose(closing: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        closing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              Object.assign(
                new Error('Task owner close is unconfirmed', {
                  cause: this.storageError ?? this.closingError
                }),
                { code: 'CHILD_CLEANUP_FAILED' }
              )
            )
          }, closeReportWaitMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      return this.reportClose(this.closing)
    }
    this.closed = true
    this.closingError = undefined
    this.closing = (async () => {
      // Append admission may be waiting for initial prompt dispatch. Closing must wake it first.
      for (const runtime of this.runtimes.values()) {
        if (runtime.initializing) {
          runtime.rejectStarted?.(new Error('Parent closed'))
        }
      }
      await this.admission.settled()
      if (!this.state) {
        return
      }
      const tasks = this.getState().tasks
      const cancellations = await Promise.allSettled(
        tasks
          .filter(
            (task) =>
              pending.has(task.status) ||
              this.runtimes.has(task.task_id) ||
              this.uncommittedTerminals.has(task.task_id)
          )
          .map(async (task) => {
            try {
              return await this.cancel(task, 'Parent closed', 'canceled', true)
            } catch (error) {
              // Retain the first fault, but do not abandon another cancellation's pending write.
              this.closingError ??= error
              throw error
            }
          })
      )
      const failed = cancellations.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        throw this.closingError ?? failed.reason
      }
      if (
        [...this.runtimes.values()].some(
          (runtime) => runtime.initializationCanceled && !runtime.settled
        )
      ) {
        // The original run still owns its pending factory/disposal; do not race a second cleanup.
        throw Object.assign(new Error('Child initialization cleanup is unconfirmed'), {
          code: 'CHILD_CLEANUP_FAILED'
        })
      }
      const hadCleanupFailure = this.safety.quarantined
      const confirmed = await this.disposeSessions(tasks)
      await Promise.all(
        [...this.runtimes]
          .filter(([id]) => confirmed.has(this.task(id).session_id))
          .map(([, runtime]) => Promise.resolve(runtime.done))
      )
      const recovered = this.safety.confirmDisposed(confirmed, tasks)
      if (
        this.uncommittedTerminals.size ||
        hadCleanupFailure ||
        recovered ||
        this.safety.quarantined
      ) {
        try {
          await this.persist()
          this.uncommittedTerminals.clear()
        } catch (error) {
          this.latchStorageError(error)
          throw error
        }
      }
      for (const task of tasks) {
        if (task.stopError) {
          this.changed(task)
        }
      }
      this.safety.assertDispatch()
      this.runtimes.clear()
      await this.store.close()
    })().catch((error) => {
      // Keep the lock and readable owner when cleanup remains unproven; close can be retried.
      this.closed = false
      this.closing = undefined
      throw error
    })
    // Only the report is bounded. Keep closing/closed and its single owned drain until it settles.
    return this.reportClose(this.closing)
  }
}
