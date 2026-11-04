import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { TaskEngine } from '../src/engine.ts';
import { TaskDomain } from '../src/task-domain.ts';
import type { TestContext } from 'node:test';
import type {
  AgentProfile, ChildResult, CreateChildOptions, TaskEngineOptions, TaskInput, TaskRecord, TaskSummary,
} from '../src/types.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface MockCall extends Deferred<ChildResult> {
  text: string;
}

interface MockChild extends CreateChildOptions {
  calls: MockCall[];
  steers: string[];
  disposed: boolean;
  prompt(text: string): Promise<ChildResult>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

const profile: AgentProfile = Object.freeze({ name: 'worker', model: 'test/model', thinking: 'medium',
  instructions: 'Work', tools: [], extensions: [], skills: [], mcp: false, timeoutMs: 0 });
const input = (prompt = 'hello'): TaskInput => ({ agent_name: 'worker', description: 'test', prompt });
const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function holdNextPersistence(engine: TaskEngine): { entered: Promise<void>; release: () => void } {
  const original = engine.persist;
  const entered = deferred();
  const release = deferred();
  let held = false;
  engine.persist = function () {
    if (!held) { held = true; entered.resolve(); return release.promise.then(() => original.call(this)); }
    return original.call(this);
  };
  return { entered: entered.promise, release: release.resolve };
}

interface SetupResult {
  engine: TaskEngine;
  children: MockChild[];
  rootDir: string;
  createChild: (args: CreateChildOptions) => Promise<MockChild>;
}

async function setup(t: TestContext, options: Partial<TaskEngineOptions> = {}): Promise<SetupResult> {
  const rootDir = await mkdtemp(fileURLToPath(new URL('../.engine-test-', import.meta.url)));
  const children: MockChild[] = [];
  const createChild = async (args: CreateChildOptions): Promise<MockChild> => {
    const child: MockChild = { ...args, calls: [], steers: [], disposed: false,
      prompt(text: string): Promise<ChildResult> { const call = deferred<ChildResult>(); this.calls.push({ text, ...call }); return call.promise; },
      async steer(text: string): Promise<void> { this.steers.push(text); },
      async abort(): Promise<void> { this.calls.at(-1)?.reject(new Error('Aborted')); },
      async dispose(): Promise<void> { this.disposed = true; },
    };
    children.push(child);
    return child;
  };
  const engine = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild, ...options });
  await engine.init();
  t.after(async () => {
    for (const child of children) for (const call of child.calls) call.resolve({ text: 'cleanup' });
    await engine.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { engine, children, rootDir, createChild };
}

async function waitFor(fn: () => unknown | Promise<unknown>): Promise<void> {
  for (let i = 0; i < 600; i++) { if (await fn()) return; await delay(5); }
  assert.fail('Condition did not become true');
}

async function finish(engine: TaskEngine, child: MockChild, text = 'done'): Promise<void> {
  const task = (await engine.query()).findLast((entry) => entry.childSessionPath === child.sessionPath);
  assert.ok(task);
  child.calls.at(-1).resolve({ text, usage: { tokens: 1 }, verification: 'checked' });
  await waitFor(async () => (await engine.query({ task_id: task.task_id })).status === 'succeeded');
}

test('ACK, bounded admission, duplicate starts and frozen effective profiles', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 });
  const [a, duplicate] = await Promise.all([
    engine.start({ ...input(), model: 'other/id', effort: 'high' }, profile, { requestId: 'one' }),
    engine.start(input(), profile, { requestId: 'one' }),
  ]);
  assert.equal(a.task_id, duplicate.task_id);
  const b = await engine.start(input('second'), profile);
  assert.equal(b.status, 'queued');
  await waitFor(() => children[0]?.calls.length === 1);
  assert.equal(children.length, 1);
  assert.equal(children[0].profile.model, 'other/id');
  assert.equal(children[0].profile.thinking, 'high');
  assert.ok(Object.isFrozen(children[0].profile.tools));
  await finish(engine, children[0]);
  await waitFor(() => children[1]?.calls.length === 1);
  assert.equal((await engine.query({ task_id: a.task_id })).status, 'succeeded');
  await engine.stop(b.task_id);
});

