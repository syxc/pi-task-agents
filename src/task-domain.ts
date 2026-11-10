import { createBackgroundTaskId } from './vendor/mcode-background-task/id.ts'
import {
  InvalidTaskStatusTransitionError,
  TaskNotFoundError,
  normalizeTaskError
} from './vendor/mcode-background-task/errors.ts'
import {
  canTransitionTaskStatus,
  isTerminalTaskStatus
} from './vendor/mcode-background-task/status.ts'
import type { TaskOutputReadOptions } from './vendor/mcode-background-task/types.ts'
import type { TaskRecord, TaskState, TaskStatus } from './types.ts'
import { utf8Output } from './utf8-output.ts'

export class TaskDomain {
  private readonly getState: () => TaskState

  constructor(getState: () => TaskState) {
    this.getState = getState
  }

  createId(): string {
    // Preserve the existing public UUID format while using the upstream generator.
    return createBackgroundTaskId().slice('bg_'.length)
  }

  transition(task: TaskRecord, status: TaskStatus): void {
    if (!canTransitionTaskStatus(task.status, status)) {
      throw new InvalidTaskStatusTransitionError(task.task_id, task.status, status)
    }
    task.status = status
  }

  async finish(task: TaskRecord, status: 'succeeded' | 'failed' | 'canceled'): Promise<void> {
    if (isTerminalTaskStatus(task.status)) {
      return
    }
    if (status === 'failed') {
      task.error = normalizeTaskError(task.error ?? 'Task failed').message
    }
    this.transition(task, status)
    task.finished_at = new Date().toISOString()
  }

  async readOutput(
    taskId: string,
    options: TaskOutputReadOptions
  ): Promise<{ content: string; nextOffset: number; truncated: boolean }> {
    const task = this.task(taskId)
    return utf8Output(Buffer.from(task.output), options.offset ?? 0, options.limitBytes)
  }

  private task(id: string): TaskRecord {
    const task = this.getState().tasks.find((item) => item.task_id === id)
    if (!task) {
      throw new TaskNotFoundError(id)
    }
    return task
  }
}
