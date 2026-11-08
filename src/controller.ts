import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { TaskEngine } from './engine.ts'
import {
  taskCompletionBatchNotice,
  taskCompletionNotice,
  taskProgress,
  taskWidget,
  widgetTask,
  widgetText
} from './task-presentation.ts'
import { loadConfig, resolveProfile } from './config.ts'
import { createPiChildFactory, type PiChildFactoryOptions } from './pi-backend.ts'
import { captureParentRuntime, type ParentRuntimeAPI } from './parent-runtime.ts'
import { isRecord } from './guards.ts'
import {
  closeDetachedOwners,
  forgetOwner,
  getOwner,
  retainOwner,
  type ControllerOwner
} from './controller-owners.ts'
import { isActiveTaskStatus } from './vendor/mcode-background-task/status.ts'
import type {
  AdmissionReceipt,
  ConfigLoadOptions,
  CreateChild,
  TaskAgentsConfig,
  TaskEngineConstructor,
  TaskInput,
  TaskService,
  TaskSummary
} from './types.ts'

export const RESULT_TYPE = 'pi-task-agents:result'
const FAILURE_NOTICE_TYPE = 'pi-task-agents:failure-notice'
const DELIVERY_RETRY_DELAYS_MS = [1000, 2000, 5000] as const
const DELIVERY_RECOVERY_INITIAL_MS = 60_000
const DELIVERY_RECOVERY_MAX_MS = 300_000
const DELIVERY_BURST_WINDOW_MS = 60_000
const MAX_DELIVERY_TURNS_PER_WINDOW = 3
const MAX_NOTIFICATION_BATCH_TASKS = 32
const MAX_NOTIFICATION_BATCH_BYTES = 8 * 1024

type ParentAPI = Pick<ExtensionAPI, 'sendMessage' | 'appendEntry' | 'getThinkingLevel'> &
  Partial<Pick<ExtensionAPI, 'getActiveTools'>> &
  ParentRuntimeAPI
type ConfigLoader = (options: ConfigLoadOptions) => Promise<TaskAgentsConfig>

export interface TaskControllerOptions {
  agentDir: string
  Engine?: TaskEngineConstructor
  configLoader?: ConfigLoader
  childFactory?: (options: PiChildFactoryOptions) => CreateChild
  captureRuntime?: (
    ctx: ExtensionContext,
    signal?: AbortSignal
  ) => ReturnType<typeof captureParentRuntime>
}

function receiptTaskIds(entry: unknown, parentId: string | undefined): string[] {
  if (
    !isRecord(entry) ||
    entry.type !== 'custom_message' ||
    entry.customType !== RESULT_TYPE ||
    !isRecord(entry.details) ||
    entry.details.parent_id !== parentId
  ) {
    return []
  }
  const ids: string[] = []
  if (typeof entry.details.task_id === 'string') {
    ids.push(entry.details.task_id)
  }
  if (Array.isArray(entry.details.task_ids)) {
    for (const id of entry.details.task_ids) {
      if (typeof id === 'string') {
        ids.push(id)
      }
    }
  }
  return ids
}

function canceled(): Error {
  return Object.assign(new Error('Parent operation canceled'), { name: 'AbortError' })
}

function nextRecoveryDelayMs(previous: number | undefined): number {
  return Math.min(
    previous === undefined ? DELIVERY_RECOVERY_INITIAL_MS : previous * 2,
    DELIVERY_RECOVERY_MAX_MS
  )
}

function rpcTaskWidget(tasks: readonly TaskSummary[], hidden: number): string[] {
  const lines = tasks.map((task) => widgetText(taskProgress(widgetTask(task))))
  if (hidden) {
    lines.push(`${hidden} more tasks · /tasks list`)
  }
  return lines
}

