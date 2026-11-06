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
  let api, script;
  const inline = pi => { api = pi; pi.on('resources_discover', () => ({ skillPaths: [join(root, 'runtime-skill')] })); };
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }, { projectTrusted: true });
  const model = { provider: 'offline', id: 'local', api: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = { getModel: () => model, getModels: () => [], getProviders: () => [], hasConfiguredAuth: () => true,
    resolveModel: async () => ({ model, thinkingLevel: 'off' }), streamSimple(_model, context) {
      const baseMessage = { role: 'assistant', api: 'test', provider: 'offline', model: 'local', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const message = script ? script(baseMessage, context) : baseMessage;
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
    } };
  const audit = join(root, 'mcp-audit.jsonl');
  const connector = sdk.createMcpExtension({ startupWaitMs: 5000, logPath: join(root, 'mcp.log'),
    loadConfig: () => ({ servers: [{ name: 'file-owned', source: 'owned fixture', scope: 'global', config: { command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url)), audit, 'snapshot', '',
        mcp === 'legacy-resources' ? 'resources' : 'tools'], exposure: 'direct' } }], errors: [] }) });
  const selectedConnector = typeof mcp === 'string' ? pi => connector(new Proxy(pi, { get(target, property, receiver) {
    if (property === 'on') return (event, handler) => event === 'resources_snapshot' || mcp === 'legacy-static' && event === 'mcp_servers_change'
      ? () => {} : target.on(event, handler);
    return Reflect.get(target, property, receiver);
  } })) : connector;
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: !files, noSkills: true,
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: 'snapshot-owner', factory: inline }, ...(mcp ? [selectedConnector] : []), ...factories] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: settings,
    sessionManager: sdk.SessionManager.inMemory(cwd), modelRuntime: runtime, model, thinkingLevel: 'off' });
  t.after(async () => { try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); await session.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  await session.bindExtensions({ mode: 'json', onError: error => { throw error; }, abortHandler() {}, shutdownHandler() {} });
  return { get api() { return api; }, session, loader, root, hook, inline, audit, script(fn) { script = fn; } };
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

test('MCP-off event observers do not imply a connector', async t => {
  const f = await fixture(t, [{ name: 'observer', factory: pi => pi.on('mcp_servers_change', () => {}) }]);
  const value = await f.api.getResources(); assert.equal(value.mcp, null);
  assert.equal(value.extensions.find(entry => entry.path === '<inline:observer>').mcpConnector, false);
});

for (const enabled of [false, true]) test('unhandled MCP registrations require a snapshot only when enabled: ' + enabled, async t => {
  const f = await fixture(t, [pi => {
    pi.on('mcp_servers_change', () => {});
    pi.registerMcpServer('owned-unhandled', { command: process.execPath, args: ['-e', 'process.exit(1)'], enabled });
  }]);
  if (enabled) await assert.rejects(f.api.getResources(), /does not provide a resource snapshot/);
  else assert.equal((await f.api.getResources()).mcp, null);
});

for (const mode of ['legacy', 'legacy-resources', 'legacy-static']) test('a connected native MCP without the snapshot protocol is rejected: ' + mode, async t => {
  const f = await fixture(t, [], false, mode);
  await f.session.prompt('Initialize only the owned local connector.');
  const resource = mode === 'legacy-resources';
  const name = resource ? 'list_mcp_resources' : f.session.getAllTools().find(tool => tool.name.startsWith('mcp__') && tool.name.endsWith('__echo'))?.name;
  assert.ok(name); assert.ok(f.session.getAllTools().some(tool => tool.name === name));
  assert.equal(f.loader.getExtensions().extensions.some(extension => extension.handlers.has('resources_snapshot')), false);
  let observed = false;
  f.script((base, context) => {
    const reply = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === name);
    if (!reply) return { ...base, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'owned-legacy-call', name,
      arguments: resource ? { server: 'file-owned' } : { value: 'legacy' } }] };
    assert.equal(reply.isError, false);
    const text = reply.content.filter(part => part.type === 'text').map(part => part.text).join('');
    assert.match(text, resource ? /OWNED_MCP_RESOURCE:snapshot/ : /OWNED_MCP_ECHO:snapshot:\d+:legacy/);
    observed = true; return base;
  });
  await f.session.prompt('Call only the owned local fixture.'); assert.equal(observed, true);
  assert.match(await readFile(f.audit, 'utf8'), resource ? /resources\/list/ : /tools\/call/);
  await assert.rejects(f.api.getResources(), /does not provide a resource snapshot/);
});
