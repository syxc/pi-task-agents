import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFailure, appendResult, knownAppendFailure, taskResult } from '../src/tool-result-task.ts';
import { OutputProjector, outputWait, queryResult, stopResult } from '../src/tool-result-control.ts';
import { notFound } from '../src/tool-result-common.ts';

// Public task results expose execution facts, not host observation reports.
const base = {
  task_id: 't1', session_id: 's1', parent_id: 'parent', childSessionPath: '/private/s1.jsonl',
  status: 'succeeded', agent_name: 'worker', resolved_agent_name: 'worker', description: 'bounded work',
  created_at: '2025-01-01T00:00:00.000Z', finished_at: '2025-01-01T00:00:01.000Z',
  notify_completion: true, notification_pending: false, output_bytes: 4, final_text: 'done',
};
const report = `run_status: succeeded
requested_agent_name: worker
resolved_agent_name: worker
final_text:
done
error_message: `;

function exact(result, text, details, error = false) {
  assert.equal(result.text, text);
  assert.deepEqual(result.content, [{ type: 'text', text }]);
  assert.deepEqual(result.details, details);
  assert.equal(result.isError, error ? true : undefined);
}

test('foreground Task golden contains only task execution facts', () => {
  const result = taskResult({ ...base, event_count: 7, sub_turn_id: 'turn1' }, { agent_name: 'worker' });
  exact(result, `<task_result task_id="t1" session_id="s1">\n${report}\n</task_result>`, {
    agent_name: 'worker', status: 'succeeded', task_id: 't1', sub_session_id: 's1', sub_turn_id: 'turn1',
    event_count: 7, requested_agent_name: 'worker', resolved_agent_name: 'worker', final_text: 'done',
  });
  assert.equal(result.tool_name, 'task');
  for (const field of ['parent_id', 'childSessionPath', 'output_bytes', 'session_id', 'usage']) {
    assert.equal(Object.hasOwn(result.details, field), false);
  }
});

test('foreground failure golden retains partial text and omits missing execution facts', () => {
  const result = taskResult({ ...base, status: 'failed', final_text: 'partial', error: 'execution failed' }, { agent_name: 'worker' });
  exact(result, `<task_error task_id="t1" session_id="s1">
run_status: failed
requested_agent_name: worker
resolved_agent_name: worker
final_text:
partial
error_message: execution failed
</task_error>`, {
    agent_name: 'worker', task_id: 't1', sub_session_id: 's1', status: 'failed',
    requested_agent_name: 'worker', resolved_agent_name: 'worker', final_text: 'partial', error_message: 'execution failed',
  }, true);
  assert.equal(Object.hasOwn(result.details, 'event_count'), false);
  assert.equal(Object.hasOwn(result.details, 'sub_turn_id'), false);
  const aborted = taskResult({ ...base, status: 'canceled', error: 'request aborted' }, { agent_name: 'worker' });
  assert.equal(aborted.details.status, 'aborted');
  assert.match(aborted.text, /run_status: aborted/);
  const unresolved = taskResult({ ...base, agent_name: 'request-label', resolved_agent_name: undefined }, { agent_name: 'request-label' });
  assert.equal(Object.hasOwn(unresolved.details, 'resolved_agent_name'), false);
  assert.match(unresolved.text, /resolved_agent_name: missing/);
});

test('background receipt and background failure match upstream tags and admission detail shapes', () => {
  exact(taskResult({ ...base, status: 'queued' }, { agent_name: 'worker', run_in_background: true }),
    '<task_background task_id="t1" session_id="s1">\nStarted background task t1. The owning conversation will automatically resume when it finishes; use task_query/task_output to inspect it early and task_stop to cancel it.\n</task_background>',
    { agent_name: 'worker', status: 'started', task_id: 't1', sub_session_id: 's1' });
  exact(taskResult({ ...base, status: 'failed', error: 'launch failed' }, { agent_name: 'worker', run_in_background: true }),
    '<task_error task_id="t1" session_id="s1">launch failed</task_error>',
    { agent_name: 'worker', status: 'failed', task_id: 't1', sub_session_id: 's1' }, true);
});

