import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskController, RESULT_TYPE } from '../src/controller.ts';

function fixture(entries = []) {
  const sent = [];
  const engines = [];
  class Engine {
    constructor(options) { this.options = options; this.tasks = []; engines.push(this); }
    async init() {}
    async close() { this.closed = true; }
    async query() { return this.tasks; }
    async pendingNotifications() { return this.tasks.filter((task) => task.notification_pending); }
    async ackNotification(id) { this.tasks.find((task) => task.task_id === id).notification_pending = false; }
    async output(id) { return { ...this.tasks.find((task) => task.task_id === id), output: 'child report' }; }
    async stop(id) { this.tasks.find((task) => task.task_id === id).status = 'canceled'; }
  }
  const pi = { sendMessage: (...args) => sent.push(args), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  const ctx = { cwd: '/project', hasUI: false, isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => 'parent-a', getEntries: () => entries } };
  const controller = new TaskController(pi, { agentDir: '/agent', Engine,
    configLoader: async () => ({ maxConcurrency: 4, roles: {}, diagnostics: [] }), childFactory: () => () => {} });
  return { controller, ctx, engines, sent, entries, pi };
}
const complete = (id = 't1') => ({ task_id: id, agent_name: 'worker', description: 'bounded work', status: 'succeeded', notification_pending: true });

test('completion is sent once and stays pending until the persisted message receipt', async () => {
  const f = fixture();
  await f.controller.ensure(f.ctx);
  f.engines[0].tasks.push(complete());
  await Promise.all([f.controller.flush(), f.controller.flush()]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.engines[0].tasks[0].notification_pending, true);
  assert.deepEqual(f.sent[0][1], { triggerTurn: true, deliverAs: 'followUp' });
  f.controller.receipt(f.sent[0][0]);
  assert.equal(f.engines[0].tasks[0].notification_pending, true);
  f.entries.push({ type: 'custom_message', ...f.sent[0][0] });
  await f.controller.reconcile();
  assert.equal(f.engines[0].tasks[0].notification_pending, false);
  await f.controller.flush();
  assert.equal(f.sent.length, 1);
  await f.controller.shutdown();
});

test('recovery reconciles a durable custom message before attempting redelivery', async () => {
  const f = fixture([{ type: 'custom_message', customType: RESULT_TYPE, details: { task_id: 't1', parent_id: 'parent-a' } }]);
  await f.controller.ensure(f.ctx);
  f.engines[0].tasks.push(complete());
  await f.controller.reconcile();
  await f.controller.flush();
  assert.equal(f.sent.length, 0);
  await f.controller.shutdown();
});

test('cancel pauses delivery across reload and stops running children', async () => {
  const f = fixture();
  await f.controller.ensure(f.ctx);
  f.engines[0].tasks.push(complete(), { task_id: 't2', status: 'running' });
  await f.controller.stopAll();
  assert.equal(f.engines[0].tasks[1].status, 'canceled');
  await f.controller.flush();
  assert.equal(f.sent.length, 0);
  await f.controller.shutdown();
  await f.controller.ensure(f.ctx);
  f.engines[1].tasks.push(complete());
  await f.controller.flush();
  assert.equal(f.sent.length, 0);
  f.controller.resume();
  await f.controller.flush();
  assert.equal(f.sent.length, 1);
  await f.controller.shutdown();
});

test('session replacement closes the old owner and never sends its result to the new session', async () => {
  const f = fixture();
  await f.controller.ensure(f.ctx);
  f.engines[0].tasks.push(complete());
  const other = { ...f.ctx, sessionManager: { getSessionId: () => 'parent-b', getEntries: () => [] } };
  await f.controller.ensure(other);
  assert.equal(f.engines[0].closed, true);
  await f.controller.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.engines[1].options.parentId, 'parent-b');
  await f.controller.shutdown();
});

