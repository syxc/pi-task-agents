import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmokeChildFactory, runSdkSmoke } from '../scripts/sdk-smoke.mjs';
import { appendResult, taskResult } from '../src/tool-result-task.ts';
import { OutputProjector, outputWait, queryResult, stopResult } from '../src/tool-result-control.ts';
import { projectedResult } from '../src/tool-result-common.ts';
import type { TaskToolResult } from '../src/tool-result-common.ts';
import type { TaskInput, TaskSummary } from '../src/types.ts';

type Mutation = (name: string, result: TaskToolResult) => void;

async function harness(mutate: Mutation = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-smoke-'));
  const tasks = new Map<string, TaskSummary>();
  const delivered: Array<{ message: unknown; options: { triggerTurn: boolean } }> = [];
  const calls: Array<{ name: string; params: Record<string, any> }> = [];
  const internalQueries: string[] = [];
  const output = new OutputProjector();
  let reconciled = false;
  let runningReads = 0;
  const history = join(root, 'worker.jsonl');
  const initialPrompt = 'No tools or file changes are needed. Reply with exactly WORKER_READY.';
  const appendPrompt = 'What exact readiness token did you reply with in the previous turn? Reply only that token. Do not use tools.';
  const entries = [
    { type: 'session', version: 3, id: 'session-worker', cwd: root },
    { type: 'message', message: { role: 'user', content: initialPrompt } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'WORKER_READY' }] } },
    { type: 'message', message: { role: 'user', content: appendPrompt } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'WORKER_READY' }] } },
  ];
  const engine = {
    async query({ task_id }: { task_id: string }) {
      internalQueries.push(task_id);
      return tasks.get(task_id);
    },
    async pendingNotifications() { return reconciled ? [] : [tasks.get('continued')]; },
  };
  const controller = {
    engine,
    async flush() {
      if (!delivered.length) delivered.push({ message: { task_id: 'continued' }, options: { triggerTurn: true } });
    },
    async reconcile() { reconciled = true; },
  };
  const execute = async (name: string, params: Record<string, any>) => {
    calls.push({ name, params });
    let result: TaskToolResult;
    if (name === 'task_agents') {
      result = projectedResult(name, 'roles', { roles: { explore: {}, worker: {}, verifier: {}, mavis: {} } });
    } else if (name === 'task') {
      const input = params as TaskInput;
      const role = input.agent_name!;
      const summary: TaskSummary = {
        task_id: input.run_in_background ? 'cancel' : role, session_id: `session-${role}`,
        parent_id: 'parent', childSessionPath: role === 'worker' ? history : join(root, `${role}.jsonl`),
        status: input.run_in_background ? 'queued' : 'succeeded', agent_name: role,
        resolved_agent_name: role, description: input.description!, created_at: '2025-01-01T00:00:00.000Z',
        output_bytes: 0, notify_completion: input.run_in_background === true, notification_pending: false,
        final_text: input.run_in_background ? undefined : `${role.toUpperCase()}_READY`,
      };
      tasks.set(summary.task_id, summary);
      result = taskResult(summary, input);
    } else if (name === 'task_append') {
      const summary: TaskSummary = { ...tasks.get(params.task_id)!, task_id: 'continued', status: 'running',
        mode: 'activated', accepted: true, notify_completion: true, final_text: undefined };
      tasks.set(summary.task_id, summary);
      result = appendResult(summary);
    } else if (name === 'task_query') {
      result = queryResult(tasks.get(params.task_id)!);
    } else if (name === 'task_output') {
      const summary = tasks.get(params.task_id)!;
      const wasRunning = summary.status === 'running';
      result = output.result({ ...summary, output: wasRunning ? 'partial' : summary.final_text!,
        offset: params.offset ?? 0, next_offset: wasRunning ? 7 * ++runningReads : 19, has_more: false },
      outputWait(params.wait_ms), 'parent');
      if (wasRunning && runningReads === 2) {
        summary.status = 'succeeded';
        summary.final_text = 'WORKER_READY';
        await writeFile(history, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      }
    } else if (name === 'task_stop') {
      const summary = tasks.get(params.task_id)!;
      summary.status = 'canceled';
      result = stopResult(summary);
    } else throw new Error(`Unexpected tool: ${name}`);
    mutate(name, result);
    return result;
  };
  const session = { agent: { state: { tools: ['task_agents', 'task', 'task_append', 'task_query', 'task_output', 'task_stop']
    .map((name) => ({ name, execute: async (_id: string, params: Record<string, any>) => execute(name, params) })) } } };
  return { session, controller, delivered, errors: [], calls, internalQueries, tasks, history, entries,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('SDK smoke accepts actual public projections and proves continuation/session history', async () => {
  const h = await harness();
  try {
    const report = await runSdkSmoke(h);
    assert.equal(report.status, 'passed');
    assert.equal(report.results.length, 6);
    assert.equal(report.notifications, 1);
    assert.deepEqual(report.results.slice(0, 4), ['explore', 'worker', 'verifier', 'mavis']
      .map((role) => ({ role, status: 'succeeded' })));
    assert.deepEqual(h.calls.filter(({ name }) => name === 'task_output').map(({ params }) => params), [
      { task_id: 'continued', offset: 0, wait_ms: 1000 },
      { task_id: 'continued', offset: 7, wait_ms: 1000 },
      { task_id: 'continued', offset: 0, wait_ms: 0 },
    ]);
    assert.deepEqual(h.calls.filter(({ name }) => name === 'task_query').map(({ params }) => params.task_id),
      ['explore', 'worker', 'verifier', 'mavis', 'continued', 'continued', 'continued', 'cancel']);
    assert.deepEqual(h.internalQueries, ['worker', 'continued'], 'history paths must come from the controlled engine');
    assert.equal(JSON.stringify(report).includes('verification'), false);
  } finally { await h.cleanup(); }
});

test('live factory override preserves every parent context option except agentDir/modelRuntime', () => {
  const options = {
    agentDir: '/isolated-parent', modelRuntime: { old: true }, inheritedModel: { provider: 'offline', id: 'model' },
    inheritedThinking: 'high', inheritedModelRegistry: { parent: true }, projectTrusted: false,
    resourceLoader: { parent: true }, customTools: [], sdk: { parent: true },
  };
  const modelRuntime = { live: true };
  const child = () => {};
  let received: unknown;
  const factory = createSmokeChildFactory((value) => { received = value; return child; }, '/authorized-agent', modelRuntime);
  assert.equal(factory(options), child);
  assert.deepEqual(received, { ...options, agentDir: '/authorized-agent', modelRuntime });
  assert.equal(options.agentDir, '/isolated-parent');
});

const invalidProjections: Array<[string, string, (result: TaskToolResult) => void, RegExp]> = [
  ['missing details', 'task_agents', (r) => { r.details = undefined!; }, /task_agents.details/],
  ['error envelope', 'task_agents', (r) => { r.isError = true; }, /task_agents failed/],
  ['missing content', 'task_agents', (r) => { r.content = []; }, /requires text content/],
  ['missing role', 'task_agents', (r) => { delete (r.details.roles as Record<string, unknown>).worker; }, /role worker/],
  ['empty task id', 'task', (r) => { r.details.task_id = ''; }, /task task_id/],
  ['missing foreground session (undefined cannot equal undefined)', 'task', (r) => { delete r.details.sub_session_id; }, /task sub_session_id/],
  ['wrong foreground role', 'task', (r) => { r.details.agent_name = 'wrong'; }, /wrong/],
  ['failed foreground', 'task', (r) => { r.details.status = 'failed'; }, /succeeded/],
  ['empty foreground text', 'task', (r) => { r.details.final_text = ' '; }, /task final_text/],
  ['flattened query', 'task_query', (r) => { r.details = r.details.task as Record<string, unknown>; }, /task_query.details.task/],
  ['missing query status', 'task_query', (r) => { delete (r.details.task as Record<string, unknown>).status; }, /invalid task_query status/],
  ['unknown query status', 'task_query', (r) => { (r.details.task as Record<string, unknown>).status = 'done'; }, /invalid task_query status/],
  ['wrong query kind', 'task_query', (r) => { (r.details.task as Record<string, unknown>).kind = 'shell'; }, /subagent/],
  ['wrong query id', 'task_query', (r) => { (r.details.task as Record<string, unknown>).task_id = 'wrong'; }, /wrong/],
  ['missing query session', 'task_query', (r) => { delete (r.details.task as Record<string, unknown>).session_id; }, /task_query session_id/],
  ['wrong continuation session', 'task_query', (r) => {
    const task = r.details.task as Record<string, unknown>;
    if (task.task_id === 'continued') task.session_id = 'unrelated';
  }, /unrelated/],
  ['append has no id', 'task_append', (r) => { delete r.details.task_id; }, /task_append task_id/],
  ['append not accepted', 'task_append', (r) => { r.details.accepted = false; }, /false/],
  ['append missing mode', 'task_append', (r) => { delete r.details.mode; }, /idle append/],
  ['append wrong mode', 'task_append', (r) => { r.details.mode = 'steered'; }, /idle append/],
  ['append reuses task id', 'task_append', (r) => { r.details.task_id = 'worker'; }, /worker/],
  ['wrong output id', 'task_output', (r) => { r.details.task_id = 'wrong'; }, /wrong/],
  ['missing output status', 'task_output', (r) => { delete r.details.status; }, /invalid task_output status/],
  ['missing output cursor', 'task_output', (r) => { delete r.details.next_offset; }, /valid next_offset/],
  ['invalid output cursor', 'task_output', (r) => { r.details.next_offset = -1; }, /valid next_offset/],
  ['missing completed summary', 'task_output', (r) => { delete r.details.summary; }, /task_output summary/],
  ['empty completed summary', 'task_output', (r) => { r.details.summary = ' '; }, /task_output summary/],
  ['wrong completed summary', 'task_output', (r) => { r.details.summary = 'WRONG'; }, /WRONG/],
  ['wrong background status', 'task', (r) => { if (r.details.status === 'started') r.details.status = 'queued'; }, /started/],
  ['missing background session', 'task', (r) => { if (r.details.status === 'started') delete r.details.sub_session_id; }, /background sub_session_id/],
  ['wrong stop status', 'task_stop', (r) => { r.details.status = 'stopping'; }, /canceled/],
  ['wrong stop id', 'task_stop', (r) => { r.details.task_id = 'wrong'; }, /wrong/],
];

for (const [label, tool, corrupt, expected] of invalidProjections) {
  test(`SDK smoke rejects ${label}`, async () => {
    const h = await harness((name, result) => { if (name === tool) corrupt(result); });
    try { await assert.rejects(runSdkSmoke(h), expected); }
    finally { await h.cleanup(); }
  });
}

const invalidHistory: Array<[string, string, (h: Awaited<ReturnType<typeof harness>>) => void, RegExp]> = [
  ['missing internal path', 'task', (h) => { h.tasks.get('worker')!.childSessionPath = ''; }, /engine childSessionPath/],
  ['relative internal path', 'task', (h) => { h.tasks.get('worker')!.childSessionPath = 'worker.jsonl'; }, /must be absolute/],
  ['missing internal session', 'task_output', (h) => { h.tasks.get('continued')!.session_id = undefined!; }, /engine session_id/],
  ['different internal path', 'task_append', (h) => { h.tasks.get('continued')!.childSessionPath = join(tmpdir(), 'wrong.jsonl'); }, /wrong.jsonl/],
  ['nonexistent saved history', 'task', (h) => { h.tasks.get('worker')!.childSessionPath = join(h.history, 'absent.jsonl'); }, /ENOTDIR|ENOENT/],
  ['missing session header', 'task_append', (h) => { h.entries.shift(); }, /session header/],
  ['empty session header id', 'task_append', (h) => { h.entries[0].id = ''; }, /history session id/],
  ['missing earlier user', 'task_append', (h) => { h.entries.splice(1, 1); }, /history missing ordered user/],
  ['missing earlier assistant', 'task_append', (h) => { h.entries.splice(2, 1); }, /history missing ordered user/],
  ['missing continued assistant', 'task_append', (h) => { h.entries.pop(); }, /history missing ordered assistant/],
];

for (const [label, tool, corrupt, expected] of invalidHistory) {
  test(`SDK smoke rejects ${label}`, async () => {
    let h: Awaited<ReturnType<typeof harness>>;
    h = await harness((name, result) => {
      if (name === tool && (tool === 'task_append' ||
          (tool === 'task' && result.details.task_id === 'worker') ||
          (tool === 'task_output' && result.details.status === 'succeeded'))) corrupt(h);
    });
    try { await assert.rejects(runSdkSmoke(h), expected); }
    finally { await h.cleanup(); }
  });
}
