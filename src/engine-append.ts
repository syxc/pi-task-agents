import { normalizeTaskError } from './vendor/mcode-background-task/errors.ts'
import { isAccepting, stopOf, type RuntimePhase } from './runtime-phase.ts'
import type {
  AdmissionMode,
  AdmissionReceipt,
  ChildSession,
  TaskRecord,
  TaskRequestOptions,
  TaskState,
  TaskSummary
} from './types.ts'

interface AppendRuntime {
  phase: RuntimePhase
  started?: Promise<ChildSession>
  done?: Promise<void>
  delivery?: Promise<void>
}

interface AppendHost {
  parentId: string
  state(): TaskState
  assertAdmission(): void
  storageError(): unknown
  runtimes: ReadonlyMap<string, AppendRuntime>
  request(
    key: string | undefined,
    fn: (key?: string) => Promise<AdmissionReceipt>,
    duplicate: (result: TaskSummary) => AdmissionReceipt
  ): Promise<AdmissionReceipt>
  queued(task: TaskRecord, content: string, key?: string): Promise<void>
  enqueue(task: TaskRecord, content: string, key?: string): Promise<TaskSummary>
  reserve(task: TaskRecord, key?: string): Promise<() => Promise<boolean>>
  pump(): void
  changed(task: TaskRecord): void
  summary(task: TaskRecord): TaskSummary
}

function receipt(summary: TaskSummary, mode: AdmissionMode): AdmissionReceipt {
  return { ...summary, mode, accepted: true }
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
): Promise<AdmissionReceipt> {
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
          throw failure('TASK_NOT_FOUND', 404, `Local background task not found: ${taskId}`)
        }
        const task = tasks.findLast((item) => item.session_id === original.session_id) ?? original
        if (task.status === 'stopping') {
          throw rejected(new Error('Task is stopping'))
        }
        if (task.status === 'queued') {
          await host.queued(task, content, key)
          host.changed(task)
          const result = receipt(host.summary(task), 'steered')
          host.pump()
          return result
        }
        const runtime = host.runtimes.get(task.task_id)
        if (runtime && isAccepting(runtime.phase)) {
          const started = runtime.started
          if (started === undefined) {
            throw rejected(new Error('Task runtime has no child session'))
          }
          let release!: () => void
          const turnId = task.sub_turn_id
          const active = () =>
            host.runtimes.get(task.task_id) === runtime &&
            isAccepting(runtime.phase) &&
            task.status === 'running' &&
            task.sub_turn_id === turnId
          // Keep the existing delivery reservation through persistence, recheck, and delivery.
          runtime.delivery = new Promise((resolve) => {
            release = resolve
          })
          try {
            let child: ChildSession | undefined
            try {
              child = await started
            } catch (error) {
              if (stopOf(runtime.phase)) {
                throw rejected(error)
              }
              aborted(signal)
              host.assertAdmission()
              if (isAccepting(runtime.phase)) {
                throw error
              }
            }
            aborted(signal)
            if (stopOf(runtime.phase)) {
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
              if (!active() || stopOf(runtime.phase)) {
                const removed = await compensate()
                if (stopOf(runtime.phase)) {
                  throw rejected(new Error('Task is stopping'))
                }
                if (!removed) {
                  return receipt(host.summary(task), 'duplicate')
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
                  if (stopOf(runtime.phase) || active()) {
                    throw rejected(error)
                  }
                  if (!removed) {
                    return receipt(host.summary(task), 'duplicate')
                  }
                }
                if (delivered) {
                  host.changed(task)
                  return receipt(host.summary(task), 'steered')
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
        return receipt(await host.enqueue(task, content, key), 'activated')
      },
      (result) => receipt(result, 'duplicate')
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
