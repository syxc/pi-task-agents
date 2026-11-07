import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import { registerTaskAgents } from '../src/extension.ts';
import { answer, deferred, fixture, tool } from './pi-backend-test-helpers.ts';

async function setup(t, factories = [], roles = {}) {
  const f = await fixture(t);
  Object.assign(f.runtime, { getRegisteredProviderIds: () => [], getRegisteredProviderConfig() {}, getRegisteredNativeProvider() {} });
  t.mock.method(sdk.ModelRuntime, 'create', async () => f.runtime);
  await writeFile(join(f.agentDir, 'task-agents.json'), JSON.stringify({ maxConcurrency: 2, roles }));
  const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }, { projectTrusted: true });
  let controller, api;
  const errors = [];
  const loader = new sdk.DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [...factories, { name: 'owned-tasks', factory: pi => { api = pi; controller = registerTaskAgents(pi, { agentDir: f.agentDir }); } }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, model: f.model as any,
    modelRuntime: f.runtime as any, settingsManager: settings, resourceLoader: loader,
    sessionManager: sdk.SessionManager.create(f.cwd, join(f.root, 'parent')) });
  await session.bindExtensions({ mode: 'json', onError: error => errors.push(error), abortHandler() {}, shutdownHandler() {} });
  t.after(async () => {
    try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    finally { await session.dispose(); }
    assert.deepEqual(errors, []);
  });
  const child = context => JSON.stringify(context).includes('## Delegated Task Contract');
  return { ...f, session, controller, api, child,
    taskResult() {
      const result = session.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'task');
      assert.ok(result && result.role === 'toolResult');
      return result.details;
    } };
}

const target = pi => pi.registerTool({ name: 'owned_echo', label: 'Owned echo', description: 'Memory-only fixture',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  execute: async (_id, args) => ({ content: [{ type: 'text', text: 'ECHO:' + args.value }], details: {} }) });
const input = (role = 'worker', background = false) => ({ agent_name: role, description: 'Owned task', prompt: 'Use only owned fixtures.', run_in_background: background });

for (const role of ['explore', 'worker', 'verifier', 'mavis']) test('official default task entry executes the ' + role + ' role', async t => {
  let hooks = 0, factories = 0;
  const f = await setup(t, [{ name: 'owned-permission', factory: pi => {
    factories++; pi.on('tool_call', event => { if (event.toolName === 'owned_echo') hooks++; });
  } }, { name: 'owned-echo', factory: target }]);
  let parentCalls = 0, childCalls = 0;
  f.script((_step, context) => {
    if (!f.child(context)) return ++parentCalls === 1 ? tool('task', input(role)) : answer('PARENT_DONE');
    return ++childCalls === 1 ? tool('owned_echo', { value: role }) : answer(role === 'verifier' ? 'VERDICT: PASS' : 'CHILD_DONE');
  });
  await f.session.prompt('Delegate only the owned in-memory fixture.');
  const result = f.taskResult();
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(factories, 1, 'Parent hook-only factories must not run again in children');
  assert.equal(hooks, 1, 'The real parent permission handler must see the child call');
  assert.equal(typeof f.api.getResources, 'undefined');
  if (role === 'verifier') assert.equal(result.verification.modelVerdict, 'pass');
});

test('background calls after parent settle keep hooks, unique IDs, owner output and send continuation', async t => {
  const release = deferred(), entered = deferred();
  const seen = [], ids = [];
  let blocked = false;
  const f = await setup(t, [{ name: 'owned-stateful-policy', factory: pi => {
    pi.on('tool_call', event => {
      if (event.toolName !== 'owned_echo') return;
      ids.push(event.toolCallId); seen.push(event.input.value);
      if (blocked) return { block: true, reason: 'Owned late denial' };
    });
    pi.on('tool_result', event => event.toolName === 'owned_echo' && !event.isError
      ? { content: [{ type: 'text', text: 'PARENT_FILTERED' }] } : undefined);
  } }, { name: 'owned-echo', factory: target }]);
  f.api.sendMessage = () => {};
  let parentCalls = 0, childCalls = 0;
  f.script(async (_step, context) => {
    if (!f.child(context)) return ++parentCalls === 1 ? tool('task', input('worker', true)) : answer('PARENT_DONE');
    if (++childCalls === 1) { entered.resolve(); await release.promise; return tool('owned_echo', { value: 'late' }); }
    if (childCalls === 2) {
      const result = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'owned_echo');
      assert.ok(JSON.stringify(result).includes('PARENT_FILTERED'));
      blocked = true; return tool('owned_echo', { value: 'blocked' });
    }
    return answer('BACKGROUND_COMPLETE');
  });
  await f.session.prompt('Start an independent owned background task.');
  const receipt = f.taskResult();
  assert.equal(receipt.status, 'started');
  await entered.promise;
  const execution = f.controller.engine.runtimes.get(receipt.task_id);
  assert.ok(execution);
  release.resolve();
  await execution.done;
  const finished = (await f.controller.engine.query()).find(task => task.task_id === receipt.task_id);
  assert.equal(finished.status, 'succeeded');
  assert.equal((await f.controller.engine.output(receipt.task_id)).output, 'BACKGROUND_COMPLETE');
  assert.deepEqual(seen, ['late', 'blocked']);
  assert.equal(new Set(ids).size, ids.length);
  blocked = false;
  f.script((_step, context) => {
    assert.ok(f.child(context));
    assert.ok(JSON.stringify(context).includes('BACKGROUND_COMPLETE'));
    return answer('CONTINUED');
  });
  f.session.setActiveToolsByName(f.session.getActiveToolNames().filter(name => name !== 'task'));
  const send = f.session.agent.state.tools.find(tool => tool.name === 'task_send');
  assert.ok(send, 'A continuation must not require the Task entry to stay active');
  const continued = (await send.execute('owned-send', { task_id: receipt.task_id, content: 'Continue in the same history.' })).details;
  assert.equal(continued.status, 'succeeded');
  assert.equal(continued.session_id, receipt.sub_session_id);
  assert.equal(continued.final_text, 'CONTINUED');
});

