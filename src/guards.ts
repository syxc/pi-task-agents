/** Arrays are excluded so list payloads never pass as record-shaped boundary data. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Closed unions fail typecheck here when a new variant is added without handling it. */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: ${String(value)}`)
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
