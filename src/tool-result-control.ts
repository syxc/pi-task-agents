import { createHash } from 'node:crypto'
import type { TaskOutput, TaskSummary } from './types.ts'
import { isActiveTaskStatus } from './vendor/mcode-background-task/status.ts'
import {
  failureResult,
  projectedResult,
  type CodedFailure,
  type TaskToolResult
} from './tool-result-common.ts'
import { verificationText } from './task-verification.ts'
import { taskElapsed } from './task-presentation.ts'

// Upstream lists at most the newest 100 tasks per query; unbounded lists would
// grow with every completed task and dominate the parent context.
const MAX_TASK_LIST_RESULTS = 100

function executionMode(task: TaskSummary): string | undefined {
  return (
    task.execution_mode ??
    (task.notify_completion === undefined
      ? undefined
      : task.notify_completion
        ? 'background'
        : 'foreground')
  )
}

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) {
    return
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function summarizeTask(task: TaskSummary): Record<string, unknown> {
  // Native query exposes session/parent/mode lineage, not Task-only run facts.
  const mode = executionMode(task)
  const created = timestamp(task.created_at)
  const ended = timestamp(task.finished_at)
  return {
    task_id: task.task_id,
    kind: 'subagent',
    status: task.status,
    output: undefined,
    timing: undefined,
    ...(task.stopError ? { stopError: task.stopError } : {}),
    ...(task.verification ? { verification: task.verification } : {}),
    ...(task.cleanup_pending ? { cleanup_pending: true } : {}),
    ...(task.activity ? { activity: task.activity } : {}),
    ...(task.session_id ? { session_id: task.session_id } : {}),
    parent_task_id: task.parent_task_id ?? null,
    ...(mode ? { execution_mode: mode } : {}),
    ...(task.description ? { description: task.description } : {}),
    ...(created !== undefined ? { created_at: created } : {}),
    ...(ended !== undefined ? { ended_at: ended } : {}),
    ...(task.error !== undefined ? { last_error: task.error } : {})
  }
}

export function renderTask(task: TaskSummary): string {
  const mode = executionMode(task)
  const lineage = [
    ...(task.session_id ? [`session_id=${task.session_id}`] : []),
    ...(task.parent_task_id ? [`parent_task_id=${task.parent_task_id}`] : []),
    ...(mode ? [`execution_mode=${mode}`] : [])
  ]
  return (
    `- ${task.task_id} [subagent/${task.status}]${task.description ? ` ${task.description}` : ''}` +
    (lineage.length ? ` (${lineage.join(' ')})` : '') +
    (task.verification
      ? ` [verdict=${task.verification.modelVerdict ?? 'missing'}; file_change=${task.verification.fileChange}]`
      : '') +
    (taskElapsed(task) ? ` [elapsed=${taskElapsed(task)}]` : '') +
    (task.activity ? ` ${task.activity}` : '') +
    (task.cleanup_pending ? ' [cleanup pending]' : '') +
    (task.stopError?.message || task.error || task.cancel_reason
      ? `: ${task.stopError?.message ?? task.error ?? task.cancel_reason}`
      : '')
  )
}

export function queryResult(tasks: TaskSummary | TaskSummary[]): TaskToolResult {
  if (!Array.isArray(tasks)) {
    return projectedResult('task_query', renderTask(tasks), { task: summarizeTask(tasks) })
  }
  const ordered = [...tasks].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)
  )
  const visible = ordered.slice(0, MAX_TASK_LIST_RESULTS)
  return projectedResult(
    'task_query',
    visible.length
      ? visible.map(renderTask).join('\n')
      : 'No local background tasks in this session.',
    {
      count: visible.length,
      tasks: visible.map(summarizeTask),
      ...(ordered.length > visible.length ? { next_cursor: String(visible.length) } : {})
    }
  )
}

export function stopResult(task: TaskSummary, requestedId = task.task_id): TaskToolResult {
  const message = task.stopError
    ? `Stop failed for ${requestedId}: ${task.stopError.message}. Process cleanup could not be confirmed.`
    : `Task ${requestedId} is ${task.status}.`
  return projectedResult(
    'task_stop',
    `<task_stop status="${task.status}">\n${message}\n</task_stop>`,
    {
      task_id: requestedId,
      status: task.status,
      ...(task.stopError ? { stopError: task.stopError } : {})
    },
    !!task.stopError
  )
}

