import { aborted } from './engine-helpers.ts'

interface OutputRuntime {
  cursors: Map<string, number>
  reads: Map<string, Promise<unknown>>
}

// A process-local registry survives owner changes and module reloads, but never a process restart.
const key = Symbol.for('pi-task-agents.output-runtime.v1')
const processState = globalThis as typeof globalThis & { [key: symbol]: OutputRuntime | undefined }
const runtime = (processState[key] ??= { cursors: new Map(), reads: new Map() })

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
        const output = await read(runtime.cursors.get(cursorKey) ?? 0)
        aborted(signal)
        // A committed cursor must be accompanied by a delivered result.
        runtime.cursors.set(cursorKey, output.next_offset)
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
