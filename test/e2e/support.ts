export type JsonRecord = Record<string, unknown>
export type RpcEvent = JsonRecord & { type: string }

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string`)
  }
  return value
}
