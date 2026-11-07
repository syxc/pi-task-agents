export const DEFAULT_MAX_CONCURRENCY = 4
export const MAX_CONCURRENCY = 64

/** Resolve one owner's capacity without changing queue or cleanup accounting. */
export function resolveMaxConcurrency(
  value: unknown = DEFAULT_MAX_CONCURRENCY,
  path = 'Invalid maxConcurrency'
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CONCURRENCY
  ) {
    throw new Error(path + ': expected an integer from 1 to ' + MAX_CONCURRENCY)
  }
  return value
}
