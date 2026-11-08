export interface TaskToolResult {
  tool_name: string
  text: string
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
  isError?: boolean
}

export function projectedResult(
  toolName: string,
  text: string,
  details: Record<string, unknown>,
  isError = false
): TaskToolResult {
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details,
    ...(isError ? { isError: true } : {})
  }
}

export function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export interface CodedFailure {
  code: string
  status: number
  message: string
}

export function knownFailure(error: unknown): CodedFailure | undefined {
  if (!(error instanceof Error) || !('code' in error) || !('status' in error)) {
    return
  }
  return typeof error.code === 'string' && typeof error.status === 'number'
    ? { code: error.code, status: error.status, message: error.message }
    : undefined
}

export function failureResult(
  toolName: string,
  tag: string,
  taskId: string,
  error: CodedFailure,
  extra: Record<string, unknown> = {}
): TaskToolResult {
  const text = `<${tag} task_id="${escapeAttribute(taskId)}" code="${error.code}">${error.message}</${tag}>`
  return projectedResult(
    toolName,
    text,
    {
      task_id: taskId,
      code: error.code,
      status: error.status,
      ...extra,
      error_message: error.message
    },
    true
  )
}

export function notFound(
  toolName: string,
  taskId: string,
  extra: Record<string, unknown> = {}
): TaskToolResult {
  return projectedResult(
    toolName,
    `<task_error>Local background task not found: ${taskId}</task_error>`,
    { task_id: taskId, status: 'not_found', ...extra },
    true
  )
}
