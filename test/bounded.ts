import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

/** Bounds fixture cleanup so one stuck operation cannot stall the whole test process. */
export async function bounded<T>(
  operation: Promise<T>,
  ms = 2500,
  label = 'operation'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Polls one transition at a time; the deadline keeps a stuck fixture inside the test bound. */
export async function until<T>(
  check: () => T | Promise<T>,
  label = 'Condition',
  timeoutMs = 2500
): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Observe each transition before polling again.
    const result = await check()
    if (result) {
      return result as NonNullable<T>
    }
    assert.ok(Date.now() < end, label)
    // oxlint-disable-next-line no-await-in-loop -- Bound each poll so a stuck fixture fails promptly.
    await delay(5)
  }
}
