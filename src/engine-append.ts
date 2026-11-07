import { normalizeTaskError } from './vendor/mcode-background-task/errors.ts'
import type {
  ChildSession,
  TaskRecord,
  TaskRequestOptions,
  TaskState,
  TaskSummary
} from './types.ts'

interface AppendRuntime {
  accepting: boolean
  started?: Promise<ChildSession>
  done?: Promise<void>
  delivery?: Promise<void>
  stopReason?: string
}

interface AppendHost {
  parentId: string
  state(): TaskState
  assertAdmission(): void
  storageError(): unknown
  runtimes: ReadonlyMap<string, AppendRuntime>
  request(
    key: string | undefined,
    fn: (key?: string) => Promise<TaskSummary>,
    duplicate: (result: TaskSummary) => TaskSummary
  ): Promise<TaskSummary>
  queued(task: TaskRecord, content: string, key?: string): Promise<void>
  enqueue(task: TaskRecord, content: string, key?: string): Promise<TaskSummary>
  reserve(task: TaskRecord, key?: string): Promise<() => Promise<boolean>>
  pump(): void
  changed(task: TaskRecord): void
  summary(task: TaskRecord): TaskSummary
}

function failure(code: string, status: number, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code, status })
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(
      failure('TASK_APPEND_ABORTED', 409, 'task_append was aborted before Turn admission.'),
      { name: 'AbortError' }
    )
  }
}

function rejected(error: unknown): unknown {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    'status' in error &&
    typeof error.status === 'number'
  ) {
    return error
  }
  return failure('TASK_APPEND_REJECTED', 409, normalizeTaskError(error).message, error)
}

export async function appendTask(
  host: AppendHost,
  taskId: string,
  content: string,
  { requestId, signal }: TaskRequestOptions
): Promise<TaskSummary> {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw failure('INVALID_ARGUMENT', 400, 'task_append requires a task_id.')
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw failure('INVALID_ARGUMENT', 400, 'Task content must not be empty after trimming')
  }
  taskId = taskId.trim()
  content = content.trim()
  aborted(signal)
  try {
    return await host.request(
      requestId && `append:${taskId}:${requestId}`,
      async (key) => {
        host.assertAdmission()
        aborted(signal)
        const tasks = host.state().tasks
        const original = tasks.find(
          (task) => task.task_id === taskId && task.parent_id === host.parentId
        )
        if (!original) {
          throw failure('TASK_NOT_FOUND', 404, 'Unknown task for this parent')
        }
        const task = tasks.findLast((item) => item.session_id === original.session_id)!
        if (task.status === 'stopping') {
          throw rejected(new Error('Task is stopping'))
        }
        if (task.status === 'queued') {
          await host.queued(task, content, key)
          host.changed(task)
          const result = host.summary(task)
          host.pump()
          return result
        }
        const runtime = host.runtimes.get(task.task_id)
        if (runtime?.accepting) {
          let release!: () => void
          const turnId = task.sub_turn_id
          const active = () =>
            host.runtimes.get(task.task_id) === runtime &&
            runtime.accepting &&
            task.status === 'running' &&
            task.sub_turn_id === turnId
          // Keep the existing delivery reservation through persistence, recheck, and delivery.
          runtime.delivery = new Promise((resolve) => {
            release = resolve
          })
          try {
            let child: ChildSession | undefined
            try {
              child = await runtime.started!
            } catch (error) {
              if (runtime.stopReason) {
                throw rejected(error)
              }
              aborted(signal)
              host.assertAdmission()
              if (runtime.accepting) {
                throw error
              }
            }
            aborted(signal)
            if (runtime.stopReason) {
              throw rejected(new Error('Task is stopping'))
            }
            if (child && active()) {
              const compensate = await host.reserve(task, key)
              try {
                host.assertAdmission()
                aborted(signal)
              } catch (error) {
                await compensate()
                throw error
              }
              if (!active() || runtime.stopReason) {
                const removed = await compensate()
                if (runtime.stopReason) {
                  throw rejected(new Error('Task is stopping'))
                }
                if (!removed) {
                  return { ...host.summary(task), mode: 'duplicate', accepted: true }
                }
              } else {
                let delivered = false
                try {
                  await child.steer(content)
                  delivered = true
                } catch (error) {
                  // A throw after entering the SDK is not proof that nothing was enqueued.
                  if (
                    typeof error !== 'object' ||
                    error === null ||
                    !('steerAccepted' in error) ||
                    error.steerAccepted !== false
                  ) {
                    throw error
                  }
                  const removed = await compensate()
                  aborted(signal)
                  if (runtime.stopReason || active()) {
                    throw rejected(error)
                  }
                  if (!removed) {
                    return { ...host.summary(task), mode: 'duplicate', accepted: true }
                  }
                }
                if (delivered) {
                  host.changed(task)
                  return host.summary(task)
                }
              }
            }
          } finally {
            release()
            runtime.delivery = undefined
          }
        }
        await runtime?.done
        aborted(signal)
        return host.enqueue(task, content, key)
      },
      (result) => ({ ...result, mode: 'duplicate', accepted: true })
    )
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      'status' in error &&
      typeof error.status === 'number'
    ) {
      throw error
    }
    if (host.storageError() !== undefined) {
      throw failure('TASK_APPEND_PERSIST_FAILED', 500, normalizeTaskError(error).message, error)
    }
    throw error
  }
}
