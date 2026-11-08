import { taskIdFromTurnId, taskTurnId } from './vendor/mcode-adapters/task-turn-id.ts'
import { cloneJson, freeze } from './engine-helpers.ts'
import { normalizeTaskError } from './vendor/mcode-background-task/errors.ts'
import { isVerificationReport } from './task-verification.ts'
import { isRecord } from './guards.ts'
import type { AgentProfile, TaskInput, TaskRecord } from './types.ts'

export const isTurnId = (value: unknown, taskId: unknown): value is string =>
  typeof value === 'string' && typeof taskId === 'string' && taskIdFromTurnId(value) === taskId
export const isFactName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
export const isEventCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function admittedFacts(
  taskId: string,
  input: TaskInput,
  profile: AgentProfile,
  previous?: TaskRecord
): Pick<TaskRecord, 'sub_turn_id' | 'requested_agent_name' | 'resolved_agent_name'> {
  if (!isFactName(profile.name)) {
    throw new Error('Resolved child profile has no agent name')
  }
  const requested = input.agent_name?.trim()
  return {
    sub_turn_id: taskTurnId(taskId),
    resolved_agent_name: previous?.resolved_agent_name ?? profile.name,
    ...(requested ? { requested_agent_name: requested } : {})
  }
}

export function resolvedProfile(task: TaskRecord, profile: AgentProfile): void {
  if (!isFactName(profile.name)) {
    throw new Error('Resolved child profile has no agent name')
  }
  task.profile = freeze(cloneJson(profile))
  task.resolved_agent_name = profile.name
}

// Only backend-reported facts can become execution results. Streaming tool traces are not final text.
export function recordChildFacts(task: TaskRecord, source: unknown): void {
  if (!isRecord(source)) {
    return
  }
  if (
    source.subTurnId !== undefined &&
    (!isTurnId(source.subTurnId, task.task_id) ||
      (task.sub_turn_id !== undefined && source.subTurnId !== task.sub_turn_id))
  ) {
    throw new Error('Child result does not match its admitted sub-turn ID')
  }
  if (source.eventCount !== undefined && !isEventCount(source.eventCount)) {
    throw new Error('Invalid child event count')
  }
  if (source.resolvedAgentName !== undefined && !isFactName(source.resolvedAgentName)) {
    throw new Error('Invalid resolved child agent name')
  }
  if (source.text !== undefined && typeof source.text !== 'string') {
    throw new Error('Invalid child final text')
  }
  if (source.verification !== undefined && !isVerificationReport(source.verification)) {
    throw new Error('Invalid child verification report')
  }
  if (
    source.usage !== undefined &&
    (!isRecord(source.usage) ||
      !Object.values(source.usage).every(
        (amount) => typeof amount === 'number' && Number.isFinite(amount)
      ))
  ) {
    throw new Error('Invalid child usage')
  }
  if (source.subTurnId !== undefined) {
    task.sub_turn_id = source.subTurnId
  }
  if (source.eventCount !== undefined) {
    task.event_count = source.eventCount
  }
  if (source.resolvedAgentName !== undefined) {
    task.resolved_agent_name = source.resolvedAgentName
  }
  if (source.text !== undefined) {
    task.final_text = source.text
  }
  if (source.verification !== undefined) {
    task.verification = cloneJson(source.verification)
  }
  if (source.usage !== undefined) {
    task.usage = cloneJson(source.usage) as Record<string, number>
  }
}

export function recordChildFailure(
  task: TaskRecord,
  error: unknown
): { message: string; partialResult?: unknown } {
  let message = normalizeTaskError(error).message
  if (isRecord(error) && error.partialResult !== undefined) {
    try {
      recordChildFacts(task, error.partialResult)
      return { message, partialResult: error.partialResult }
    } catch (invalidFacts) {
      message += `; ${normalizeTaskError(invalidFacts).message}`
    }
  }
  return { message }
}
