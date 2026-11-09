import type { TaskInput } from './types.ts'

/**
 * Only JSON-safe values survive this clone; undefined members, Date, Map, and cycles do not.
 * Persisted task records and their summary projections are JSON data by contract.
 */
export const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('Request aborted'), { name: 'AbortError' })
  }
}

export function trimmedContent(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) {
    throw new Error('Task content must not be empty after trimming')
  }
  return trimmed
}

export function normalizeTaskInput(input: TaskInput): TaskInput {
  const description = input.description?.replace(/\s+/gu, ' ').trim()
  if (!description || Array.from(description).length > 50) {
    throw new Error('Task description must contain 1-50 Unicode characters after normalization')
  }
  if (typeof input.prompt !== 'string') {
    // oxlint-disable-next-line unicorn/prefer-type-error -- Preserve the existing public Error type during this lint-only change.
    throw new Error('Task prompt must be a string')
  }
  const result = { ...input, description }
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills) || input.skills.some((name) => typeof name !== 'string')) {
      throw new Error('Task skills must be an array of Skill names')
    }
    const skills = [...new Set(input.skills.map((name) => name.trim().normalize('NFKC')))]
    if (
      skills.some(
        (name) =>
          !name ||
          name === '.' ||
          name === '..' ||
          name.includes('/') ||
          name.includes('\\') ||
          name.includes(':')
      )
    ) {
      throw new Error('Task skills must contain names, not paths')
    }
    result.skills = skills
  }
  for (const field of ['model', 'effort', 'agent_name'] as const) {
    const value = input[field]?.trim()
    if (value === '') {
      throw new Error(`Task ${field} must not be blank`)
    }
    if (value !== undefined) {
      Object.assign(result, { [field]: value })
    }
  }
  return result
}

// Return true for a matching change and false for timeout. Each exit removes its listener and timer.
export async function waitForChange({
  waiters,
  predicate,
  timeout,
  signal
}: {
  waiters: Set<() => void>
  predicate: () => boolean
  timeout?: number
  signal?: AbortSignal
}): Promise<boolean> {
  aborted(signal)
  if (predicate()) {
    return true
  }
  return new Promise<boolean>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      waiters.delete(wake)
      signal?.removeEventListener('abort', onAbort)
    }
    const wake = () => {
      if (!predicate()) {
        return
      }
      cleanup()
      resolve(true)
    }
    const onAbort = () => {
      cleanup()
      try {
        aborted(signal)
      } catch (error) {
        reject(error)
      }
    }
    waiters.add(wake)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeout !== undefined) {
      timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeout)
    }
    if (signal?.aborted) {
      onAbort()
    } else {
      wake()
    }
  })
}