test('the first Task waits for configured MCP and reuses its parent connection with raw server selectors', async t => {
  const server = fileURLToPath(new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url));
  const logs = await mkdtemp(join(tmpdir(), 'owned-mcp-logs-'));
  t.after(() => rm(logs, { recursive: true, force: true }));
  const f = await setup(t, [sdk.createMcpExtension({ startupWaitMs: 0,
    logPath: join(logs, 'mcp.log'),
    loadConfig: ctx => ({ servers: [{ name: 'owned-config', scope: 'global', source: 'owned-config-fixture', config: {
      command: process.execPath, args: [server, join(ctx.cwd, 'owned-mcp-audit.jsonl'), 'first-task'], exposure: 'direct',
    } }], errors: [] }) })], { worker: { mcpServers: ['owned-config'], tools: ['mcp__owned_config__echo'] } });
  let parentCalls = 0, childCalls = 0;
  f.script((_step, context) => {
    if (!f.child(context)) return ++parentCalls === 1 ? tool('task', input()) : answer('PARENT_DONE');
    if (++childCalls === 1) return tool('mcp__owned_config__echo', { value: 'child' });
    assert.ok(JSON.stringify(context).includes('OWNED_MCP_ECHO:first-task:1:child'));
    return answer('MCP_USED');
  });
  await f.session.prompt('Delegate only the owned stdio fixture.');
  assert.equal(f.taskResult().status, 'succeeded', JSON.stringify(f.taskResult()));
  const events = (await readFile(join(f.cwd, 'owned-mcp-audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.event === 'started').length, 1);
  assert.equal(events.filter(event => event.method === 'tools/call').length, 1);
});

for (const role of ['explore', 'worker']) test('nested parent extension calls respect the ' + role + ' ceiling', async t => {
  const f = await setup(t, [{ name: 'owned-alias', factory: pi => pi.registerTool({ name: 'owned_alias', label: 'Owned alias',
    description: 'Try a native nested write', parameters: { type: 'object', properties: {} },
    execute: async (_id, _args, signal, _update, ctx) => {
      const outcome = await ctx.executeTool('write', { path: 'nested-forbidden.txt', content: 'forbidden' }, { signal });
      return { ...outcome.result, isError: outcome.isError };
    } }) }]);
  let parentCalls = 0, childCalls = 0;
  f.script((_step, context) => {
    if (!f.child(context)) return ++parentCalls === 1 ? tool('task', input(role)) : answer('PARENT_DONE');
    if (++childCalls === 1) return tool('owned_alias', {});
    const result = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'owned_alias');
    assert.equal(result?.isError, role === 'explore');
    return answer('NESTED_SCOPE_CHECKED');
  });
  await f.session.prompt('Delegate the owned nested-role fixture.');
  assert.equal(f.taskResult().status, 'succeeded', JSON.stringify(f.taskResult()));
  if (role === 'explore') await assert.rejects(readFile(join(f.cwd, 'nested-forbidden.txt')), { code: 'ENOENT' });
  else assert.equal(await readFile(join(f.cwd, 'nested-forbidden.txt'), 'utf8'), 'forbidden');
});

test('an extension cannot keep a delegated native-tool context after returning its result', async t => {
  const release = deferred();
  let late;
  const f = await setup(t, [{ name: 'owned-detached', factory: pi => pi.registerTool({ name: 'owned_detached', label: 'Owned detached',
    description: 'Hold an owned native context', parameters: { type: 'object', properties: {} },
    execute: async (_id, _args, _signal, _update, ctx) => {
      late = release.promise.then(() => ctx.executeTool('write', { path: 'late-forbidden.txt', content: 'forbidden' }));
      return { content: [{ type: 'text', text: 'RETURNED' }], details: {} };
    } }) }]);
  let parentCalls = 0, childCalls = 0;
  f.script((_step, context) => !f.child(context) ? ++parentCalls === 1 ? tool('task', input()) : answer('PARENT_DONE')
    : ++childCalls === 1 ? tool('owned_detached', {}) : answer('CHILD_DONE'));
  await f.session.prompt('Delegate the owned detached-context fixture.');
  assert.equal(f.taskResult().status, 'succeeded');
  assert.ok(late); release.resolve();
  assert.equal((await late).isError, true);
  await assert.rejects(readFile(join(f.cwd, 'late-forbidden.txt')), { code: 'ENOENT' });
});

test('a parent-disabled native tool cannot reappear from the child SDK defaults', async t => {
  const f = await setup(t);
  f.session.setActiveToolsByName(f.session.getActiveToolNames().filter(name => name !== 'write'));
  const file = join(f.cwd, 'must-not-exist.txt');
  let parentCalls = 0, childCalls = 0;
  f.script((_step, context) => {
    if (!f.child(context)) return ++parentCalls === 1 ? tool('task', input()) : answer('PARENT_DONE');
    if (++childCalls === 1) {
      return tool('write', { path: file, content: 'forbidden' });
    }
    const result = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'write');
    assert.equal(result?.isError, true);
    return answer('DENIED_AS_EXPECTED');
  });
  await f.session.prompt('Delegate the owned permission fixture.');
  assert.equal(f.taskResult().status, 'succeeded');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

for (const change of ['disable', 'replace']) test('live parent ' + change + ' blocks a previously admitted child tool', async t => {
  const release = deferred(), entered = deferred();
  let effects = 0, echoApi;
  const f = await setup(t, [{ name: 'owned-echo', factory: pi => {
    echoApi = pi; target(pi);
    pi.on('tool_result', event => { if (event.toolName === 'owned_echo' && !event.isError) effects++; });
  } }]);
  f.api.sendMessage = () => {};
  let parentCalls = 0, childCalls = 0;
  f.script(async (_step, context) => {
    if (!f.child(context)) return ++parentCalls === 1 ? tool('task', input('worker', true)) : answer('PARENT_DONE');
    if (++childCalls === 1) { entered.resolve(); await release.promise; return tool('owned_echo', { value: 'late' }); }
    const result = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'owned_echo');
    assert.equal(result?.isError, true);
    return answer('LATE_CALL_REJECTED');
  });
  await f.session.prompt('Start the owned background permission fixture.');
  await entered.promise;
  const task = f.taskResult(), execution = f.controller.engine.runtimes.get(task.task_id);
  assert.ok(execution);
  if (change === 'disable') f.session.setActiveToolsByName(f.session.getActiveToolNames().filter(name => name !== 'owned_echo'));
  else echoApi.registerTool({ name: 'owned_echo', label: 'Replacement', description: 'Different implementation',
    parameters: { type: 'object', properties: {} }, execute: async () => { effects++; return { content: [], details: {} }; } });
  release.resolve(); await execution.done;
  const result = f.controller.engine.task(task.task_id);
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(effects, 0);
});

test('native session replacement cancels and drains background work before invalidating parent authority', async t => {
  const entered = deferred(), released = deferred();
  let stopped = false;
  const f = await setup(t, [{ name: 'owned-abortable', factory: pi => pi.registerTool({ name: 'owned_wait', label: 'Owned wait',
    description: 'Abortable memory-only fixture', parameters: { type: 'object', properties: {} },
    execute: async (_id, _args, signal) => {
      entered.resolve();
      await new Promise<void>(resolve => {
        const finish = () => { stopped = true; resolve(); };
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
      released.resolve();
      return { content: [{ type: 'text', text: 'STOPPED' }], details: {} };
    } }) }]);
  f.api.sendMessage = () => {};
  let parentCalls = 0, childCalls = 0;
  f.script((_step, context) => !f.child(context) ? ++parentCalls === 1 ? tool('task', input('worker', true)) : answer('PARENT_DONE')
    : ++childCalls === 1 ? tool('owned_wait', {}) : answer('CHILD_DONE'));
  await f.session.prompt('Start the owned abortable fixture.');
  await entered.promise;
  const task = f.taskResult(), engine = f.controller.engine;
  await f.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'new' });
  await released.promise;
  assert.equal(stopped, true);
  const closed = JSON.parse(await readFile(engine.store.file, 'utf8')).tasks.find(item => item.task_id === task.task_id);
  assert.equal(closed.status, 'canceled');
  assert.equal(closed.cleanup_pending, undefined);
  assert.equal(f.controller.engine, undefined);
});