export class TaskController {
  private readonly pi: ParentAPI
  private readonly agentDir: string
  private readonly Engine: TaskEngineConstructor
  private readonly configLoader: ConfigLoader
  private readonly childFactory: (options: PiChildFactoryOptions) => CreateChild
  private readonly captureRuntime: NonNullable<TaskControllerOptions['captureRuntime']>
  private owner?: ControllerOwner
  private readonly inFlight = new Map<string, number>()
  private readonly attempts = new Map<string, number>()
  private readonly retryAt = new Map<string, number>()
  private readonly recoveryDelay = new Map<string, number>()
  private readonly admissions = new Set<AbortController>()
  private burstStartedAt = 0
  private burstDelivered = 0
  private generation = 0
  private initializing: Promise<unknown> = Promise.resolve()
  private delivery: Promise<void> = Promise.resolve()
  private receiptTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryTimerAt?: number
  private burstTimer?: ReturnType<typeof setTimeout>
  private burstTimerAt?: number
  private uiTimer?: ReturnType<typeof setTimeout>
  private uiRevision = 0
  private uiActive = false
  private uiFailureReported = false
  private closing = false
  private ctx?: ExtensionContext
  private parentId?: string
  private suppressed = false
  config!: TaskAgentsConfig
  cancelEpoch = 0
  dialogOpen = false

  /** The attached owner solely owns the live engine. */
  get engine(): TaskService | undefined {
    return this.owner?.engine
  }

  constructor(pi: ParentAPI, options: TaskControllerOptions) {
    this.pi = pi
    this.agentDir = resolve(options.agentDir)
    this.Engine = options.Engine ?? TaskEngine
    this.configLoader = options.configLoader ?? loadConfig
    this.childFactory = options.childFactory ?? createPiChildFactory
    this.captureRuntime =
      options.captureRuntime ?? ((_ctx, signal) => captureParentRuntime(this.pi, signal))
  }

  async ensure(ctx: ExtensionContext): Promise<TaskService> {
    const id = ctx.sessionManager.getSessionId()
    const generation = this.generation
    const init = this.initializing.then(async () => {
      if (generation !== this.generation) {
        throw canceled()
      }
      if (this.owner && this.parentId === id) {
        this.checkOwnerContext(this.owner, ctx)
        this.ctx = ctx
        return this.owner.engine
      }
      await this.closeOwner(true)
      this.ctx = ctx
      this.parentId = id
      const pause = ctx.sessionManager
        .getEntries()
        .findLast(
          (entry) => entry.type === 'custom' && entry.customType === 'pi-task-agents:paused'
        )
      this.suppressed =
        pause?.type === 'custom' && isRecord(pause.data) && pause.data.paused === true
      this.config = await this.configLoader({
        cwd: ctx.cwd,
        agentDir: this.agentDir,
        projectTrusted: ctx.isProjectTrusted?.() === true
      })
      if (generation !== this.generation) {
        throw canceled()
      }
      const rootDir = join(this.agentDir, 'task-agents', 'sessions')
      let owner = getOwner(rootDir, id)
      if (owner?.cleanupFailed) {
        // A previous close could not prove cleanup. Its store lock and child leases
        // remain owned, so retry that close before reusing or replacing the engine.
        const stale = owner
        let failure: unknown
        try {
          await stale.engine.close()
        } catch (error) {
          failure = error
        }
        if (generation !== this.generation) {
          throw canceled()
        }
        if (failure) {
          throw failure
        }
        forgetOwner(stale)
        owner = undefined
      }
      if (owner) {
        if (owner.attached) {
          throw new Error('Task owner is already attached')
        }
        this.checkOwnerContext(owner, ctx)
      }
      if (!owner) {
        // The engine constructor receives callbacks that run only after this handle
        // exists, so the owner is constructed once and published through the holder.
        const ref: { current?: ControllerOwner } = {}
        const engine = new this.Engine({
          rootDir,
          parentId: id,
          cwd: ctx.cwd,
          maxConcurrency: this.config.maxConcurrency,
          createChild: (options) => {
            const current = ref.current
            if (!current) {
              throw new Error('Task owner is not initialized')
            }
            return current.createChild(options)
          },
          notify: () => ref.current?.notify?.(),
          onChange: () => ref.current?.onChange?.()
        })
        const handle: ControllerOwner = {
          rootDir,
          parentId: id,
          cwd: resolve(ctx.cwd),
          engine,
          config: this.config,
          projectTrusted: ctx.isProjectTrusted?.() === true,
          createChild: this.makeChildFactory(
            ctx,
            () => {
              const current = ref.current
              if (current?.readCodemodeEnabled) {
                current.codemodeEnabled = current.readCodemodeEnabled()
              }
              return current?.codemodeEnabled === true
            },
            () => {
              const runtime = ref.current?.hostRuntime
              if (!runtime) {
                throw new Error('Parent runtime snapshot is not ready')
              }
              return runtime
            }
          )
        }
        ref.current = handle
        await engine.init()
        if (generation !== this.generation) {
          await engine.close()
          throw canceled()
        }
        try {
          retainOwner(handle)
        } catch (error) {
          // Losing the retention race must not leave an initialized store lock behind.
          try {
            await engine.close()
          } catch (closeError) {
            // Keep the retention failure as the caller's error, but never hide a leaked lock.
            this.warn(closeError)
          }
          throw error
        }
        owner = handle
      }
      owner.attached = this
      owner.readCodemodeEnabled = () => {
        try {
          return this.pi.getActiveTools?.().includes('codemode') === true
        } catch {
          return false
        }
      }
      owner.codemodeEnabled = owner.readCodemodeEnabled()
      owner.notify = () => {
        this.flush().catch((error: unknown) => this.warn(error))
      }
      owner.onChange = () => {
        this.updateUI().catch(() => {})
      }
      this.owner = owner
      this.config = owner.config
      const engine = owner.engine
      for (const diagnostic of this.config.diagnostics) {
        this.warn(diagnostic)
      }
      await this.reconcile()
      await this.updateUI()
      return engine
    })
    this.initializing = init.catch(() => {})
    return init
  }

