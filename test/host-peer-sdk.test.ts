import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import { answer } from './pi-backend-test-helpers.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
const server = fileURLToPath(new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url));

test('MCP adapter uses the supplied host SDK without resolving a peer beside the plugin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-host-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, 'package'), agentDir = join(root, 'agent');
  await Promise.all([mkdir(pkg), mkdir(agentDir)]);
  await Promise.all(['src', 'package.json'].map(path => cp(join(project, path), join(pkg, path), { recursive: true })));
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { owned: { command: process.execPath, enabled: false } } }));
  const adapterModule = await import(pathToFileURL(join(pkg, 'src/resource-mcp.ts')).href);
  let options: sdk.McpExtensionOptions | undefined;
  const adapter = await adapterModule.childMcpFactory({ ...sdk, createMcpExtension(value: sdk.McpExtensionOptions) {
    options = value; return sdk.createMcpExtension(value);
  } }, { name: 'worker', instructions: '', tools: ['read'], skills: [], extensions: [], timeoutMs: 0 },
  agentDir, root, false, join(root, 'session.jsonl'), 100);
  assert.equal(adapter.extension.name, 'task-agents-mcp');
  const config = options!.loadConfig!({} as sdk.ExtensionContext);
  assert.equal(config.servers[0].name, 'owned');
  assert.equal(config.servers[0].config.enabled, false);
});

test('real Pi CLI host mapping resolves native MCP without local SDK peers or network', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-cli-host-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, 'package'), agentDir = join(root, 'agent'), home = join(root, 'home');
  await Promise.all([mkdir(pkg), mkdir(agentDir), mkdir(home)]);
  await Promise.all(['src', 'package.json'].map(path => cp(join(project, path), join(pkg, path), { recursive: true })));
  const entry = join(root, 'entry.ts'), guard = join(root, 'offline.mjs');
  await writeFile(guard, `globalThis.fetch = () => { throw new Error('Owned CLI probe forbids network'); };\n`);
  await writeFile(entry, `import * as sdk from '@earendil-works/pi-coding-agent';
import { childMcpFactory } from ${JSON.stringify(pathToFileURL(join(pkg, 'src/resource-mcp.ts')).href)};
export default async () => {
  try {
    const value = await childMcpFactory(sdk, { name: 'worker', instructions: '', tools: ['read'], extensions: [], skills: [], timeoutMs: 0 },
      ${JSON.stringify(agentDir)}, ${JSON.stringify(root)}, false, ${JSON.stringify(join(root, 'session.jsonl'))}, 100);
    process.stdout.write(JSON.stringify({ type: 'owned_host_mcp', status: value.extension.name }) + '\\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: 'owned_host_mcp', error: error.message }) + '\\n');
  }
};\n`);
  const child = spawn(process.execPath, [join(sdk.getPackageDir(), 'dist/cli.js'), '--mode', 'rpc', '--offline',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '-e', entry,
    '--session-dir', join(root, 'sessions')], { cwd: root, env: {
      PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, TERM: 'dumb',
      NODE_OPTIONS: `--import ${pathToFileURL(guard).href}`,
    }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = '', result: any;
  const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
  try {
    const inspect = (text: string) => {
      for (const line of text.split('\n')) {
        try { const value = JSON.parse(line); if (value.type === 'owned_host_mcp') { result = value; child.stdin.end(); } } catch {}
      }
    };
    child.stdout.on('data', bytes => { output += bytes; inspect(output); });
    child.stderr.on('data', bytes => { stderr += bytes; inspect(stderr); });
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    assert.ok(result, `Real CLI must produce a fresh host-mapping result: ${stderr}`);
    assert.equal(result.status, 'task-agents-mcp', result.error);
    assert.equal(code, 0, stderr);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM'); }
});

test('Pi loads the plugin and child MCP with host-provided peers and no package node_modules', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-host-peers-'));
  const pkg = join(root, 'package'), agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
  await Promise.all([mkdir(pkg), mkdir(agentDir), mkdir(cwd)]);
  await Promise.all(['src', 'prompts', 'package.json'].map(path => cp(join(project, path), join(pkg, path), { recursive: true })));
  await assert.rejects(readFile(join(pkg, 'node_modules', '@earendil-works/pi-coding-agent', 'package.json')), { code: 'ENOENT' });
  const entry = join(root, 'entry.ts'), audit = join(root, 'mcp.jsonl');
  await writeFile(entry, `import { registerTaskAgents } from ${JSON.stringify(pathToFileURL(join(pkg, 'src/extension.ts')).href)};\nexport default pi => registerTaskAgents(pi, { agentDir: ${JSON.stringify(agentDir)} });\n`);
  await writeFile(join(agentDir, 'task-agents.json'), JSON.stringify({ roles: { worker: {
    tools: ['mcp__owned__echo'], skills: [], extensions: [],
  } } }));
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { owned: {
    command: process.execPath, args: [server, audit, 'host-peer'], exposure: 'direct',
  } } }));
  const model = { provider: 'offline', id: 'local', api: 'test', reasoning: false, input: ['text'], contextWindow: 10000,
    maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let calls = 0, runtimeCreations = 0;
  const runtime = {
    getModel: () => model, getModels: () => [], getProviders: () => [], hasConfiguredAuth: () => true,
    getRegisteredProviderIds: () => [], getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined,
    resolveModel: async () => ({ model, thinkingLevel: 'off' }),
    streamSimple(_model: unknown, context: unknown) {
      const message = ++calls === 1 ? answer('', { stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'host-peer', name: 'mcp__owned__echo', arguments: { value: 'host-peer' } },
      ] }) : answer('HOST_PEER_READY');
      if (calls === 2) assert.match(JSON.stringify(context), /OWNED_MCP_ECHO:host-peer:1:host-peer/);
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
    },
  };
  t.mock.method(sdk.ModelRuntime, 'create', async () => { runtimeCreations++; return runtime as any; });
  const settings = sdk.SettingsManager.inMemory({ packages: [], skills: [], extensions: [entry], cacheWarming: 'off' }, { projectTrusted: false });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noContextFiles: true, noPromptTemplates: true, noThemes: true });
  let parent: sdk.AgentSession | undefined;
  const errors: unknown[] = [];
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session: parent } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime as any,
      model: model as any, thinkingLevel: 'off', settingsManager: settings,
      sessionManager: sdk.SessionManager.create(cwd, join(root, 'parent-history')) }));
    await parent.bindExtensions({ mode: 'json', onError: error => errors.push(error), abortHandler() {}, shutdownHandler() {} });
    const task = parent.agent.state.tools.find(tool => tool.name === 'task');
    assert.ok(task, 'Native extension loading must register the public Task entry');
    const result = await task.execute('owned-host-peer', { agent_name: 'worker', description: 'Owned host-peer probe', prompt: 'Use the owned local MCP fixture' });
    const details = result.details as Record<string, any>;
    assert.equal(details.status, 'succeeded', JSON.stringify(result.content));
    assert.equal(details.final_text, 'HOST_PEER_READY');
    assert.equal(calls, 2); assert.ok(runtimeCreations > 0, 'Child must use the default SDK factory through host module mapping');
    const events = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.method === 'tools/call').length, 1);
    assert.deepEqual(errors, []);
  } finally {
    try { await parent?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); await parent?.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