test('dialog defers completion delivery until it closes', async () => {
  const f = fixture();
  await f.controller.ensure(f.ctx);
  f.engines[0].tasks.push(complete());
  f.controller.dialogOpen = true;
  await f.controller.flush();
  assert.equal(f.sent.length, 0);
  f.controller.dialogOpen = false;
  await f.controller.flush();
  assert.equal(f.sent.length, 1);
  await f.controller.shutdown();
});

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('cancel, session switch and shutdown during output prevent a late wakeup', async () => {
  for (const action of ['cancel', 'switch', 'shutdown']) {
    const f = fixture();
    await f.controller.ensure(f.ctx);
    f.engines[0].tasks.push(complete());
    const entered = deferred(), output = deferred();
    f.engines[0].output = async () => { entered.resolve(); return output.promise; };
    const flush = f.controller.flush();
    await entered.promise;
    let closing;
    if (action === 'cancel') await f.controller.stopAll();
    if (action === 'switch') f.ctx.sessionManager.getSessionId = () => 'parent-b';
    if (action === 'shutdown') closing = f.controller.shutdown();
    output.resolve({ output: 'late report' });
    await flush;
    await closing;
    assert.equal(f.sent.length, 0, action);
    await f.controller.shutdown();
  }
});

test('a canceled admission waiting for ensure never resumes notifications', async () => {
  const f = fixture();
  await f.controller.ensure(f.ctx);
  const gate = deferred(), entered = deferred();
  f.controller.ensure = async () => { entered.resolve(); await gate.promise; return f.engines[0]; };
  const signal = new AbortController();
  const start = f.controller.start({}, 'call', signal.signal, f.ctx);
  await entered.promise;
  signal.abort();
  await f.controller.stopAll();
  gate.resolve();
  await assert.rejects(start, { name: 'AbortError' });
  assert.equal(f.controller.suppressed, true);
  assert.deepEqual(f.entries.map((entry) => entry.data.paused), [true]);
  await f.controller.shutdown();
});

test('async send loss and cleared queues can retry without duplicating queued reports', async () => {
  const f = fixture();
  await f.controller.ensure(f.ctx);
  f.engines[0].tasks.push(complete());
  f.ctx.isIdle = () => true;
  let queued = true;
  f.ctx.hasPendingMessages = () => queued;
  await f.controller.flush();
  f.controller.inFlight.set('t1', Date.now() - 2000);
  await f.controller.flush();
  assert.equal(f.sent.length, 1);
  queued = false;
  await f.controller.flush();
  assert.equal(f.sent.length, 2);
  assert.equal(f.engines[0].tasks[0].notification_pending, true);
  await f.controller.shutdown();
});

test('receipt checks use disk even when Pi in-memory entries already contain the result', async () => {
  const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
  const root = new URL('../artifacts/controller-tests/', import.meta.url);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(new URL('receipt-', root).pathname);
  const file = dir + '/parent.jsonl';
  await writeFile(file, '', { mode: 0o600 });
  const f = fixture([{ type: 'custom_message', customType: RESULT_TYPE, details: { task_id: 't1', parent_id: 'parent-a' } }]);
  f.ctx.sessionManager.getSessionFile = () => file;
  await f.controller.ensure(f.ctx);
  f.engines[0].tasks.push(complete());
  f.controller.receipt({ customType: RESULT_TYPE, details: { task_id: 't1', parent_id: 'parent-a' } });
  await f.controller.reconcile();
  assert.equal(f.engines[0].tasks[0].notification_pending, true);
  await writeFile(file, JSON.stringify(f.entries[0]) + '\n', { mode: 0o600 });
  await f.controller.reconcile();
  assert.equal(f.engines[0].tasks[0].notification_pending, false);
  await f.controller.shutdown();
});

test('shutdown during initialization cannot leave a new task owner alive', async () => {
  const f = fixture();
  const entered = deferred(), config = deferred();
  f.controller.configLoader = async () => { entered.resolve(); return config.promise; };
  const opening = f.controller.ensure(f.ctx);
  await entered.promise;
  const closing = f.controller.shutdown();
  config.resolve({ maxConcurrency: 4, roles: {}, diagnostics: [] });
  await assert.rejects(opening, { name: 'AbortError' });
  await closing;
  assert.equal(f.controller.engine, undefined);
  assert.equal(f.engines.length, 0);
});