  private checkOwnerContext(owner: ControllerOwner, ctx: ExtensionContext): void {
    // The factory owns cached SDK state. Context changes require explicit
    // teardown rather than silently reusing stale trust or discarding its cache.
    if (
      owner.cwd !== resolve(ctx.cwd) ||
      owner.projectTrusted !== (ctx.isProjectTrusted?.() === true)
    ) {
      throw new Error(
        'Task owner working directory or project trust changed; reload task agents before continuing'
      )
    }
  }

  private makeChildFactory(
    ctx: ExtensionContext,
    isCodemodeEnabled: () => boolean,
    getParentRuntime: NonNullable<PiChildFactoryOptions['getParentRuntime']>
  ): CreateChild {
    return this.childFactory({
      agentDir: this.agentDir,
      getParentRuntime,
      inheritedModel: ctx.model,
      inheritedThinking: this.pi.getThinkingLevel(),
      inheritedModelRegistry: ctx.modelRegistry,
      isCodemodeEnabled,
      projectTrusted: ctx.isProjectTrusted?.() === true
    })
  }

  warn(error: unknown): void {
    try {
      if (this.ctx?.hasUI) {
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.ui.notify(`Task agents: ${message}`, 'warning')
      }
    } catch {
      // This runs as a rejection handler; invalidated SDK contexts must not
      // surface as an unhandled rejection during reload or shutdown.
    }
  }

  private async receiptEntries(ctx: ExtensionContext): Promise<unknown[]> {
    const file = ctx.sessionManager.getSessionFile?.()
    if (!file) {
      return ctx.sessionManager.getEntries()
    }
    const entries: unknown[] = []
    const input = createReadStream(file, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        // Session files also hold full tool results. Skip them without parsing,
        // or every receipt check would deserialize the whole parent history.
        if (!line.includes(RESULT_TYPE)) {
          continue
        }
        try {
          entries.push(JSON.parse(line) as unknown)
        } catch {
          // Pi skips torn or malformed JSONL records and repairs a missing final
          // newline, so one crashed append must not block every later receipt.
        }
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    } finally {
      lines.close()
      input.destroy()
    }
    return entries
  }

