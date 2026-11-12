import type { AdmissionReceipt, TaskInput, TaskSummary } from './types.ts'
import {
  escapeAttribute,
  failureResult,
  projectedResult,
  type CodedFailure,
  type TaskToolResult
} from './tool-result-common.ts'
import { verificationText } from './task-verification.ts'
import { taskProgressText } from './task-presentation.ts'

export function taskProgressResult(task: TaskSummary): TaskToolResult {
  return projectedResult('task', taskProgressText(task), {
    task_id: task.task_id,
    session_id: task.session_id,
    agent_name: task.agent_name,
    status: task.status,
    ...(task.cleanup_pending ? { cleanup_pending: true } : {})
  })
}

// Project persisted source facts only; legacy records may omit newer fields.
export type TaskRunFacts = Pick<
  TaskSummary,
  | 'task_id'
  | 'session_id'
  | 'status'
  | 'agent_name'
  | 'final_text'
  | 'error'
  | 'cancel_reason'
  | 'sub_turn_id'
  | 'event_count'
  | 'resolved_agent_name'
  | 'requested_agent_name'
  | 'verification'
>

export function formatParentReport(
  task: TaskRunFacts,
  requestedAgentName: string,
  status: string,
  errorMessage?: string
): string {
  return [
    `run_status: ${status}`,
    `requested_agent_name: ${requestedAgentName}`,
    `resolved_agent_name: ${task.resolved_agent_name ?? 'missing'}`,
    ...(task.verification ? [verificationText(task.verification)] : []),
    'final_text:',
    task.final_text ?? '',
    `error_message: ${errorMessage ?? ''}`
  ].join('\n')
}

export function taskResult(
  task: TaskRunFacts,
  input: Pick<TaskInput, 'agent_name' | 'run_in_background'>
): TaskToolResult {
  const handles =
    `${task.task_id ? ` task_id="${escapeAttribute(task.task_id)}"` : ''}` +
    `${task.session_id ? ` session_id="${escapeAttribute(task.session_id)}"` : ''}`
  const details = {
    agent_name: input.agent_name,
    ...(task.task_id ? { task_id: task.task_id } : {}),
    ...(task.session_id ? { sub_session_id: task.session_id } : {}),
    ...(task.sub_turn_id ? { sub_turn_id: task.sub_turn_id } : {})
  }
  if (input.run_in_background === true) {
    const started = ['queued', 'running', 'succeeded'].includes(task.status)
    const text = started
      ? `<task_background${handles}>\nStarted background task ${task.task_id}. The owning conversation will automatically resume when it finishes; use task_query/task_output to inspect it early and task_stop to cancel it.\n</task_background>`
      : `<task_error${handles}>${task.error ?? 'Local background task failed to start'}</task_error>`
    return projectedResult(
      'task',
      text,
      { ...details, status: started ? 'started' : 'failed' },
      !started
    )
  }
  const status =
    task.status === 'canceled' ? 'aborted' : task.status === 'succeeded' ? 'succeeded' : 'failed'
  const failed = status !== 'succeeded'
  const errorMessage = failed
    ? (task.error ?? task.cancel_reason ?? 'Agent task failed')
    : undefined
  const tag = failed ? 'task_error' : 'task_result'
  const requestedAgentName = task.requested_agent_name ?? input.agent_name
  const text = `<${tag}${handles}>\n${formatParentReport(task, requestedAgentName ?? '', status, errorMessage)}\n</${tag}>`
  return projectedResult(
    'task',
    text,
    {
      ...details,
      status,
      ...(task.event_count !== undefined ? { event_count: task.event_count } : {}),
      requested_agent_name: requestedAgentName,
      ...(task.resolved_agent_name ? { resolved_agent_name: task.resolved_agent_name } : {}),
      ...(task.final_text !== undefined ? { final_text: task.final_text } : {}),
      ...(task.verification ? { verification: task.verification } : {}),
      ...(failed ? { error_message: errorMessage } : {})
    },
    failed
  )
}

export function appendFailure(taskId: string, error: CodedFailure): TaskToolResult {
  return failureResult('task_append', 'task_append_error', taskId, error, { accepted: false })
}

export function appendResult(
  task: Pick<AdmissionReceipt, 'task_id' | 'mode' | 'accepted'>
): TaskToolResult {
  return projectedResult(
    'task_append',
    `<task_append task_id="${escapeAttribute(task.task_id)}" mode="${task.mode}" accepted="true" />`,
    { task_id: task.task_id, mode: task.mode, accepted: true }
  )
}
