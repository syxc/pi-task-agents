import type { TaskRecord, TaskState, TaskSummary } from './types.ts'

// One boundary owns serialization, durable receipts, and uncommitted reservations.
export class TaskAdmissions {
  readonly operations = new Map<string, Promise<TaskSummary>>()
  private readonly pending = new Set<string>()
  private gate: Promise<unknown> = Promise.resolve()

  exclusive<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    const result = this.gate.then(fn)
    this.gate = result.catch(() => {})
    return result
  }

  async settled(): Promise<void> {
    await this.gate
  }
  isPending(id: string): boolean {
    return this.pending.has(id)
  }

  request<T extends TaskSummary>(
    key: string | undefined,
    fn: (key?: string) => Promise<T>,
    lookup: (key: string) => TaskSummary | undefined,
    duplicate: (result: TaskSummary) => T
  ): Promise<T> {
    if (!key) {
      return this.exclusive(fn)
    }
    const existing = this.operations.get(key)
    if (existing) {
      return existing.then(duplicate)
    }
    const result = this.exclusive(() => {
      const cached = lookup(key)
      return cached ? duplicate(cached) : fn(key)
    })
    this.operations.set(key, result)
    result.catch(() => {}).finally(() => this.operations.delete(key))
    return result
  }

  async reserveSteering(
    state: TaskState,
    task: TaskRecord,
    key: string | undefined,
    persist: () => Promise<void>,
    poison: (error: unknown) => void
  ): Promise<() => Promise<boolean>> {
    const previous = { mode: task.mode, accepted: task.accepted }
    task.mode = 'steered'
    task.accepted = true
    if (key) {
      state.requests[key] = task.task_id
    }
    try {
      await persist()
    } catch (error) {
      poison(error || new Error('Steering receipt persistence failed'))
      throw error
    }
    return async () => {
      task.mode = previous.mode
      task.accepted = previous.accepted
      if (key) {
        delete state.requests[key]
      }
      try {
        await persist()
        return true
      } catch (error) {
        // A failed compensation keeps the ID receipt. Source permits at-most-once loss, not replay.
        task.mode = 'steered'
        task.accepted = true
        if (key) {
          state.requests[key] = task.task_id
        }
        poison(error || new Error('Steering receipt release failed'))
        return false
      }
    }
  }

  async appendQueued(
    state: TaskState,
    task: TaskRecord,
    content: string,
    key: string | undefined,
    persist: () => Promise<void>,
    poison: (error: unknown) => void
  ): Promise<void> {
    const previous = { prompt: task.input.prompt, mode: task.mode, accepted: task.accepted }
    this.pending.add(task.task_id)
    task.input.prompt += `\n${content}`
    task.mode = 'steered'
    task.accepted = true
    if (key) {
      state.requests[key] = task.task_id
    }
    try {
      await persist()
    } catch (error) {
      poison(error || new Error('Task append persistence failed'))
      task.input.prompt = previous.prompt
      task.mode = previous.mode
      task.accepted = previous.accepted
      if (key && state.requests[key] === task.task_id) {
        delete state.requests[key]
      }
      throw error
    } finally {
      this.pending.delete(task.task_id)
    }
  }

  async commit(
    state: TaskState,
    task: TaskRecord,
    key: string | undefined,
    persist: () => Promise<void>,
    poison: (error: unknown) => void
  ): Promise<void> {
    const id = task.task_id
    this.pending.add(id)
    state.tasks.push(task)
    if (key) {
      state.requests[key] = id
    }
    try {
      await persist()
    } catch (error) {
      // A failed write can have committed. Only a new owner may reconcile its receipt.
      poison(error || new Error('Task admission persistence failed'))
      const index = state.tasks.indexOf(task)
      if (index >= 0) {
        state.tasks.splice(index, 1)
      }
      if (key && state.requests[key] === id) {
        delete state.requests[key]
      }
      throw error
    } finally {
      this.pending.delete(id)
    }
  }
}