test('finishing a task does not wait for an already running queued successor', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 });
  const a = await engine.start(input(), profile);
  const b = await engine.start(input('queued successor'), profile);
  await waitFor(() => children[0]?.calls.length === 1);
  children[0].calls[0].resolve({ text: 'first complete' });
  await waitFor(() => children[1]?.calls.length === 1);
  await finish(engine, children[0]);
  assert.equal((await engine.query({ task_id: a.task_id })).status, 'succeeded');
  assert.equal((await engine.query({ task_id: b.task_id })).status, 'running');
  await engine.stop(b.task_id);
});

test('running append steers once, idle append creates a task and reuses session history', async (t) => {
  const { engine, children } = await setup(t);
  const a = await engine.start(input(), profile);
  await waitFor(() => children[0]?.calls.length);
  const [one, two] = await Promise.all([engine.append(a.task_id, 'more', { requestId: 'x' }),
    engine.append(a.task_id, 'more', { requestId: 'x' })]);
  assert.equal(one.task_id, a.task_id);
  assert.equal(two.task_id, a.task_id);
  assert.deepEqual(children[0].steers, ['more']);
  await finish(engine, children[0]);
  const b = await engine.append(a.task_id, 'continue');
  assert.notEqual(b.task_id, a.task_id);
  assert.equal(b.session_id, a.session_id);
  assert.equal(b.childSessionPath, a.childSessionPath);
  await waitFor(() => children[0].calls.length === 2);
  assert.equal(children.length, 1);
  assert.equal(children[0].calls[1].text, 'continue');
});

test('cancel waits for abort and prompt settlement before admitting another task', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 });
  const a = await engine.start(input(), profile);
  const b = await engine.start(input(), profile);
  await waitFor(() => children[0]?.calls.length);
  const releaseAbort = deferred();
  children[0].abort = () => releaseAbort.promise;
  let stopped = false;
  const stopping = engine.stop(a.task_id).then(() => { stopped = true; });
  await waitFor(async () => (await engine.query({ task_id: a.task_id })).status === 'stopping');
  children[0].calls[0].reject(new Error('Interrupted'));
  await tick();
  assert.equal(children.length, 1);
  assert.equal(stopped, false);
  releaseAbort.resolve();
  await stopping;
  await waitFor(() => children[1]?.calls.length);
  assert.equal((await engine.query({ task_id: a.task_id })).status, 'canceled');
  assert.deepEqual(await engine.pendingNotifications(), []);
  await engine.stop(b.task_id);
});

test('UTF-8 byte output, automatic cursor, waiting, failure output, notification ack independence', async (t) => {
  const notifications: TaskSummary[] = [];
  const { engine, children } = await setup(t, { notify: (value) => { notifications.push(value); throw new Error('delivery failed'); } });
  const a = await engine.start(input(), profile);
  await waitFor(() => children[0]?.calls.length);
  const waiting = engine.output(a.task_id, { wait_ms: 30000 });
  children[0].onOutput('中🙂x');
  const first = await waiting;
  assert.equal(first.output, '中🙂x');
  assert.equal(first.next_offset, 8);
  assert.equal((await engine.output(a.task_id)).output, '');
  assert.equal((await engine.output(a.task_id, { offset: 0, limitBytes: 1 })).output, '中');
  assert.equal((await engine.output(a.task_id, { offset: 4, limitBytes: 2 })).output, 'x');
  children[0].calls[0].reject(new Error('boom'));
  await waitFor(() => notifications.length === 1);
  assert.equal((await engine.output(a.task_id, { offset: 0 })).output, '中🙂x');
  assert.equal((await engine.query({ task_id: a.task_id })).status, 'failed');
  assert.equal((await engine.pendingNotifications()).length, 1);
  await engine.ackNotification(a.task_id);
  assert.deepEqual(await engine.pendingNotifications(), []);
});

