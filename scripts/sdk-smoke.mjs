import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVerificationReport, parseModelVerdict } from '../src/task-verification.ts';

export function createSmokeChildFactory(factory, agentDir, modelRuntime) {
  return (options) => factory({ ...options, agentDir, modelRuntime });
}

function record(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function nonempty(value, label) {
  assert.ok(typeof value === 'string' && value.trim(), `${label} must be a nonempty string`);
  return value;
}

export async function runSdkSmoke({ session, controller, delivered, errors }) {
  const results = [];
  let seq = 0;
  async function call(name, params) {
    const tool = session.agent.state.tools.find((entry) => entry.name === name);
    assert.ok(tool, `missing registered tool: ${name}`);
    const result = record(await tool.execute(`smoke-${++seq}`, params, new AbortController().signal, () => {}), name);
    assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.details)}`);
    assert.ok(Array.isArray(result.content) && result.content.some((part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim()), `${name} requires text content`);
    return record(result.details, `${name}.details`);
  }
  async function query(id) {
    nonempty(id, 'task_query task_id');
    const task = record((await call('task_query', { task_id: id })).task, 'task_query.details.task');
    assert.equal(task.task_id, id);
    assert.equal(task.kind, 'subagent');
    nonempty(task.session_id, 'task_query session_id');
    assert.ok(['queued', 'running', 'stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(task.status), `invalid task_query status: ${task.status}`);
    return task;
  }
  async function output(id, offset, wait_ms) {
    const read = await call('task_output', { task_id: id, offset, wait_ms });
    assert.equal(read.task_id, id);
    assert.ok(['queued', 'running', 'stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(read.status), `invalid task_output status: ${read.status}`);
    assert.ok(Number.isSafeInteger(read.next_offset) && read.next_offset >= offset, 'task_output requires a valid next_offset');
    return read;
  }
  async function waitFor(id) {
    const deadline = Date.now() + 120000;
    let offset = 0;
    while (Date.now() < deadline) {
      const state = await query(id);
      if (!['queued', 'running', 'stopping'].includes(state.status)) return state;
      offset = (await output(id, offset, 1000)).next_offset;
    }
    throw new Error('Child smoke exceeded deadline');
  }
  async function internalTask(id, sessionId) {
    assert.ok(controller.engine, 'controller engine must exist');
    const task = record(await controller.engine.query({ task_id: id }), 'engine task');
    assert.equal(task.task_id, id);
    nonempty(task.session_id, 'engine session_id');
    assert.equal(task.session_id, sessionId);
    nonempty(task.childSessionPath, 'engine childSessionPath');
    assert.ok(isAbsolute(task.childSessionPath), 'engine history path must be absolute');
    return task;
  }

  const roles = record((await call('task_agents', {})).roles, 'task_agents roles');
  const tokens = { explore: 'EXPLORE_READY', worker: 'WORKER_READY', verifier: 'VERIFIER_READY', mavis: 'MAVIS_READY' };
  const firstPrompt = (token) => token === tokens.verifier
    ? `Verify this contained statement: 2 + 2 = 4. No tools, files or temporary artifacts are needed. Include ${token} in your normal verifier report and finish with VERDICT: PASS.`
    : `No tools or file changes are needed. Reply with exactly ${token}.`;
  const tasks = await Promise.all(Object.entries(tokens).map(([agent_name, token]) => {
    record(roles[agent_name], `role ${agent_name}`);
    return call('task', { agent_name, description: `Validate ${agent_name} runtime`, prompt: firstPrompt(token), run_in_background: false });
  }));
  for (let index = 0; index < tasks.length; index++) {
    const role = Object.keys(tokens)[index];
    const task = tasks[index];
    nonempty(task.task_id, 'task task_id');
    nonempty(task.sub_session_id, 'task sub_session_id');
    assert.equal(task.agent_name, role);
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    const finalText = nonempty(task.final_text, 'task final_text');
    assert.ok(finalText.includes(tokens[role]), `task final_text is missing ${tokens[role]}`);
    if (role === 'verifier') {
      assert.equal(parseModelVerdict(finalText), 'pass', 'verifier report verdict');
      assert.ok(isVerificationReport(task.verification), 'verifier verification');
      assert.equal(task.verification.modelVerdict, 'pass', 'verifier modelVerdict');
    }
    const state = await query(task.task_id);
    assert.equal(state.status, 'succeeded');
    assert.equal(state.session_id, task.sub_session_id);
    results.push({ role, status: state.status });
  }
  assert.equal(delivered.length, 0, 'foreground tasks must not notify');
  const worker = tasks[1];
  const original = await internalTask(worker.task_id, worker.sub_session_id);
  const appendPrompt = 'What exact readiness token did you reply with in the previous turn? Reply only that token. Do not use tools.';
  const next = await call('task_append', { task_id: worker.task_id, content: appendPrompt });
  nonempty(next.task_id, 'task_append task_id');
  assert.equal(next.accepted, true);
  assert.equal(next.mode, 'activated', 'idle append must activate a new turn');
  assert.notEqual(next.task_id, worker.task_id);
  const continued = await waitFor(next.task_id);
  assert.equal(continued.status, 'succeeded', JSON.stringify(continued));
  assert.equal(continued.session_id, worker.sub_session_id);
  const completedOutput = await output(next.task_id, 0, 0);
  assert.equal(completedOutput.status, 'succeeded');
  assert.equal(nonempty(completedOutput.summary, 'task_output summary').trim(), tokens.worker);
  await controller.flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].options.triggerTurn, true);
  await controller.reconcile();
  assert.deepEqual(await controller.engine.pendingNotifications(), []);

  // Public query deliberately hides disk paths; only this controlled harness uses the engine interface.
  const saved = await internalTask(next.task_id, worker.sub_session_id);
  assert.equal(saved.childSessionPath, original.childSessionPath);
  const entries = (await readFile(saved.childSessionPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries[0]?.type, 'session', 'history requires a Pi session header');
  nonempty(entries[0].id, 'history session id');
  const messages = entries.filter((entry) => entry.type === 'message').map((entry) => entry.message);
  const text = (message) => typeof message?.content === 'string' ? message.content :
    (Array.isArray(message?.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('') : '');
  let position = -1;
  for (const [role, expected] of [
    ['user', firstPrompt(tokens.worker)], ['assistant', tokens.worker],
    ['user', appendPrompt], ['assistant', tokens.worker],
  ]) {
    position = messages.findIndex((message, index) => index > position && message?.role === role &&
      (role === 'user' ? text(message).includes(expected) : text(message).trim() === expected));
    assert.ok(position >= 0, `history missing ordered ${role} message: ${expected}`);
  }
  results.push({ check: 'idle append retains history and background notification persists', status: 'passed' });

  const pending = await call('task', { agent_name: 'worker', description: 'Cancel accepted task', prompt: 'Do not use tools. Count slowly before replying CANCEL_TEST.', run_in_background: true });
  nonempty(pending.task_id, 'background task_id');
  nonempty(pending.sub_session_id, 'background sub_session_id');
  assert.equal(pending.status, 'started');
  const stopped = await call('task_stop', { task_id: pending.task_id, reason: 'Acceptance cancellation check' });
  assert.equal(stopped.task_id, pending.task_id);
  assert.equal(stopped.status, 'canceled');
  const canceled = await query(pending.task_id);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.session_id, pending.sub_session_id);
  results.push({ check: 'accepted task cancellation', status: 'passed' });
  assert.deepEqual(errors, []);
  return { pi: '1.5.0', results, notifications: delivered.length, status: 'passed' };
}

async function main() {
  // Imports and all live SDK/authentication setup stay behind the executable entry point.
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, getAgentDir } = await import('@earendil-works/pi-coding-agent');
  const { registerTaskAgents } = await import('../src/extension.ts');
  const { createPiChildFactory } = await import('../src/pi-backend.ts');
  const root = resolve(fileURLToPath(new URL('../artifacts/sdk-smoke/', import.meta.url)));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const run = join(root, new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(run, { mode: 0o700 });
  const realAgentDir = getAgentDir();
  // Match CLI networking when this SDK check runs directly under Node.
  const network = await import(new URL('./core/http-dispatcher.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
  const hostSettings = SettingsManager.create(run, realAgentDir);
  network.applyHttpProxySettings(hostSettings.getSettings().httpProxy);
  network.configureHttpDispatcher(hostSettings.getHttpIdleTimeoutMs());
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const settings = SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [], cacheWarming: 'off' });
  const delivered = [];
  const errors = [];
  let controller;
  const loader = new DefaultResourceLoader({ cwd: run, agentDir: run, settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [(pi) => { controller = registerTaskAgents({ ...pi, sendMessage(message, options) {
      delivered.push({ message, options });
      // Persist the real notification without paying for a parent model response.
      pi.sendMessage(message, { triggerTurn: false });
    } }, { agentDir: run, childFactory: createSmokeChildFactory(createPiChildFactory, realAgentDir, modelRuntime) }); }],
  });
  await loader.reload();
  const parentManager = SessionManager.create(run, run);
  // A real user entry enables Pi's normal lazy JSONL persistence without a parent model call.
  parentManager.appendMessage({ role: 'user', content: 'SDK acceptance harness: execute registered tools only.', timestamp: Date.now() });
  const { session } = await createAgentSession({ cwd: run, agentDir: run, modelRuntime, settingsManager: settings,
    resourceLoader: loader, sessionManager: parentManager });
  await session.bindExtensions({ mode: 'json', onError: (error) => errors.push(error), abortHandler: () => {}, shutdownHandler: () => {} });
  try {
    const report = await runSdkSmoke({ session, controller, delivered, errors });
    await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ...report, report: join(run, 'report.json') }, null, 2));
  } finally {
    await controller.shutdown();
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