// Optional wait facts come directly from TaskOutput. Elapsed wall time is not
// proof that a read timed out rather than observing a state change.
export type OutputFacts = TaskOutput

export interface OutputWait {
  effective_wait_ms: number
  wait_ms_clamped: boolean
}

export function outputWait(requested = 0): OutputWait {
  return { effective_wait_ms: Math.min(requested, 30000), wait_ms_clamped: requested > 30000 }
}

export function outputFailure(
  taskId: string,
  error: CodedFailure,
  wait: OutputWait
): TaskToolResult {
  return failureResult('task_output', 'task_output_error', taskId, error, { ...wait })
}

export class OutputProjector {
  private lastRead?: { key: string; status: string; nextOffset: number }

  reset(): void {
    this.lastRead = undefined
  }

  result(
    read: OutputFacts,
    wait: OutputWait,
    parentId: string,
    signal?: AbortSignal,
    knownVerificationFingerprint?: string
  ): TaskToolResult {
    const truncated = read.truncated ?? read.has_more
    const cursor = [
      ...(read.next_offset === undefined ? [] : [`next_offset="${read.next_offset}"`]),
      ...(truncated === undefined ? [] : [`truncated="${truncated}"`]),
      ...(read.timed_out === undefined ? [] : [`timed_out="${read.timed_out}"`])
    ]
    const receipt = cursor.length ? `<task_output_cursor ${cursor.join(' ')} />\n` : ''
    const waitHint =
      signal?.aborted || !wait.wait_ms_clamped || read.timed_out !== true
        ? ''
        : '<task_output_hint>Your requested wait_ms exceeded 30000 ms and was capped at 30000 ms (30 seconds). This output read reached its wait limit; the background task was not stopped. Use wait_ms=30000 or less for future reads.</task_output_hint>\n'
    const hint = signal?.aborted ? '' : this.pollingHint(read, parentId)
    // Report values are strings or string arrays; sorted keys make identity independent of insertion order.
    const fingerprint = read.verification
      ? `sha256:${createHash('sha256')
          .update(JSON.stringify(read.verification, Object.keys(read.verification).sort()))
          .digest('hex')}`
      : undefined
    const verification = read.verification
      ? `<task_verification fingerprint="${fingerprint}" />\n` +
        (knownVerificationFingerprint === fingerprint
          ? '<task_output_hint>Verification text omitted: known_verification_fingerprint matches the current report. Omit that argument to read the full report at any valid offset. details.verification is unchanged.</task_output_hint>\n'
          : `${verificationText(read.verification)}\n`)
      : ''
    const text = `<task_output status="${read.status}">\n${receipt}${waitHint}${hint}${verification}${read.output || '(no output yet)'}\n</task_output>`
    return projectedResult('task_output', text, {
      task_id: read.task_id,
      status: read.status,
      timing: undefined,
      ...wait,
      ...(read.timed_out === undefined ? {} : { timed_out: read.timed_out }),
      ...(read.next_offset === undefined ? {} : { next_offset: read.next_offset }),
      ...(truncated === undefined ? {} : { truncated }),
      ...(read.final_text ? { summary: read.final_text } : {}),
      ...(read.verification ? { verification: read.verification } : {})
    })
  }

  private pollingHint(read: OutputFacts, parentId: string): string {
    const previous = this.lastRead
    this.reset()
    if (
      !isActiveTaskStatus(read.status) ||
      !Number.isSafeInteger(read.next_offset) ||
      read.next_offset < 0
    ) {
      return ''
    }
    const key = JSON.stringify([parentId, read.task_id])
    this.lastRead = { key, status: read.status, nextOffset: read.next_offset }
    if (
      previous?.key !== key ||
      previous.status !== read.status ||
      previous.nextOffset !== read.next_offset ||
      read.timed_out === true
    ) {
      return ''
    }
    const nextRead = JSON.stringify({
      task_id: read.task_id,
      offset: read.next_offset,
      wait_ms: 30000
    })
    return (
      '<task_output_hint>Task status and next_offset are unchanged since the previous read. ' +
      `To wait for new output, use task_output(${nextRead}). ` +
      'offset=0 replays existing output and can return immediately even with wait_ms. ' +
      'Avoid repeated immediate checks; continue independent work and wait for the completion notification when available.</task_output_hint>\n'
    )
  }
}
