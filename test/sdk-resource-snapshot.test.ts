import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';

async function fixture(t, factories = [], files = false, mcp = false) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-resource-snapshot-')), agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
  await mkdir(agentDir); await mkdir(cwd); await mkdir(join(agentDir, 'extensions'));
  await mkdir(join(root, 'runtime-skill'));
  await writeFile(join(root, 'runtime-skill/SKILL.md'), '---\nname: runtime-skill\ndescription: owned runtime skill\n---\nFixture.\n');
  const hook = join(agentDir, 'extensions/hook.ts');
  await writeFile(hook, 'export default pi => { pi.on("before_agent_start", () => {}); };');
  let api;
  const inline = pi => { api = pi; pi.on('resources_discover', () => ({ skillPaths: [join(root, 'runtime-skill')] })); };
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }, { projectTrusted: true });
  const model = { provider: 'offline', id: 'local', api: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = { getModel: () => model, getModels: () => [], getProviders: () => [], hasConfiguredAuth: () => true,
    resolveModel: async () => ({ model, thinkingLevel: 'off' }), streamSimple() {
      const message = { role: 'assistant', api: 'test', provider: 'offline', model: 'local', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message }; }, result: async () => message };
    } };
  const audit = join(root, 'mcp-audit.jsonl');
  const connector = sdk.createMcpExtension({ startupWaitMs: 5000, logPath: join(root, 'mcp.log'),
    loadConfig: () => ({ servers: [{ name: 'file-owned', source: 'owned fixture', scope: 'global', config: { command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url)), audit, 'snapshot'], exposure: 'direct' } }], errors: [] }) });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: !files, noSkills: true,
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: 'snapshot-owner', factory: inline }, ...(mcp ? [connector] : []), ...factories] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: settings,
    sessionManager: sdk.SessionManager.inMemory(cwd), modelRuntime: runtime, model, thinkingLevel: 'off' });
  t.after(async () => { try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); await session.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  await session.bindExtensions({ mode: 'json', onError: error => { throw error; }, abortHandler() {}, shutdownHandler() {} });
  return { get api() { return api; }, session, loader, root, hook, inline, audit };
}

test('resource snapshot preserves hook-only files, accepted inline factories and runtime Skills without exposing parent handlers', async t => {
  const f = await fixture(t, [], true); await f.session.prompt('No tools.');
  const value = await f.api.getResources();
  assert.ok(value.extensions.some(e => e.resolvedPath === f.hook && e.factory === undefined));
  assert.equal(value.extensions.find(e => e.path === '<inline:snapshot-owner>').factory, f.inline);
  assert.equal(value.skills[0].name, 'runtime-skill'); assert.equal(value.mcp, null);
  assert.equal('handlers' in value.extensions[0], false);
  value.extensions[0].path = 'changed'; value.skills[0].sourceInfo.path = 'changed'; value.skills.pop();
  const next = await f.api.getResources(); assert.notEqual(next.extensions[0].path, 'changed'); assert.equal(next.skills.length, 1); assert.notEqual(next.skills[0].sourceInfo.path, 'changed');
});

test('anonymous factory identity is function-bound, distinct and stable across a real reload', async t => {
  const first = pi => pi.on('before_agent_start', () => {}), second = pi => pi.on('before_agent_start', () => {});
  const f = await fixture(t, [first, second]);
  const before = await f.api.getResources();
  const firstId = before.extensions.find(entry => entry.factory === first).factoryId;
  assert.equal(typeof firstId, 'string');
  assert.notEqual(firstId, before.extensions.find(entry => entry.factory === second).factoryId);
  await f.session.reload();
  assert.equal((await f.api.getResources()).extensions.find(entry => entry.factory === first).factoryId, firstId);
});

test('disabled file extensions remain absent in the authoritative snapshot', async t => {
  const f = await fixture(t); const value = await f.api.getResources();
  assert.equal(value.extensions.some(e => e.resolvedPath === f.hook), false);
});

test('native connector snapshots effective file and runtime configs without calling business tools', async t => {
  const f = await fixture(t, [{ name: 'registration', factory: pi => pi.registerMcpServer('runtime-disabled', { command: process.execPath, args: ['-e', 'process.exit(1)'], enabled: false }) }], false, true);
  await f.session.prompt('No tools.');
  const before = await readFile(f.audit, 'utf8'); const value = await f.api.getResources();
  assert.deepEqual(value.mcp.servers.map(e => e.name).sort(), ['file-owned', 'runtime-disabled']);
  assert.equal(value.mcp.servers.find(e => e.name === 'runtime-disabled').config.enabled, false);
  assert.equal(await readFile(f.audit, 'utf8'), before);
  assert.equal(before.includes('tools/call'), false);
  value.mcp.servers[0].config.enabled = false;
  assert.equal((await f.api.getResources()).mcp.servers[0].config.enabled, undefined);
});

test('MCP event observers do not become connectors or disappear from the extension snapshot', async t => {
  const f = await fixture(t, [{ name: 'observer', factory: pi => pi.on('mcp_servers_change', () => {}) }], false, true);
  await f.session.prompt('No tools.');
  const value = await f.api.getResources();
  assert.ok(value.mcp.servers.some(entry => entry.name === 'file-owned'));
  assert.equal(value.extensions.find(entry => entry.path === '<inline:observer>').mcpConnector, false);
});

test('unsupported MCP connectors fail explicitly instead of claiming an empty complete snapshot', async t => {
  const f = await fixture(t, [pi => pi.on('mcp_servers_change', () => {})]);
  await assert.rejects(f.api.getResources(), /does not provide a resource snapshot/);
});