  async reconcile({ reclaim = false }: { reclaim?: boolean } = {}): Promise<void> {
    const engine = this.engine
    const ctx = this.ctx
    const parentId = this.parentId
    if (!engine || !ctx) {
      return
    }
    const pending = await engine.pendingNotifications()
    if (engine !== this.engine) {
      return
    }
    if (pending.length === 0) {
      this.clearRetryTimer()
      return
    }
    // Pi emits message_end before its JSONL append. Only disk is a durable receipt.
    const delivered = new Set<string>()
    for (const entry of await this.receiptEntries(ctx)) {
      for (const taskId of receiptTaskIds(entry, parentId)) {
        delivered.add(taskId)
      }
    }
    if (engine !== this.engine) {
      return
    }
    const canReclaim = reclaim && ctx.isIdle?.() === true && !ctx.hasPendingMessages?.()
    for (const task of pending) {
      if (delivered.has(task.task_id)) {
        // oxlint-disable-next-line no-await-in-loop -- Persist each receipt before clearing its in-flight notification.
        await engine.ackNotification(task.task_id)
        this.clearDeliveryState(task.task_id)
      } else if (canReclaim && Date.now() - (this.inFlight.get(task.task_id) ?? Infinity) >= 1000) {
        this.inFlight.delete(task.task_id)
      }
    }
    if (pending.every((task) => delivered.has(task.task_id))) {
      this.clearRetryTimer()
    }
  }

  private scheduleUI(ctx: ExtensionContext, engine: TaskService): void {
    if (this.uiTimer) {
      return
    }
    this.uiTimer = setTimeout(() => {
      this.uiTimer = undefined
      this.updateUI().catch((error) => {
        if (
          engine === this.engine &&
          ctx === this.ctx &&
          !this.closing &&
          !this.uiFailureReported
        ) {
          this.uiFailureReported = true
          this.warn(error)
        }
      })
    }, 1000)
    this.uiTimer.unref()
  }

  async updateUI(): Promise<void> {
    const revision = ++this.uiRevision
    const ctx = this.ctx
    const engine = this.engine
    if (!ctx?.hasUI || !engine || this.closing) {
      return
    }
    let tasks
    try {
      tasks = await engine.query()
    } catch (error) {
      if (
        revision !== this.uiRevision ||
        engine !== this.engine ||
        ctx !== this.ctx ||
        this.closing
      ) {
        return
      }
      if (this.uiActive) {
        this.scheduleUI(ctx, engine)
      }
      throw error
    }
    if (
      revision !== this.uiRevision ||
      engine !== this.engine ||
      ctx !== this.ctx ||
      this.closing
    ) {
      return
    }
    this.uiFailureReported = false
    const pending = tasks.filter((task) => isActiveTaskStatus(task.status) || task.cleanup_pending)
    const cleanup = pending.filter((task) => task.cleanup_pending).length
    const queued = pending.filter((task) => task.status === 'queued').length
    const running = pending.length - queued
    const cap = this.config.maxConcurrency
    const capacity = typeof cap === 'number' && Number.isFinite(cap) ? `/${cap}` : ''
    ctx.ui.setStatus(
      'task-agents',
      pending.length
        ? `Agents ${running}${capacity}${queued ? ` · queued ${queued}` : ''}${cleanup ? ` · cleanup pending ${cleanup}` : ''}`
        : undefined
    )
    const visible = pending
      .sort(
        (a, b) =>
          Number(Boolean(b.cleanup_pending)) - Number(Boolean(a.cleanup_pending)) ||
          Number(a.status === 'queued') - Number(b.status === 'queued')
      )
      .slice(0, 6)
    if (ctx.mode === 'tui') {
      ctx.ui.setWidget(
        'task-agents',
        visible.length
          ? (_tui, theme) => taskWidget(visible, pending.length - visible.length, theme)
          : undefined
      )
    } else {
      ctx.ui.setWidget(
        'task-agents',
        visible.length ? rpcTaskWidget(visible, pending.length - visible.length) : undefined
      )
    }
    this.uiActive = pending.length > 0
    if (this.uiActive) {
      this.scheduleUI(ctx, engine)
    } else {
      clearTimeout(this.uiTimer)
      this.uiTimer = undefined
    }
  }

