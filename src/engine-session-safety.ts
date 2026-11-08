import { cloneJson, freeze } from './engine-helpers.ts'
import { normalizeTaskError } from './vendor/mcode-background-task/errors.ts'
import type { AgentProfile, ChildSession, TaskRecord, TaskState } from './types.ts'

const cleanupFailed = 'CHILD_CLEANUP_FAILED'
const failure = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code, status: 409 })

// Restored resource authority and unresolved descendant cleanup belong to the session, not the model turn.
export class SessionSafety {
  private readonly restored = new Set<string>()
  private readonly unresolved = new Map<string, string>()
  private readonly orphaned = new Set<string>()
  private state?: TaskState

  restore(state: TaskState): void {
    this.state = state
    const confirmed = new Set(this.state.cleanupConfirmed)
    for (const task of state.tasks) {
      this.restored.add(task.session_id)
      if (task.stopError?.code === cleanupFailed && !confirmed.has(task.task_id)) {
        this.unresolved.set(task.session_id, task.stopError.message)
        this.orphaned.add(task.session_id)
      }
      if (task.ownedCommandCleanupPending) {
        this.orphaned.add(task.session_id)
      }
    }
  }

  publicStopError(task: TaskRecord): TaskRecord['stopError'] {
    return task.status === 'canceled' && task.stopError?.code === cleanupFailed
      ? { ...task.stopError, code: 'TASK_STOP_FAILED' }
      : task.stopError
  }

  get quarantined(): boolean {
    return this.unresolved.size > 0
  }
  retains(sessionId: string): boolean {
    return this.unresolved.has(sessionId)
  }

  assertDispatch(): void {
    const message = this.unresolved.values().next().value
    if (message !== undefined) {
      throw failure(cleanupFailed, `Owner quarantined: ${message}`)
    }
  }

  continuation(task: TaskRecord): AgentProfile {
    if (this.restored.has(task.session_id) && task.profile.skillSnapshot === undefined) {
      if (task.profile.skills?.length !== 0) {
        throw failure(
          'LEGACY_RESOURCE_SNAPSHOT_REQUIRED',
          'Cannot resume this legacy child session: its creation-time Skill upper bound is unknown. Start a new task.'
        )
      }
      // Only an explicitly empty selector proves a historical empty upper bound.
      task.profile = freeze({ ...cloneJson(task.profile), skillSnapshot: [] })
    }
    return task.profile
  }

  record(task: TaskRecord, error: unknown, force = false): boolean {
    if (
      !force &&
      (typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== cleanupFailed)
    ) {
      return false
    }
    task.stopError = { code: cleanupFailed, message: normalizeTaskError(error).message }
    task.error = task.stopError.message
    this.unresolved.set(task.session_id, task.stopError.message)
    if (this.state?.cleanupConfirmed) {
      const ids = new Set(
        this.state.tasks
          .filter((item) => item.session_id === task.session_id)
          .map((item) => item.task_id)
      )
      this.state.cleanupConfirmed = this.state.cleanupConfirmed.filter((id) => !ids.has(id))
    }
    return true
  }

  async dispose(
    sessions: Map<string, { child?: ChildSession }>,
    tasks: TaskRecord[]
  ): Promise<Set<string>> {
    const confirmed = new Set<string>()
    await Promise.all(
      [...sessions].map(async ([id, session]) => {
        // A new or empty child cannot certify effects owned by a previous process.
        if (!session.child || this.orphaned.has(id)) {
          return
        }
        try {
          await session.child.dispose()
          confirmed.add(id)
        } catch (error) {
          const task = tasks.findLast((item) => item.session_id === id)
          if (task) {
            this.record(task, error, true)
          }
        }
      })
    )
    return confirmed
  }

  confirmDisposed(sessions: Set<string>, tasks: TaskRecord[]): boolean {
    const confirmed = new Set(this.state?.cleanupConfirmed)
    const before = confirmed.size
    let markerCleared = false
    for (const task of tasks) {
      if (sessions.has(task.session_id) && !this.orphaned.has(task.session_id)) {
        if (task.ownedCommandCleanupPending) {
          delete task.ownedCommandCleanupPending
          markerCleared = true
        }
        if (task.stopError?.code === cleanupFailed) {
          confirmed.add(task.task_id)
        }
      }
    }
    if (this.state && confirmed.size !== before) {
      this.state.cleanupConfirmed = [...confirmed]
    }
    for (const id of sessions) {
      if (!this.orphaned.has(id)) {
        this.unresolved.delete(id)
      }
    }
    return markerCleared || confirmed.size !== before
  }
}
