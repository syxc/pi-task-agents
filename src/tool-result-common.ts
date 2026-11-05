export interface TaskToolResult {
  tool_name: string;
  text: string;
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export function projectedResult(
  toolName: string, text: string, details: Record<string, unknown>, isError = false,
): TaskToolResult {
  return { tool_name: toolName, text, content: [{ type: 'text', text }], details,
    ...(isError ? { isError: true } : {}) };
}

export function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function notFound(toolName: string, taskId: string, extra: Record<string, unknown> = {}): TaskToolResult {
  return projectedResult(toolName, `<task_error>Local background task not found: ${taskId}</task_error>`,
    { task_id: taskId, status: 'not_found', ...extra }, true);
}
