import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskEngine } from '../../../src/engine.ts';
import { createPiChildFactory } from '../../../src/pi-backend.ts';

const run = process.env.DEFAULT_SDK_CHAIN_TEST_ROOT;
assert.ok(run, 'Run this fixture through test/default-sdk-chain.test.ts');
for (const [key, directory] of [['HOME', 'home'], ['PI_CODING_AGENT_DIR', 'global-agent'], ['TMPDIR', 'tmp'],
  ['XDG_CONFIG_HOME', 'config'], ['XDG_CACHE_HOME', 'cache'], ['XDG_DATA_HOME', 'data'],
  ['XDG_STATE_HOME', 'state'], ['XDG_RUNTIME_DIR', 'run']]) {
  assert.equal(process.env[key], path.join(run, directory), `Unisolated ${key}`);
}
const profile = { name: 'verifier', model: 'offline/default-sdk', thinking: 'off', timeoutMs: 0,
  instructions: 'Operate only on owned fixture files.', tools: ['bash'], skills: [], extensions: [], mcp: false };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function wait(predicate) {
  for (let i = 0; i < 1000; i++) { if (await predicate()) return; await delay(5); }
  assert.fail('Scripted phase was not reached');
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(run, 'cases', 'chain-'));
  const agentDir = path.join(root, 'agent'); await fs.mkdir(agentDir);
  const entered = deferred(), release = deferred();
  let plan = { mode: 'success', calls: 0 }, failLateAbort = false;
  const children = [];
  const model = { provider: 'offline', id: 'default-sdk', api: 'test', reasoning: false, input: ['text'],
    contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = { getModel: () => model, getModels: () => [], getProviders: () => [], hasConfiguredAuth: () => true,
    resolveModel: async () => ({ model, thinkingLevel: 'off' }),
    streamSimple() {
      const current = plan, step = ++current.calls;
      const result = (async () => {
        if (current.mode === 'late') { entered.resolve(); await release.promise; }
        const tool = current.mode === 'success' && step === 1;
        const stopReason = tool ? 'toolUse' : ['failure', 'late'].includes(current.mode) ? 'error' : current.mode === 'aborted' ? 'aborted' : 'stop';
        return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
          content: tool ? [{ type: 'toolCall', id: 'owned-write', name: 'bash', arguments: { command: "printf 'owned actual bytes' > actual.txt" } }]
            : [{ type: 'text', text: current.mode === 'success' ? 'VERDICT: FAIL' : current.mode === 'aborted' ? 'committed aborted text' : 'VERDICT: PASS' }],
          ...(['failure', 'late'].includes(current.mode) ? { errorMessage: 'SCRIPTED_NONRETRYABLE_FAILURE' } : {}),
          usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      })();
      return { async *[Symbol.asyncIterator]() { const message = await result; yield { type: 'done', reason: message.stopReason, message }; }, result: () => result };
    } };
  // No SDK injection: production defaults execute.
  const factory = createPiChildFactory({ agentDir, modelRuntime: runtime });
  const engine = await new TaskEngine({ rootDir: path.join(root, 'tasks'), cwd: root, parentId: 'independent', maxConcurrency: 1,
    async createChild(options) {
      const child = await factory(options); children.push(child);
      if (plan.mode !== 'late') return child;
      // A fault at the public child-abort boundary leaves the actual SDK prompt running.
      return { ...child, async abort() {
        if (failLateAbort) { failLateAbort = false; throw new Error('SCRIPTED_ABORT_REQUEST_FAILURE'); }
        await child.abort();
      } };
    } }).init();
  t.after(async () => {
    release.resolve();
    const failures = [];
    try { await engine.close(); } catch (error) { failures.push(error); }
    // Attempt every real child even when one shutdown failed; never swallow cleanup failures.
    const disposed = await Promise.allSettled(children.map((child) => child.dispose()));
    for (const result of disposed) if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, 'Default SDK fixture cleanup failed');
  });
  return { root, engine, entered, release, children,
    plan(mode) { plan = { mode, calls: 0 }; failLateAbort = mode === 'late'; return plan; },
    async start(mode, selectedProfile = profile) {
      const selected = this.plan(mode);
      const task = await engine.start({ description: mode, prompt: `Owned scripted case ${mode}`, run_in_background: true }, selectedProfile, { requestId: mode });
      return { task, selected };
    },
    async settled(id) {
      await wait(() => ['succeeded', 'failed', 'canceled'].includes(engine.task(id).status));
      await engine.runtimes.get(id)?.done;
      return { query: await engine.query({ task_id: id }), output: await engine.output(id, { offset: 0 }),
        disk: JSON.parse(await fs.readFile(engine.store.file, 'utf8')).tasks.find((entry) => entry.task_id === id) };
    } };
}

