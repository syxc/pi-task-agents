import { aborted } from './engine-helpers.ts'

interface OutputRuntime {
  cursors: Map<string, number>
  reads: Map<string, Promise<unknown>>
}

// A process-local registry survives owner changes and module reloads, but never a process restart.
const key = Symbol.for('pi-task-agents.output-runtime.v1')
const processState = globalThis as typeof globalThis & { [key: symbol]: OutputRuntime | undefined }
const runtime = (processState[key] ??= { cursors: new Map(), reads: new Map() })
// The registry is shared by every session in the process, so old tasks must not
// retain cursors indefinitely. An evicted task restarts from explicit or full reads.
const CURSOR_LIMIT = 4096
function readCursor(cursorKey: string): number | undefined {
  const value = runtime.cursors.get(cursorKey)
  if (value !== undefined) {
    runtime.cursors.delete(cursorKey)
    runtime.cursors.set(cursorKey, value)
  }
  return value
}
function commitCursor(cursorKey: string, offset: number): void {
  runtime.cursors.delete(cursorKey)
  runtime.cursors.set(cursorKey, offset)
  if (runtime.cursors.size > CURSOR_LIMIT) {
    const oldest = runtime.cursors.keys().next().value
    if (oldest !== undefined) {
      runtime.cursors.delete(oldest)
    }
  }
}

export class TaskOutputReads {
  private readonly owner: string

  constructor(owner: string) {
    this.owner = owner
  }

  automatic<T extends { next_offset: number }>(
    taskId: string,
    signal: AbortSignal | undefined,
    read: (offset: number) => Promise<T>
  ): Promise<T> {
    const cursorKey = JSON.stringify([this.owner, taskId])
    let committed = false
    const previous = runtime.reads.get(cursorKey) ?? Promise.resolve()
    const result = previous
      .catch(() => {})
      .then(async () => {
        aborted(signal)
        const output = await read(readCursor(cursorKey) ?? 0)
        aborted(signal)
        // Pi records an executed tool result even if the turn aborts afterwards,
        // so committing before returning cannot strand the result (upstream
        // readOutput commits at the same point).
        commitCursor(cursorKey, output.next_offset)
        committed = true
        return output
      })
    runtime.reads.set(cursorKey, result)
    const cleanup = () => {
      if (runtime.reads.get(cursorKey) === result) {
        runtime.reads.delete(cursorKey)
      }
    }
    result.then(cleanup, cleanup)
    if (!signal) {
      return result
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        if (committed) {
          return
        }
        try {
          aborted(signal)
        } catch (error) {
          reject(error)
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
      }
      result.then(
        (value: T) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
    })
  }
}
