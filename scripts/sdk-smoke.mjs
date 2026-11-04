import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { registerTaskAgents } from '../src/extension.ts';
import { createPiChildFactory } from '../src/pi-backend.ts';

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
  } }, { agentDir: run, childFactory: () => createPiChildFactory({ agentDir: realAgentDir, modelRuntime }) }); }],
});
await loader.reload();
const parentManager = SessionManager.create(run, run);
// A real user entry enables Pi's normal lazy JSONL persistence without a parent model call.
parentManager.appendMessage({ role: 'user', content: 'SDK acceptance harness: execute registered tools only.', timestamp: Date.now() });
const { session } = await createAgentSession({ cwd: run, agentDir: run, modelRuntime, settingsManager: settings,
  resourceLoader: loader, sessionManager: parentManager });
await session.bindExtensions({ mode: 'json', onError: (error) => errors.push(error), abortHandler: () => {}, shutdownHandler: () => {} });
const results = [];
let seq = 0;
async function call(name, params) {
  const tool = session.agent.state.tools.find((entry) => entry.name === name);
  assert.ok(tool, `missing registered tool: ${name}`);
  return (await tool.execute(`smoke-${++seq}`, params, new AbortController().signal, () => {})).details;
}
async function waitFor(id) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const state = await call('task_query', { task_id: id });
    if (!['queued', 'running', 'stopping'].includes(state.status)) return state;
    await call('task_output', { task_id: id, offset: state.output_bytes, wait_ms: 1000 });
  }
  throw new Error('Child smoke exceeded deadline');
}
try {
  const roles = await call('task_agents', {});
  assert.ok(roles.roles.worker);
  const tokens = { explore: 'EXPLORE_READY', worker: 'WORKER_READY', verifier: 'VERIFIER_READY', mavis: 'MAVIS_READY' };
  const tasks = await Promise.all(Object.entries(tokens).map(([agent_name, token]) => call('task', {
    agent_name, description: `Validate ${agent_name} runtime`, prompt: `No tools or file changes are needed. Reply with exactly ${token}.`, run_in_background: false,
  })));
  for (let index = 0; index < tasks.length; index++) {
    const role = Object.keys(tokens)[index];
    assert.equal(tasks[index].status, 'succeeded', JSON.stringify(tasks[index]));
    assert.equal(tasks[index].final_text.trim(), tokens[role]);
    results.push({ role, status: tasks[index].status, verification: tasks[index].verification });
  }
  assert.equal(delivered.length, 0, 'foreground tasks must not notify');
  const worker = tasks[1];
  const next = await call('task_append', { task_id: worker.task_id, content: 'What exact readiness token did you reply with in the previous turn? Reply only that token. Do not use tools.' });
  assert.notEqual(next.task_id, worker.task_id);
  assert.equal(next.session_id, worker.session_id);
  const continued = await waitFor(next.task_id);
  assert.equal(continued.status, 'succeeded', JSON.stringify(continued));
  assert.equal(continued.final_text.trim(), tokens.worker);
  await controller.flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].options.triggerTurn, true);
  await controller.reconcile();
  assert.equal((await controller.engine.pendingNotifications()).length, 0);
  const originalFile = await readFile(continued.childSessionPath, 'utf8');
  assert.ok(originalFile.includes('WORKER_READY'));
  results.push({ check: 'idle append retains history and background notification persists', status: 'passed' });

  const pending = await call('task', { agent_name: 'worker', description: 'Cancel accepted task', prompt: 'Do not use tools. Count slowly before replying CANCEL_TEST.', run_in_background: true });
  const stopped = await call('task_stop', { task_id: pending.task_id, reason: 'Acceptance cancellation check' });
  assert.equal(stopped.status, 'canceled');
  results.push({ check: 'accepted task cancellation', status: 'passed' });
  assert.deepEqual(errors, []);
  const report = { pi: '1.5.0', results, notifications: delivered.length, status: 'passed' };
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...report, report: join(run, 'report.json') }, null, 2));
} finally {
  await controller.shutdown();
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
