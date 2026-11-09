import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  chmod,
  type FileHandle
} from 'node:fs/promises'
import type { AgentProfile, TaskInput, TaskRecord, TaskState } from './types.ts'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES
} from './vendor/mcode-background-task/status.ts'
import { isEventCount, isFactName, isTurnId } from './engine-facts.ts'
import { isVerificationReport } from './task-verification.ts'
import { isThinkingLevel } from './thinking.ts'
import { hasCode, isRecord } from './guards.ts'

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function timeout(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647
  )
}

function profile(value: unknown): value is AgentProfile {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.thinking === undefined || isThinkingLevel(value.thinking)) &&
    (value.effort === undefined || nonempty(value.effort)) &&
    typeof value.instructions === 'string' &&
    strings(value.tools) &&
    [
      'extensions',
      'skills',
      'skillSnapshot',
      'initialSkills',
      'extensionSnapshot',
      'nativeToolSnapshot',
      'toolInventory',
      'mcpServers',
      'disallowedTools'
    ].every((key) => value[key] === undefined || strings(value[key])) &&
    (value.mcp === undefined || typeof value.mcp === 'boolean') &&
    timeout(value.timeoutMs)
  )
}

function input(value: unknown): value is TaskInput {
  return (
    isRecord(value) &&
    typeof value.prompt === 'string' &&
    ['agent_name', 'description', 'model'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string'
    ) &&
    (value.effort === undefined || nonempty(value.effort)) &&
    (value.skills === undefined || strings(value.skills)) &&
    (value.run_in_background === undefined || typeof value.run_in_background === 'boolean')
  )
}

function legacyVerification(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => ['agentSettled', 'stopReason', 'toolErrors'].includes(key)) &&
    value.agentSettled === true &&
    typeof value.stopReason === 'string' &&
    value.stopReason.length > 0 &&
    typeof value.toolErrors === 'number' &&
    Number.isSafeInteger(value.toolErrors) &&
    value.toolErrors >= 0
  )
}

function task(value: unknown): value is TaskRecord {
  if (!isRecord(value)) {
    return false
  }
  const requiredStrings = [
    'task_id',
    'session_id',
    'parent_id',
    'childSessionPath',
    'description',
    'agent_name',
    'created_at',
    'output'
  ]
  const optionalStrings = ['started_at', 'finished_at', 'final_text', 'error', 'cancel_reason']
  return (
    requiredStrings.every((key) => typeof value[key] === 'string') &&
    optionalStrings.every((key) => value[key] === undefined || typeof value[key] === 'string') &&
    (value.parent_task_id === undefined ||
      (isFactName(value.parent_task_id) && value.parent_task_id !== value.task_id)) &&
    (value.execution_mode === undefined ||
      (typeof value.execution_mode === 'string' &&
        ['foreground', 'background', 'append'].includes(value.execution_mode))) &&
    profile(value.profile) &&
    input(value.input) &&
    (value.verification === undefined || isVerificationReport(value.verification)) &&
    (value.legacyVerification === undefined || legacyVerification(value.legacyVerification)) &&
    (value.sub_turn_id === undefined || isTurnId(value.sub_turn_id, value.task_id)) &&
    (value.event_count === undefined || isEventCount(value.event_count)) &&
    ['requested_agent_name', 'resolved_agent_name'].every(
      (key) => value[key] === undefined || isFactName(value[key])
    ) &&
    typeof value.status === 'string' &&
    [...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].some(
      (status) => status === value.status
    ) &&
    typeof value.cursor === 'number' &&
    Number.isSafeInteger(value.cursor) &&
    value.cursor >= 0 &&
    typeof value.notification_pending === 'boolean' &&
    typeof value.notify_completion === 'boolean' &&
    (value.ownedCommandCleanupPending === undefined || value.ownedCommandCleanupPending === true) &&
    (value.mode === undefined ||
      (typeof value.mode === 'string' &&
        ['activated', 'steered', 'duplicate'].includes(value.mode))) &&
    (value.accepted === undefined || typeof value.accepted === 'boolean') &&
    (value.stopError === undefined ||
      (isRecord(value.stopError) &&
        typeof value.stopError.code === 'string' &&
        typeof value.stopError.message === 'string')) &&
    (value.usage === undefined ||
      (isRecord(value.usage) &&
        Object.values(value.usage).every((amount) => typeof amount === 'number')))
  )
}

