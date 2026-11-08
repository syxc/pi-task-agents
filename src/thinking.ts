import type { ThinkingLevel } from './types.ts'

const values = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const satisfies readonly ThinkingLevel[]

export const thinkingLevels: readonly ThinkingLevel[] = Object.freeze(values)

const levels: readonly string[] = thinkingLevels

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && levels.includes(value)