test('foreground shares state machine; pre-aborted start and append do not dispatch', async (t) => {
  const { engine, children } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.start(input(), profile, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await engine.query()).length, 0);
  const foreground = engine.start({ ...input(), run_in_background: false }, profile);
  await waitFor(() => children[0]?.calls.length);
  const [task] = await engine.query();
  await assert.rejects(engine.append(task.task_id, 'no', { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(children[0].steers, []);
  children[0].calls[0].resolve({ text: 'answer' });
  const result = await foreground;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.final_text, 'answer');
});

test('parent lock, isolation, permissions and restart preserve dedup, cursors and notifications', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t);
  const a = await engine.start(input(), profile, { requestId: 'stable' });
  await waitFor(() => children[0]?.calls.length);
  await finish(engine, children[0], 'saved');
  await waitFor(async () => (await engine.pendingNotifications()).length === 1);
  await engine.output(a.task_id, { limitBytes: 2 });
  const competitor = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild });
  await assert.rejects(competitor.init(), /active task owner/);
  const foreign = new TaskEngine({ rootDir, parentId: 'other', cwd: rootDir, createChild });
  await foreign.init();
  await assert.rejects(foreign.query({ task_id: a.task_id }), /Unknown task/);
  await foreign.close();
  assert.equal((await stat(engine.store.file)).mode & 0o777, 0o600);
  assert.equal((await stat(engine.store.dir)).mode & 0o777, 0o700);
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'));
  assert.equal(saved.tasks[0].profile.name, 'worker');
  await engine.close();
  assert.equal(children[0].disposed, true);
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild });
  await restored.init();
  try {
    assert.equal((await restored.start(input(), profile, { requestId: 'stable' })).task_id, a.task_id);
    assert.equal((await restored.output(a.task_id)).output, 'ved');
    assert.equal((await restored.pendingNotifications()).length, 1);
    const b = await restored.append(a.task_id, 'resume');
    await waitFor(() => children[1]?.calls.length);
    assert.equal(children[1].sessionPath, a.childSessionPath);
    await restored.stop(b.task_id);
  } finally { await restored.close(); }
});