function state(value: unknown): value is TaskState {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.parentId === 'string' &&
    Array.isArray(value.tasks) &&
    value.tasks.every(task) &&
    isRecord(value.requests) &&
    Object.values(value.requests).every((id) => typeof id === 'string') &&
    (value.cleanupConfirmed === undefined ||
      (strings(value.cleanupConfirmed) &&
        new Set(value.cleanupConfirmed).size === value.cleanupConfirmed.length &&
        value.cleanupConfirmed.every(
          (id) =>
            Array.isArray(value.tasks) &&
            value.tasks.some(
              (item: unknown) =>
                task(item) && item.task_id === id && item.stopError?.code === 'CHILD_CLEANUP_FAILED'
            )
        )))
  )
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !hasCode(error, 'ESRCH')
  }
}

export class TaskStore {
  readonly rootDir: string
  readonly parentId: string
  readonly dir: string
  readonly file: string
  private tail: Promise<void>
  private lockPath?: string

  constructor(rootDir: string, parentId: string) {
    this.rootDir = resolve(rootDir)
    this.parentId = parentId
    this.dir = join(this.rootDir, createHash('sha256').update(parentId).digest('hex'))
    this.file = join(this.dir, 'tasks.json')
    this.tail = Promise.resolve()
  }

  async init(): Promise<TaskState> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    await chmod(this.rootDir, 0o700)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
    const lockDir = join(this.dir, 'owners')
    await mkdir(lockDir, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, 'EEXIST')) {
        throw error
      }
    })
    // Unique candidates avoid deleting a successor's lock during stale-owner recovery.
    this.lockPath = join(lockDir, `${process.pid}-${randomUUID()}.lock`)
    const handle = await open(this.lockPath, 'wx', 0o600)
    await handle.close()
    try {
      for (const name of await readdir(lockDir)) {
        const path = join(lockDir, name)
        if (path === this.lockPath) {
          continue
        }
        const match = /^(\d+)-[a-f0-9-]+\.lock$/.exec(name)
        if (!match || alive(Number(match[1]))) {
          throw new Error('Parent already has an active task owner')
        }
        // oxlint-disable-next-line no-await-in-loop -- Recover stale locks in order before reading task state.
        await unlink(path).catch((error: unknown) => {
          if (!hasCode(error, 'ENOENT')) {
            throw error
          }
        })
      }
      let loaded: unknown
      try {
        loaded = JSON.parse(await readFile(this.file, 'utf8'))
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) {
          throw error
        }
      }
      if (
        loaded &&
        (!isRecord(loaded) || loaded.parentId !== this.parentId || loaded.version !== 1)
      ) {
        throw new Error('Task store owner or version mismatch')
      }
      // The original plugin used this field for execution facts, not review verdicts.
      if (isRecord(loaded) && Array.isArray(loaded.tasks)) {
        for (const storedTask of loaded.tasks) {
          if (
            isRecord(storedTask) &&
            storedTask.legacyVerification === undefined &&
            legacyVerification(storedTask.verification)
          ) {
            storedTask.legacyVerification = storedTask.verification
            delete storedTask.verification
          }
        }
      }
      if (loaded !== undefined && loaded !== null && !state(loaded)) {
        throw new Error('Invalid task store state')
      }
      return loaded ?? { version: 1, parentId: this.parentId, tasks: [], requests: {} }
    } catch (error) {
      await this.close()
      throw error
    }
  }

  save(nextState: TaskState): Promise<void> {
    const text = JSON.stringify(nextState)
    const operation = this.tail.then(async () => {
      if (!this.lockPath) {
        throw new Error('Task store is closed')
      }
      const temporary = join(this.dir, `.tasks-${randomUUID()}.tmp`)
      let handle: FileHandle | undefined
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(text)
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temporary, this.file)
      } finally {
        await handle?.close()
        await unlink(temporary).catch((error: unknown) => {
          if (!hasCode(error, 'ENOENT')) {
            throw error
          }
        })
      }
    })
    this.tail = operation.catch(() => {})
    return operation
  }

  async close(): Promise<void> {
    await this.tail
    if (this.lockPath) {
      await unlink(this.lockPath).catch((error: unknown) => {
        if (!hasCode(error, 'ENOENT')) {
          throw error
        }
      })
      this.lockPath = undefined
    }
  }
}
