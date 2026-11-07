import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { TaskEngine } from './engine.ts'
import { taskCompletionNotice, taskProgress, taskWidget } from './task-presentation.ts'
import { loadConfig, resolveProfile } from './config.ts'
import { createPiChildFactory, type PiChildFactoryOptions } from './pi-backend.ts'
import { captureParentRuntime, type ParentRuntimeAPI } from './parent-runtime.ts'
import {
  closeDetachedOwners,
  forgetOwner,
  getOwner,
  retainOwner,
  type ControllerOwner
} from './controller-owners.ts'
import { isActiveTaskStatus } from './vendor/mcode-background-task/status.ts'
import type {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canceled(): Error {
  return Object.assign(new Error('Parent operation canceled'), { name: 'AbortError' })
}

function widgetText(value: string): string {
  return stripTerminalSequences(stripVTControlCharacters(value))
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function rpcTaskWidget(tasks: readonly TaskSummary[], hidden: number): string[] {
  // Share TUI semantics without a width limit or theme; sanitize before ID shortening.
  const lines = tasks.map((task) => {
    const safe = { ...task }
    for (const key of [
      'task_id',
      'agent_name',
      'description',
      'activity',
      'error',
      'cancel_reason'
    ] as const) {
      const value = task[key]
      if (typeof value === 'string') {
        safe[key] = widgetText(value)
      }
    }
    if (task.stopError) {
      safe.stopError = { ...task.stopError, message: widgetText(task.stopError.message) }
    }
    return widgetText(taskProgress(safe))
  })
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
  private readonly admissions = new Set<AbortController>()
  private generation = 0
  private initializing: Promise<unknown> = Promise.resolve()
  private delivery: Promise<void> = Promise.resolve()
  private receiptTimer?: ReturnType<typeof setTimeout>
  private uiTimer?: ReturnType<typeof setTimeout>
  private closing = false
  private ctx?: ExtensionContext
  private parentId?: string
  private suppressed = false
  config!: TaskAgentsConfig
  engine?: TaskService
  cancelEpoch = 0
  dialogOpen = false

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
      if (this.engine && this.parentId === id) {
        this.checkOwnerContext(this.owner!, ctx)
        this.ctx = ctx
        return this.engine
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
      if (owner) {
        if (owner.attached) {
          throw new Error('Task owner is already attached')
        }
        this.checkOwnerContext(owner, ctx)
      }
      if (!owner) {
        const handle = {} as ControllerOwner
        const engine = new this.Engine({
          rootDir,
          parentId: id,
          cwd: ctx.cwd,
          maxConcurrency: this.config.maxConcurrency,
          createChild: (options) => handle.createChild(options),
          notify: () => handle.notify?.(),
          onChange: () => handle.onChange?.()
        })
        Object.assign(handle, {
          rootDir,
          parentId: id,
          cwd: resolve(ctx.cwd),
          engine,
          config: this.config,
          projectTrusted: ctx.isProjectTrusted?.() === true,
          createChild: this.makeChildFactory(
            ctx,
            () => {
              if (handle.readCodemodeEnabled) {
                handle.codemodeEnabled = handle.readCodemodeEnabled()
              }
              return handle.codemodeEnabled === true
            },
            () => {
              if (!handle.hostRuntime) {
                throw new Error('Parent runtime snapshot is not ready')
              }
              return handle.hostRuntime
            }
          )
        })
        await engine.init()
        if (generation !== this.generation) {
          await engine.close()
          throw canceled()
        }
        retainOwner(handle)
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
      const engine = (this.engine = owner.engine)
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
    if (this.ctx?.hasUI) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.ui.notify(`Task agents: ${message}`, 'warning')
    }
  }

  private async receiptEntries(ctx: ExtensionContext): Promise<unknown[]> {
    const file = ctx.sessionManager.getSessionFile?.()
    if (!file) {
      return ctx.sessionManager.getEntries()
    }
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    }
    const lines = text.split('\n')
    const entries: unknown[] = []
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (!line.trim()) {
        continue
      }
      try {
        entries.push(JSON.parse(line) as unknown)
      } catch {
        if (index !== lines.length - 1) {
          throw new Error('Parent history contains an invalid receipt record')
        }
      }
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
    // Pi emits message_end before its JSONL append. Only disk is a durable receipt.
    const delivered = new Set<string>()
    for (const entry of await this.receiptEntries(ctx)) {
      if (
        isRecord(entry) &&
        entry.type === 'custom_message' &&
        entry.customType === RESULT_TYPE &&
        isRecord(entry.details) &&
        entry.details.parent_id === parentId &&
        typeof entry.details.task_id === 'string'
      ) {
        delivered.add(entry.details.task_id)
      }
    }
    if (engine !== this.engine) {
      return
    }
    const canReclaim = reclaim && ctx.isIdle?.() === true && !ctx.hasPendingMessages?.()
    for (const task of await engine.pendingNotifications()) {
      if (delivered.has(task.task_id)) {
        // oxlint-disable-next-line no-await-in-loop -- Persist each receipt before clearing its in-flight notification.
        await engine.ackNotification(task.task_id)
        this.inFlight.delete(task.task_id)
        this.attempts.delete(task.task_id)
      } else if (canReclaim && Date.now() - (this.inFlight.get(task.task_id) ?? Infinity) >= 1000) {
        this.inFlight.delete(task.task_id)
      }
    }
  }

  async updateUI(): Promise<void> {
    clearTimeout(this.uiTimer)
    this.uiTimer = undefined
    const ctx = this.ctx
    const engine = this.engine
    if (!ctx?.hasUI || !engine || this.closing) {
      return
    }
    const tasks = await engine.query()
    if (engine !== this.engine || ctx !== this.ctx || this.closing) {
      return
    }
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
    if (pending.length && !this.uiTimer) {
      this.uiTimer = setTimeout(() => {
        this.uiTimer = undefined
        this.updateUI().catch((error) => {
          if (engine === this.engine && ctx === this.ctx && !this.closing) {
            this.warn(error)
          }
        })
      }, 1000)
      this.uiTimer.unref()
    }
  }

  private async admit(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    operation: (engine: TaskService, signal: AbortSignal) => Promise<TaskSummary>
  ): Promise<TaskSummary> {
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
  ): Promise<TaskSummary> {
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
  ): Promise<TaskSummary> {
    return this.admit(ctx, signal, (engine, combined) =>
      engine.send(input.task_id, input.content, {
        requestId: toolCallId,
        signal: combined,
        ...(nestedToolCall ? { nestedToolCall: true } : {})
      })
    )
  }

  flush(): Promise<void> {
    const operation = this.delivery.then(async () => {
      await this.reconcile({ reclaim: true })
      await this.deliver()
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

  private async deliver(): Promise<void> {
    const engine = this.engine
    const epoch = this.cancelEpoch
    if (!engine || !this.eligible(engine, epoch)) {
      return
    }
    const parentId = this.parentId
    for (const task of await engine.pendingNotifications()) {
      if (!this.eligible(engine, epoch)) {
        return
      }
      if (this.inFlight.has(task.task_id) || (this.attempts.get(task.task_id) ?? 0) >= 3) {
        continue
      }
      this.notifyFailure(task)
      this.inFlight.set(task.task_id, Date.now())
      this.attempts.set(task.task_id, (this.attempts.get(task.task_id) ?? 0) + 1)
      try {
        this.pi.sendMessage(
          {
            customType: RESULT_TYPE,
            display: false,
            content: taskCompletionNotice(task),
            details: { task_id: task.task_id, parent_id: parentId, status: task.status }
          },
          { triggerTurn: true, deliverAs: 'followUp' }
        )
      } catch (error) {
        this.inFlight.delete(task.task_id)
        this.warn(error)
      }
      // sendMessage returns void; a later disk/idle check also catches asynchronous failures.
      this.scheduleCheck(1000)
    }
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
    await this.delivery
    let released = false
    try {
      if (!preserve && this.engine) {
        await this.engine.close()
      }
      released = true
    } finally {
      // Failed cleanup retains the owner lease and engine for an explicit retry.
      if (released) {
        if (owner) {
          owner.attached = undefined
          if (!preserve) {
            forgetOwner(owner)
          }
        }
        this.owner = undefined
        this.engine = undefined
        this.inFlight.clear()
        this.attempts.clear()
        if (this.ctx?.hasUI) {
          this.ctx.ui.setStatus('task-agents', undefined)
          this.ctx.ui.setWidget('task-agents', undefined)
        }
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
    try {
      await this.closeOwner(preserve)
    } finally {
      if (!preserve) {
        await closeDetachedOwners(join(this.agentDir, 'task-agents', 'sessions'))
      }
    }
  }
}
