import { normalizeTaskError } from './vendor/mcode-background-task/errors.ts'
import type { TaskRecord } from './types.ts'
import { assertNever } from './guards.ts'

export interface TaskRunOutcome {
  status: 'succeeded' | 'failed' | 'aborted'
  finalText?: string
  errorMessage?: string
}

export type TaskTerminalOutcome = TaskRunOutcome | { failure: unknown }

export interface TaskTerminalProjection {
  status: 'succeeded' | 'failed' | 'canceled'
  outputText: string
  summary?: string
  lastError?: ReturnType<typeof normalizeTaskError>
}

// Mirrors local-runtime/background-task/terminal.ts. The runner outcome, not the row status, selects the text.
export function toTerminalProjection(result: TaskTerminalOutcome): TaskTerminalProjection {
  if ('failure' in result) {
    return {
      status: 'failed',
      outputText: `Background task failed: ${failureMessage(result.failure)}`,
      lastError: normalizeTaskError(result.failure, 'TASK_FAILED')
    }
  }
  const body = (failureText: string): Pick<TaskTerminalProjection, 'outputText' | 'summary'> => ({
    outputText: `${result.finalText ?? ''}${failureText}`,
    ...(result.finalText === undefined ? {} : { summary: result.finalText })
  })
  switch (result.status) {
    case 'succeeded':
      return { status: 'succeeded', ...body('') }
    case 'aborted':
    case 'failed':
      return {
        status: result.status === 'aborted' ? 'canceled' : 'failed',
        ...body(
          `\n\n[${result.status}] ${result.errorMessage ?? 'Local background task did not complete.'}`
        ),
        lastError: {
          message: result.errorMessage ?? result.status,
          code: result.status === 'aborted' ? 'TASK_CANCELED' : 'TASK_FAILED'
        }
      }
    default:
      return assertNever(result.status, 'Unexpected task outcome status')
  }
}

function returnedStatus(value: unknown): TaskRunOutcome['status'] | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const marker = value as { kind?: unknown; status?: unknown }
  return marker.kind === 'returned' &&
    (marker.status === 'succeeded' || marker.status === 'failed' || marker.status === 'aborted')
    ? marker.status
    : undefined
}

export function runnerOutcome(value: unknown): TaskRunOutcome {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid child runner result')
  }
  const result = value as { outcome?: unknown; text?: unknown }
  const status = returnedStatus(result.outcome)
  if (status === undefined || (result.text !== undefined && typeof result.text !== 'string')) {
    // A backend that omits or mistypes provenance must fail closed; never infer success.
    throw new Error('Invalid child runner outcome')
  }
  return { status, ...(result.text === undefined ? {} : { finalText: result.text }) }
}

export function exceptionOutcome(
  background: boolean,
  error: unknown,
  partialResult?: unknown,
  shutdownReason?: string
): TaskTerminalOutcome {
  // Only explicit backend provenance can classify a rejection as a normal failed/aborted return.
  if (typeof partialResult === 'object' && partialResult !== null) {
    const result = partialResult as { outcome?: unknown; text?: string }
    const status = returnedStatus(result.outcome)
    if (status !== undefined) {
      return {
        status,
        errorMessage: failureMessage(error),
        ...(result.text === undefined ? {} : { finalText: result.text })
      }
    }
  }
  // Background shutdown catches normalize only true exceptions; a captured normal return wins first.
  if (shutdownReason !== undefined) {
    return { status: 'aborted', errorMessage: shutdownReason }
  }
  // The upstream foreground caller normalizes a true exception before calling the shared writer.
  return background ? { failure: error } : { status: 'failed', errorMessage: failureMessage(error) }
}

export function appendTerminalOutput(
  task: TaskRecord,
  outcome: TaskTerminalOutcome
): TaskTerminalProjection {
  const projection = toTerminalProjection(outcome)
  task.output += projection.outputText
  return projection
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