test('Task attributes escape XML while raw reports and long final text remain unmodified', () => {
  const finalText = '😀'.repeat(50000) + '\n<untrusted evidence>';
  const result = taskResult({ ...base, task_id: 't&"', session_id: "s<'", final_text: finalText }, { agent_name: 'worker' });
  assert.ok(result.text.startsWith('<task_result task_id="t&amp;&quot;" session_id="s&lt;&apos;">'));
  assert.ok(result.text.includes(finalText));
  assert.equal(result.details.final_text, finalText);
});

test('query singleton/list/empty goldens expose only upstream summary fields', () => {
  const summary = { task_id: 't1', kind: 'subagent', status: 'succeeded', output: undefined, timing: undefined,
    session_id: 's1', parent_task_id: null, execution_mode: 'background', description: 'bounded work',
    created_at: 1735689600000, ended_at: 1735689601000 };
  const line = '- t1 [subagent/succeeded] bounded work (session_id=s1 execution_mode=background) [elapsed=1s]';
  exact(queryResult(base), line, { task: summary });
  exact(queryResult([base]), line, { count: 1, tasks: [summary] });
  exact(queryResult([]), 'No local background tasks in this session.', { count: 0, tasks: [] });
});

test('control not-found goldens use not_found instead of a generic error envelope', () => {
  for (const name of ['task_query', 'task_output', 'task_stop']) {
    const extra = name === 'task_output' ? outputWait(90000) : {};
    const result = notFound(name, 'missing', extra);
    exact(result, '<task_error>Local background task not found: missing</task_error>',
      { task_id: 'missing', status: 'not_found', ...extra }, true);
    assert.equal(result.tool_name, name);
  }
});

test('stop success and stop failure goldens preserve cleanup uncertainty', () => {
  exact(stopResult({ ...base, status: 'canceled' }),
    '<task_stop status="canceled">\nTask t1 is canceled.\n</task_stop>', { task_id: 't1', status: 'canceled' });
  const stopError = { code: 'TASK_STOP_FAILED', message: 'abort rejected' };
  exact(stopResult({ ...base, status: 'stopping', stopError }),
    '<task_stop status="stopping">\nStop failed for t1: abort rejected. Process cleanup could not be confirmed.\n</task_stop>',
    { task_id: 't1', status: 'stopping', stopError }, true);
});

test('append activated/steered/duplicate goldens contain admission only', () => {
  for (const mode of ['activated', 'steered', 'duplicate']) {
    exact(appendResult({ ...base, task_id: 't&1', mode, accepted: true }),
      `<task_append task_id="t&amp;1" mode="${mode}" accepted="true" />`,
      { task_id: 't&1', mode, accepted: true });
  }
  assert.throws(() => appendResult(base), /source-owned mode/);
});

test('append failure golden preserves source-owned codes/status and refuses to invent unknown codes', () => {
  const codes = { INVALID_ARGUMENT: 400, TASK_NOT_FOUND: 404, TASK_APPEND_FORBIDDEN: 403,
    TASK_APPEND_UNSUPPORTED: 409, TASK_APPEND_ABORTED: 409, TASK_CHILD_NOT_FOUND: 404,
    TASK_CHILD_INVALID: 409, TASK_CHILD_ARCHIVED: 409, TASK_CHILD_DELETING: 409,
    TASK_APPEND_REJECTED: 409, TASK_APPEND_UNAVAILABLE: 503, TASK_APPEND_PERSIST_FAILED: 500,
    TASK_APPEND_ACTIVE_TURN_UNMAPPED: 409 };
  for (const [code, status] of Object.entries(codes)) {
    const source = Object.assign(new Error('source-owned failure'), { code, status });
    const failure = knownAppendFailure(source);
    assert.deepEqual(failure, { code, status, message: 'source-owned failure' });
    exact(appendFailure('t1', failure),
      `<task_append_error task_id="t1" code="${code}">source-owned failure</task_append_error>`,
      { task_id: 't1', code, status, accepted: false, error_message: 'source-owned failure' }, true);
  }
  assert.equal(knownAppendFailure(new Error('storage problem')), undefined);
  assert.equal(knownAppendFailure(Object.assign(new Error('code without status'), { code: 'UNKNOWN' })), undefined);
});