function replay(fixture, mode, taskId, status, output) {
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { TaskEngine } from ${JSON.stringify(new URL('../../../src/engine.ts', import.meta.url).href)};
    let calls = 0;
    const engine = await new TaskEngine({ rootDir: ${JSON.stringify(path.join(fixture.root, 'tasks'))},
      cwd: ${JSON.stringify(fixture.root)}, parentId: 'independent', createChild: async () => {
        calls++; throw new Error('Replay must not execute');
      } }).init();
    try {
      const task = await engine.start({ description: ${JSON.stringify(mode)}, prompt: ${JSON.stringify(`Owned scripted case ${mode}`)},
        run_in_background: true }, ${JSON.stringify(profile)}, { requestId: ${JSON.stringify(mode)} });
      await engine.runtimes.get(task.task_id)?.done;
      // These assertions are outside SDK callbacks and must terminate this process on failure.
      assert.equal(calls, 0, 'Durable request replay must not create a child');
      assert.equal(task.task_id, ${JSON.stringify(taskId)});
      assert.equal(task.status, ${JSON.stringify(status)});
      assert.equal((await engine.query()).length, 1);
      const output = await engine.output(task.task_id);
      assert.equal(output.output, ${JSON.stringify(output)});
      const disk = JSON.parse(await fs.readFile(engine.store.file, 'utf8'));
      assert.equal(disk.tasks[0].output, ${JSON.stringify(output)});
      process.stdout.write(JSON.stringify({ task, output }));
    } finally { await engine.close(); }
  `;
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fixture.root, encoding: 'utf8', env: process.env, timeout: 15000,
  });
  assert.ifError(restarted.error);
  assert.equal(restarted.signal, null, restarted.stderr);
  assert.equal(restarted.status, 0, restarted.stderr);
  return JSON.parse(restarted.stdout);
}

test('default SDK real Engine/Bash: verdict FAIL is not task failure, committed terminal text survives restart without execution', async (t) => {
  const f = await setup(t);
  const { task, selected } = await f.start('success');
  const { query, output, disk } = await f.settled(task.task_id);
  assert.equal(selected.calls, 2);
  assert.equal(query.status, 'succeeded');
  assert.equal(await fs.readFile(path.join(f.root, 'actual.txt'), 'utf8'), 'owned actual bytes');
  assert.equal(output.output, 'VERDICT: FAIL'); assert.equal(disk.output, output.output);
  assert.equal(disk.final_text, output.output); assert.doesNotMatch(disk.output, /bash:|owned actual bytes|tool_execution/);
  await f.engine.close();
  const restarted = replay(f, 'success', task.task_id, 'succeeded', 'VERDICT: FAIL');
  assert.equal(restarted.task.task_id, task.task_id);
  assert.equal(restarted.output.output, 'VERDICT: FAIL');
  assert.equal(JSON.parse(await fs.readFile(f.engine.store.file, 'utf8')).tasks[0].output, 'VERDICT: FAIL');
});

test('default SDK normal failed result with VERDICT PASS remains failed and writes the source failed suffix', async (t) => {
  const f = await setup(t), { task } = await f.start('failure');
  const { query, output, disk } = await f.settled(task.task_id);
  assert.equal(query.status, 'failed');
  assert.equal(output.output, 'VERDICT: PASS\n\n[failed] SCRIPTED_NONRETRYABLE_FAILURE'); assert.equal(disk.output, output.output);
});

test('default SDK returned aborted result remains canceled and writes the source aborted suffix', async (t) => {
  const f = await setup(t), { task } = await f.start('aborted');
  const { query, output, disk } = await f.settled(task.task_id);
  assert.equal(query.status, 'canceled');
  assert.equal(output.output, 'committed aborted text\n\n[aborted] Child session aborted'); assert.equal(disk.output, output.output);
});

test('default SDK actually handled input reaches the production true-exception writer with zero model calls', async (t) => {
  const f = await setup(t), extension = path.join(f.root, 'handled.mjs');
  await fs.writeFile(extension, `export default function(pi) { pi.on('input', () => ({ action: 'handled' })); }`);
  const { task, selected } = await f.start('exception', { ...profile, extensions: [extension] });
  const { query, output, disk } = await f.settled(task.task_id);
  assert.equal(selected.calls, 0); assert.equal(query.status, 'failed');
  assert.equal(output.output, 'Background task failed: Child prompt completed without a settled assistant response');
  assert.equal(disk.output, output.output);
});

test('default SDK late failure backfills after a public abort-request fault and an independent Node replay never duplicates it', async (t) => {
  const f = await setup(t), { task } = await f.start('late');
  await f.entered.promise;
  assert.equal((await f.engine.output(task.task_id, { offset: 0 })).output, '');
  const stopped = await f.engine.stop(task.task_id);
  assert.equal(stopped.status, 'canceled'); assert.equal(stopped.stopError.code, 'TASK_STOP_FAILED');
  assert.equal((await f.engine.output(task.task_id, { offset: 0 })).output, '');
  f.release.resolve();
  const { query, output, disk } = await f.settled(task.task_id);
  assert.equal(query.status, 'canceled'); assert.deepEqual(query.stopError, stopped.stopError);
  assert.equal(output.output, 'VERDICT: PASS\n\n[failed] SCRIPTED_NONRETRYABLE_FAILURE'); assert.equal(disk.output, output.output);
  await f.engine.close();
  const restarted = replay(f, 'late', task.task_id, 'canceled', output.output);
  assert.deepEqual(restarted.task.stopError, stopped.stopError);
  assert.equal(JSON.parse(await fs.readFile(f.engine.store.file, 'utf8')).tasks[0].output, output.output);
});