  private async admit<T extends TaskSummary>(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    operation: (engine: TaskService, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const epoch = this.cancelEpoch
    const engine = await this.ensure(ctx)
    if (
      signal?.aborted ||
      epoch !== this.cancelEpoch ||
      this.closing ||
      ctx.sessionManager.getSessionId() !== this.parentId
    ) {
      throw canceled()
    }
    const admission = new AbortController()
    this.admissions.add(admission)
    const combined = signal ? AbortSignal.any([signal, admission.signal]) : admission.signal
    try {
      const owner = this.owner
      const runtime = await this.captureRuntime(ctx, combined)
      if (
        combined.aborted ||
        epoch !== this.cancelEpoch ||
        this.closing ||
        !owner ||
        owner !== this.owner ||
        ctx.sessionManager.getSessionId() !== this.parentId
      ) {
        throw canceled()
      }
      owner.hostRuntime = runtime
      const result = await operation(engine, combined)
      if (!combined.aborted && epoch === this.cancelEpoch && result.status !== 'canceled') {
        this.resume()
        this.flush().catch((error: unknown) => this.warn(error))
      }
      return result
    } finally {
      this.admissions.delete(admission)
    }
  }

  start(
    input: TaskInput,
    toolCallId: string,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    nestedToolCall = false
  ): Promise<TaskSummary> {
    return this.admit(ctx, signal, (engine, combined) => {
      const selected = resolveProfile(this.config, input)
      let profile = selected
      if (selected.model === undefined) {
        if (!ctx.model) {
          throw new Error('Parent model is unavailable for task inheritance')
        }
        // Resolve inheritance at admission, not child dispatch or reload. Queued
        // work and later continuations must retain the model of this task.
        profile = {
          ...selected,
          model: `${ctx.model.provider}/${ctx.model.id}`,
          thinking:
            selected.thinking ??
            (selected.effort === undefined ? this.pi.getThinkingLevel() : undefined)
        }
      }
      return engine.start(input, profile, {
        requestId: toolCallId,
        signal: combined,
        ...(nestedToolCall ? { nestedToolCall: true } : {})
      })
    })
  }

  append(
    input: { task_id: string; content: string },
    toolCallId: string,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext
  ): Promise<AdmissionReceipt> {
    return this.admit(ctx, signal, (engine, combined) =>
      engine.append(input.task_id, input.content, { requestId: toolCallId, signal: combined })
    )
  }

  send(
    input: { task_id: string; content: string },
    toolCallId: string,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    nestedToolCall = false
  ): Promise<AdmissionReceipt> {
    return this.admit(ctx, signal, (engine, combined) =>
      engine.send(input.task_id, input.content, {
        requestId: toolCallId,
        signal: combined,
        ...(nestedToolCall ? { nestedToolCall: true } : {})
      })
    )
  }

  flush(options: { startup?: boolean } = {}): Promise<void> {
    const operation = this.delivery.then(async () => {
      await this.reconcile({ reclaim: true })
      await this.deliver(options)
    })
    this.delivery = operation.catch(() => {})
    return operation
  }

  private eligible(engine: TaskService, epoch: number): boolean {
    return (
      engine === this.engine &&
      !this.closing &&
      !this.suppressed &&
      !this.dialogOpen &&
      epoch === this.cancelEpoch &&
      this.parentId === this.ctx?.sessionManager.getSessionId()
    )
  }

  private async deliver(options: { startup?: boolean } = {}): Promise<void> {
    const engine = this.engine
    const epoch = this.cancelEpoch
    if (!engine || !this.eligible(engine, epoch)) {
      this.clearBurstTimer()
      this.clearRetryTimer()
      return
    }
    const parentId = this.parentId
    // A startup notification must not claim the host's run slot before its first
    // prompt: print/json/RPC sessions submit that prompt immediately after start.
    const wake = !options.startup || this.ctx?.mode === 'tui'
    const pending = await engine.pendingNotifications()
    if (!parentId || !this.eligible(engine, epoch)) {
      this.clearBurstTimer()
      this.clearRetryTimer()
      return
    }
    if (pending.length === 0) {
      this.clearBurstTimer()
      this.clearRetryTimer()
      return
    }
    const now = Date.now()
    const ready = pending.filter(
      (task) => !this.inFlight.has(task.task_id) && (this.retryAt.get(task.task_id) ?? 0) <= now
    )
    const batch = this.selectNotificationBatch(ready)
    if (batch.length === 0) {
      this.clearBurstTimer()
      this.armRetryTimer(pending)
      return
    }
    const burstEnd = this.deliveryBurstEnd(now)
    if (burstEnd !== undefined) {
      // Deferring keeps tasks pending so a later batch can merge newer terminals.
      this.armBurstTimer(burstEnd)
      this.armRetryTimer(pending)
      return
    }
    this.clearBurstTimer()
    for (const task of batch) {
      this.notifyFailure(task)
      this.inFlight.set(task.task_id, now)
      const attempts = (this.attempts.get(task.task_id) ?? 0) + 1
      this.attempts.set(task.task_id, attempts)
      if (attempts <= DELIVERY_RETRY_DELAYS_MS.length) {
        this.recoveryDelay.delete(task.task_id)
        this.retryAt.set(task.task_id, now + DELIVERY_RETRY_DELAYS_MS[attempts - 1])
      } else {
        const delay = nextRecoveryDelayMs(this.recoveryDelay.get(task.task_id))
        this.recoveryDelay.set(task.task_id, delay)
        this.retryAt.set(task.task_id, now + delay)
      }
    }
    try {
      this.pi.sendMessage(
        this.notificationMessage(batch, parentId),
        wake ? { triggerTurn: true, deliverAs: 'followUp' } : { deliverAs: 'nextTurn' }
      )
      this.burstDelivered++
    } catch (error) {
      for (const task of batch) {
        this.inFlight.delete(task.task_id)
      }
      this.warn(error)
    }
    // sendMessage returns void; a later disk/idle check also catches asynchronous failures.
    this.armRetryTimer(pending)
    this.scheduleCheck(1000)
  }

  private notificationMessage(
    tasks: readonly TaskSummary[],
    parentId: string
  ): {
    customType: string
    display: boolean
    content: string
    details: {
      parent_id: string
      task_id?: string
      task_ids?: string[]
      status?: TaskSummary['status']
    }
  } {
    const [single] = tasks
    if (tasks.length === 1 && single) {
      return {
        customType: RESULT_TYPE,
        display: false,
        content: taskCompletionNotice(single),
        details: { task_id: single.task_id, parent_id: parentId, status: single.status }
      }
    }
    return {
      customType: RESULT_TYPE,
      display: false,
      content: taskCompletionBatchNotice(tasks),
      details: { task_ids: tasks.map((entry) => entry.task_id), parent_id: parentId }
    }
  }

  private selectNotificationBatch(tasks: readonly TaskSummary[]): TaskSummary[] {
    const selected: TaskSummary[] = []
    for (const task of tasks) {
      if (selected.length >= MAX_NOTIFICATION_BATCH_TASKS) {
        break
      }
      if (
        selected.length > 0 &&
        Buffer.byteLength(taskCompletionBatchNotice([...selected, task])) >
          MAX_NOTIFICATION_BATCH_BYTES
      ) {
        break
      }
      selected.push(task)
    }
    return selected
  }

  private armRetryTimer(tasks: readonly TaskSummary[]): void {
    if (this.closing || this.suppressed) {
      this.clearRetryTimer()
      return
    }
    const now = Date.now()
    let earliest: number | undefined
    for (const task of tasks) {
      const at = this.retryAt.get(task.task_id)
      if (at !== undefined && at > now && (earliest === undefined || at < earliest)) {
        earliest = at
      }
    }
    if (earliest === undefined) {
      this.clearRetryTimer()
      return
    }
    if (this.retryTimer && this.retryTimerAt !== undefined && this.retryTimerAt <= earliest) {
      return
    }
    this.clearRetryTimer()
    this.retryTimerAt = earliest
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.retryTimerAt = undefined
      this.flush().catch((error: unknown) => this.warn(error))
    }, earliest - now)
    this.retryTimer.unref()
  }

  private clearRetryTimer(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.retryTimerAt = undefined
  }

  private deliveryBurstEnd(now: number): number | undefined {
    if (now - this.burstStartedAt >= DELIVERY_BURST_WINDOW_MS) {
      this.burstStartedAt = now
      this.burstDelivered = 0
    }
    return this.burstDelivered < MAX_DELIVERY_TURNS_PER_WINDOW
      ? undefined
      : this.burstStartedAt + DELIVERY_BURST_WINDOW_MS + 1
  }

  private armBurstTimer(at: number): void {
    if (this.closing || this.suppressed) {
      this.clearBurstTimer()
      return
    }
    if (this.burstTimer && this.burstTimerAt !== undefined && this.burstTimerAt <= at) {
      return
    }
    this.clearBurstTimer()
    this.burstTimerAt = at
    this.burstTimer = setTimeout(
      () => {
        this.burstTimer = undefined
        this.burstTimerAt = undefined
        this.flush().catch((error: unknown) => this.warn(error))
      },
      Math.max(0, at - Date.now())
    )
    this.burstTimer.unref()
  }

  private clearBurstTimer(): void {
    clearTimeout(this.burstTimer)
    this.burstTimer = undefined
    this.burstTimerAt = undefined
  }

  private clearDeliveryState(taskId: string): void {
    this.inFlight.delete(taskId)
    this.attempts.delete(taskId)
    this.retryAt.delete(taskId)
    this.recoveryDelay.delete(taskId)
  }

  private notifyFailure(task: TaskSummary): void {
    const ctx = this.ctx
    if (!ctx?.hasUI || (task.status !== 'failed' && task.status !== 'lost')) {
      return
    }
    try {
      const seen = ctx.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === 'custom' &&
            entry.customType === FAILURE_NOTICE_TYPE &&
            isRecord(entry.data) &&
            entry.data.parent_id === this.parentId &&
            entry.data.task_id === task.task_id
        )
      if (seen) {
        return
      }
      // A custom entry adds no model context. Record first for at-most-once UI
      // feedback across reload/retry; native result delivery keeps its own receipt.
      this.pi.appendEntry(FAILURE_NOTICE_TYPE, {
        parent_id: this.parentId,
        task_id: task.task_id
      })
      const id = task.task_id.replace(/[^a-zA-Z0-9_-]/g, '?').slice(0, 80)
      ctx.ui.notify(
        `Task agents: ${task.status} task ${id}. Use /tasks list to inspect.`,
        'warning'
      )
    } catch {
      // Best-effort UI must not block or retry the owner's native followUp.
    }
  }

  private scheduleCheck(delay = 0): void {
    if (this.receiptTimer || this.closing) {
      return
    }
    const generation = this.generation
    this.receiptTimer = setTimeout(() => {
      this.receiptTimer = undefined
      if (generation === this.generation) {
        this.flush().catch((error: unknown) => this.warn(error))
      }
    }, delay)
    this.receiptTimer.unref()
  }

  receipt(message: unknown): void {
    if (
      isRecord(message) &&
      message.customType === RESULT_TYPE &&
      isRecord(message.details) &&
      message.details.parent_id === this.parentId
    ) {
      this.scheduleCheck()
    }
  }

  resume(): void {
    if (this.suppressed) {
      this.pi.appendEntry('pi-task-agents:paused', { paused: false })
    }
    this.attempts.clear()
    this.retryAt.clear()
    this.recoveryDelay.clear()
    this.clearRetryTimer()
    this.suppressed = false
  }

  pause(): void {
    this.cancelEpoch++
    if (!this.suppressed) {
      this.pi.appendEntry('pi-task-agents:paused', { paused: true })
    }
    this.suppressed = true
    clearTimeout(this.receiptTimer)
    this.receiptTimer = undefined
    this.clearBurstTimer()
    this.clearRetryTimer()
  }

  async stopAll(reason = 'Parent canceled'): Promise<TaskSummary[]> {
    this.pause()
    for (const admission of this.admissions) {
      admission.abort()
    }
    const engine = this.engine
    if (!engine) {
      return []
    }
    const tasks = await engine.query()
    const results = await Promise.all(
      tasks
        .filter((task) => isActiveTaskStatus(task.status) || task.cleanup_pending)
        // Terminal cleanup holds cannot be stopped again, but must remain in the report.
        .map(async (task) =>
          isActiveTaskStatus(task.status) ? engine.stop(task.task_id, reason) : task
        )
    )
    await this.updateUI()
    return results
  }

  private async closeOwner(preserve = false): Promise<void> {
    this.closing = true
    clearTimeout(this.uiTimer)
    this.uiTimer = undefined
    this.uiActive = false
    this.uiFailureReported = false
    const owner = this.owner
    if (owner) {
      owner.codemodeEnabled = preserve
        ? (owner.readCodemodeEnabled?.() ?? owner.codemodeEnabled ?? false)
        : false
      owner.readCodemodeEnabled = undefined
      owner.notify = undefined
      owner.onChange = undefined
    }
    clearTimeout(this.receiptTimer)
    this.receiptTimer = undefined
    this.clearBurstTimer()
    this.clearRetryTimer()
    await this.delivery
    let released = false
    try {
      if (!preserve && owner) {
        await owner.engine.close()
      }
      released = true
    } finally {
      // An unconfirmed close keeps the engine retained for a retry, but this
      // controller must release its attachment and live parent callbacks.
      if (owner) {
        owner.attached = undefined
        if (released) {
          if (!preserve) {
            forgetOwner(owner)
          }
        } else {
          owner.cleanupFailed = true
        }
      }
      this.owner = undefined
      this.inFlight.clear()
      this.attempts.clear()
      this.retryAt.clear()
      this.recoveryDelay.clear()
      this.burstStartedAt = 0
      this.burstDelivered = 0
      this.clearBurstTimer()
      this.clearRetryTimer()
      try {
        if (this.ctx?.hasUI) {
          this.ctx.ui.setStatus('task-agents', undefined)
          this.ctx.ui.setWidget('task-agents', undefined)
        }
      } catch {
        // UI teardown is best effort; control state must still be released.
      }
      this.closing = false
    }
  }

  async shutdown(reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork' = 'quit'): Promise<void> {
    this.generation++
    this.cancelEpoch++
    const preserve =
      !this.owner?.hostRuntime?.tools &&
      (reason === 'new' || reason === 'resume' || reason === 'fork')
    // Admission cancellation stops foreground waits; closeOwner drains tool-bound
    // background work before Pi invalidates its owner context.
    for (const admission of this.admissions) {
      admission.abort()
    }
    await this.initializing
    await this.closeOwner(preserve)
    if (!preserve) {
      await closeDetachedOwners(join(this.agentDir, 'task-agents', 'sessions'))
    }
  }
}