test('output golden projects real wait/cursor/truncation facts and never labels failed-task reads as tool errors', () => {
  const output = new OutputProjector();
  const read = { ...base, status: 'failed', output: 'partial bytes', offset: 0, next_offset: 13,
    has_more: true, truncated: true, timed_out: false, final_text: 'partial summary' };
  exact(output.result(read, outputWait(100), 'parent'),
    '<task_output status="failed">\n<task_output_cursor next_offset="13" truncated="true" timed_out="false" />\npartial bytes\n</task_output>',
    { task_id: 't1', status: 'failed', timing: undefined, effective_wait_ms: 100, wait_ms_clamped: false,
      timed_out: false, next_offset: 13, truncated: true, summary: 'partial summary' });
});

test('output timeout cap golden uses the upstream wait hint only with a real timed_out=true fact', () => {
  const output = new OutputProjector();
  const read = { ...base, status: 'running', output: '', final_text: undefined,
    offset: 0, next_offset: 0, has_more: false, timed_out: true };
  exact(output.result(read, outputWait(90000), 'parent'),
    '<task_output status="running">\n<task_output_cursor next_offset="0" truncated="false" timed_out="true" />\n<task_output_hint>Your requested wait_ms exceeded 30000 ms and was capped at 30000 ms (30 seconds). This output read reached its wait limit; the background task was not stopped. Use wait_ms=30000 or less for future reads.</task_output_hint>\n(no output yet)\n</task_output>',
    { task_id: 't1', status: 'running', timing: undefined, effective_wait_ms: 30000, wait_ms_clamped: true,
      timed_out: true, next_offset: 0, truncated: false });
  const unknown = output.result({ ...read, timed_out: undefined }, outputWait(90000), 'other-parent');
  assert.equal(Object.hasOwn(unknown.details, 'timed_out'), false);
  assert.doesNotMatch(unknown.text, /reached its wait limit/);
});

test('repeated-output hint golden is scoped to the current parent/turn and reads preserve the complete page', () => {
  const output = new OutputProjector();
  const read = { ...base, status: 'running', output: 'page', final_text: undefined,
    offset: 0, next_offset: 4, has_more: false, timed_out: false };
  output.result(read, outputWait(), 'parent');
  exact(output.result(read, outputWait(), 'parent'),
    '<task_output status="running">\n<task_output_cursor next_offset="4" truncated="false" timed_out="false" />\n<task_output_hint>Task status and next_offset are unchanged since the previous read. To wait for new output, use task_output({"task_id":"t1","offset":4,"wait_ms":30000}). offset=0 replays existing output and can return immediately even with wait_ms. Avoid repeated immediate checks; continue independent work and wait for the completion notification when available.</task_output_hint>\npage\n</task_output>',
    { task_id: 't1', status: 'running', timing: undefined, effective_wait_ms: 0, wait_ms_clamped: false,
      timed_out: false, next_offset: 4, truncated: false });
  output.reset();
  assert.doesNotMatch(output.result(read, outputWait(), 'parent').text, /unchanged since/);
  assert.doesNotMatch(output.result(read, outputWait(), 'other-parent').text, /unchanged since/);
  const page = 'a'.repeat(65536);
  const result = output.result({ ...read, output: page, next_offset: page.length }, outputWait(), 'parent');
  assert.ok(result.text.includes(page));
  assert.equal(result.details.next_offset, page.length);
});