test('dead owner pending task becomes lost and can resume the same child JSONL path', async (t) => {
  const { engine, rootDir, createChild, children } = await setup(t);
  await engine.close();
  const script = `
    import { TaskEngine } from ${JSON.stringify(new URL('../src/engine.ts', import.meta.url).href)};
    const engine = new TaskEngine({rootDir: process.argv[1], parentId:'parent', cwd:process.argv[1],
      createChild: async ({sessionPath}) => ({sessionPath, prompt:()=>new Promise(()=>{}), abort:async()=>{}, dispose:async()=>{}})});
    await engine.init();
    await engine.start({agent_name:'worker',prompt:'run'}, ${JSON.stringify(profile)}, {requestId:'crash'});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, rootDir], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild });
  await restored.init();
  try {
    const [lost] = await restored.query();
    assert.equal(lost.status, 'lost');
    assert.equal((await restored.pendingNotifications()).length, 1);
    const next = await restored.append(lost.task_id, 'recover');
    await waitFor(() => children[0]?.calls.length);
    assert.equal(next.session_id, lost.session_id);
    assert.equal(children[0].sessionPath, lost.childSessionPath);
    await restored.stop(next.task_id);
  } finally { await restored.close(); }
});

test('foreground abort waits for child stop; background tool signal does not cancel', async (t) => {
  const notifications: TaskSummary[] = [];
  const { engine, children } = await setup(t, { notify: (task) => { notifications.push(task); } });
  const controller = new AbortController();
  let returned = false;
  const foreground = engine.start({ ...input(), run_in_background: false }, profile, { signal: controller.signal })
    .then((value) => { returned = true; return value; });
  await waitFor(() => children[0]?.calls.length);
  const release = deferred();
  children[0].abort = () => release.promise;
  controller.abort();
  children[0].calls[0].reject(new Error('Interrupted'));
  await tick();
  assert.equal(returned, false);
  release.resolve();
  const canceled = await foreground;
  assert.equal(canceled.status, 'canceled');
  assert.equal(returned, true);
  assert.deepEqual(await engine.pendingNotifications(), []);
  assert.deepEqual(notifications, []);
  const backgroundController = new AbortController();
  const background = await engine.start(input(), profile, { signal: backgroundController.signal });
  await waitFor(() => children[1]?.calls.length);
  backgroundController.abort();
  await tick();
  assert.equal((await engine.query({ task_id: background.task_id })).status, 'running');
  await engine.stop(background.task_id);
});

test('foreground success never queues a parent wakeup', async (t) => {
  const notifications: TaskSummary[] = [];
  const { engine, children } = await setup(t, { notify: (task) => notifications.push(task) });
  const foreground = engine.start({ ...input(), run_in_background: false }, profile);
  await waitFor(() => children[0]?.calls.length);
  children[0].calls[0].resolve({ text: 'answer' });
  assert.equal((await foreground).final_text, 'answer');
  assert.deepEqual(notifications, []);
  assert.deepEqual(await engine.pendingNotifications(), []);
});

test('append waits for prompt dispatch and cancellation during child creation skips prompt', async (t) => {
  let factoryArgs: CreateChildOptions | undefined;
  const releaseFactory = deferred();
  const prompt = deferred<ChildResult>();
  const calls: string[][] = [];
  const child = {
    sessionPath: '',
    async prompt(text: string): Promise<ChildResult> { calls.push(['prompt', text]); return prompt.promise; },
    async steer(text: string): Promise<void> { calls.push(['steer', text]); },
    async abort(): Promise<void> { calls.push(['abort']); prompt.reject(new Error('Aborted')); },
    async dispose(): Promise<void> {},
  };
  const { engine } = await setup(t, { createChild: async (args) => { factoryArgs = args; await releaseFactory.promise; return child; } });
  const task = await engine.start(input(), profile);
  const appending = engine.append(task.task_id, 'more');
  await waitFor(() => factoryArgs);
  assert.deepEqual(calls, []);
  releaseFactory.resolve();
  await appending;
  assert.deepEqual(calls.slice(0, 2), [['prompt', 'hello'], ['steer', 'more']]);
  await engine.stop(task.task_id);

  const releaseSecond = deferred();
  let factoryEntered = false;
  let prompts = 0;
  engine.createChild = async () => {
    factoryEntered = true;
    await releaseSecond.promise;
    return { sessionPath: '', async prompt(): Promise<ChildResult> { prompts++; return { text: '' }; },
      async steer(): Promise<void> {}, async abort(): Promise<void> {}, async dispose(): Promise<void> {} };
  };
  const second = await engine.start(input(), profile);
  await waitFor(() => factoryEntered);
  const stopping = engine.stop(second.task_id);
  releaseSecond.resolve();
  await stopping;
  assert.equal(prompts, 0);
  assert.equal((await engine.query({ task_id: second.task_id })).status, 'canceled');
});

test('regression: microtask stop after prompt completion retains the slot until abort settles', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 });
  const a = await engine.start(input('A'), profile);
  await engine.start(input('B'), profile);
  await waitFor(() => children[0]?.calls.length);
  engine.persist = async () => {};
  const releaseAbort = deferred();
  let aborts = 0;
  children[0].abort = async () => { aborts++; await releaseAbort.promise; };
  let stopping: Promise<TaskSummary> | undefined;
  children[0].calls[0].resolve({ text: 'A done' });
  queueMicrotask(() => { stopping = engine.stop(a.task_id); });
  try {
    await tick();
    if (aborts) {
      assert.equal(children.length, 1, 'B must not start while A abort is pending');
      assert.equal((await engine.query({ task_id: a.task_id })).status, 'stopping');
    } else {
      assert.equal((await engine.query({ task_id: a.task_id })).status, 'succeeded');
    }
  } finally { releaseAbort.resolve(); await stopping; }
});

test('regression: running append is delivered when prompt finishes during persistence', async (t) => {
  const { engine, children } = await setup(t);
  const a = await engine.start(input('A'), profile);
  await waitFor(() => children[0]?.calls.length);
  engine.persist = async () => {};
  const barrier = holdNextPersistence(engine);
  const appending = engine.append(a.task_id, 'append-race');
  await barrier.entered;
  children[0].calls[0].resolve({ text: 'A done' });
  await tick();
  barrier.release();
  const result = await appending;
  await engine.runtimes.get(result.task_id)?.started;
  const delivered = children[0].steers.filter((text) => text === 'append-race').length
    + children[0].calls.filter((call) => call.text === 'append-race').length;
  assert.equal(delivered, 1, 'successful append must deliver content exactly once');
});

test('regression: queued append promoted during persistence is not also steered', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 });
  await engine.start(input('A'), profile);
  const b = await engine.start(input('B'), profile);
  await waitFor(() => children[0]?.calls.length);
  engine.persist = async () => {};
  const barrier = holdNextPersistence(engine);
  const appending = engine.append(b.task_id, 'queued-race');
  await barrier.entered;
  children[0].calls[0].resolve({ text: 'A done' });
  await tick();
  barrier.release();
  await appending;
  await waitFor(() => children[1]?.calls.length);
  const delivered = children[1].steers.filter((text) => text === 'queued-race').length
    + children[1].calls.filter((call) => call.text.includes('queued-race')).length;
  assert.equal(delivered, 1, 'queued content must not be in both prompt and steer');
});

test('regression: rejected steer can retry the same requestId without losing content', async (t) => {
  const { engine, children } = await setup(t);
  const task = await engine.start(input(), profile);
  await waitFor(() => children[0]?.calls.length);
  let attempts = 0;
  children[0].steer = async (text) => {
    if (++attempts === 1) throw new Error('Not accepted');
    children[0].steers.push(text);
  };
  await assert.rejects(engine.append(task.task_id, 'retry-content', { requestId: 'retry' }), /Not accepted/);
  await engine.append(task.task_id, 'retry-content', { requestId: 'retry' });
  assert.equal(attempts, 2);
  assert.deepEqual(children[0].steers, ['retry-content']);
});

test('regression: settled SDK steer rejection resumes a new task and deduplicates its ACK', async (t) => {
  const { engine, children } = await setup(t);
  const a = await engine.start(input('A'), profile);
  await waitFor(() => children[0]?.calls.length);
  children[0].steer = async () => {
    children[0].calls[0].resolve({ text: 'settled' });
    throw new Error('Current prompt already settled');
  };
  const b = await engine.append(a.task_id, 'followup', { requestId: 'settled' });
  assert.notEqual(b.task_id, a.task_id);
  assert.equal(b.session_id, a.session_id);
  await waitFor(() => children[0].calls.length === 2);
  assert.equal(children[0].calls[1].text, 'followup');
  assert.equal((await engine.append(a.task_id, 'followup', { requestId: 'settled' })).task_id, b.task_id);
  let aborts = 0;
  const originalAbort = children[0].abort;
  children[0].abort = async function () { aborts++; await originalAbort.call(this); };
  await engine.stop(a.task_id);
  assert.equal(aborts, 0, 'stopping the old task cannot abort its reused child');
  assert.equal((await engine.query({ task_id: b.task_id })).status, 'running');
});

test('MCode completion seals cancellation and retains admission until its update settles', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 });
  const first = await engine.start(input('A'), profile);
  await engine.start(input('B'), profile);
  await waitFor(() => children[0]?.calls.length);
  const entered = deferred();
  const release = deferred();
  const originalFinish = TaskDomain.prototype.finish;
  TaskDomain.prototype.finish = async function (
    this: TaskDomain, task: TaskRecord, status: 'succeeded' | 'failed' | 'canceled',
  ): Promise<void> {
    if (task.task_id === first.task_id) { entered.resolve(); await release.promise; }
    await originalFinish.call(this, task, status);
  };
  let aborts = 0;
  const originalAbort = children[0].abort;
  children[0].abort = async () => { aborts++; await originalAbort.call(children[0]); };
  try {
    children[0].calls[0].resolve({ text: 'A done' });
    await entered.promise;
    const stopping = engine.stop(first.task_id);
    await tick();
    assert.equal(aborts, 0);
    assert.equal(children.length, 1);
    release.resolve();
    assert.equal((await stopping).status, 'succeeded');
    await waitFor(() => children[1]?.calls.length);
  } finally {
    release.resolve();
    TaskDomain.prototype.finish = originalFinish;
  }
});

test('timeout fails without notifying cancellation; close cancels queued and running tasks', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 });
  const timed = await engine.start(input(), { ...profile, timeoutMs: 10 });
  await waitFor(async () => (await engine.query({ task_id: timed.task_id })).status === 'failed');
  assert.match((await engine.query({ task_id: timed.task_id })).error, /timed out/);
  const running = await engine.start(input(), profile);
  const queued = await engine.start(input(), profile);
  await waitFor(() => children[1]?.calls.length);
  await engine.close();
  const tasks = JSON.parse(await readFile(engine.store.file, 'utf8')).tasks;
  for (const id of [running.task_id, queued.task_id]) {
    const task = tasks.find((item) => item.task_id === id);
    assert.equal(task.status, 'canceled');
    assert.equal(task.notification_pending, false);
  }
  assert.ok(children.every((child) => child.disposed));
});
