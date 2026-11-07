import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import { registerTaskAgents } from '../src/extension.ts';
import { answer, fixture, tool } from './pi-backend-test-helpers.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

const server = fileURLToPath(new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url));

test('default controller gives every role the main session Skills, extensions and MCP', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-inherit-'));
  const agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
  const extensions = join(agentDir, 'extensions'), skillDir = join(agentDir, 'skills', 'owned-inherited-skill');
  await Promise.all([mkdir(extensions, { recursive: true }), mkdir(skillDir, { recursive: true }), mkdir(cwd)]);
  const skillPath = join(skillDir, 'SKILL.md'), extensionPath = join(extensions, 'owned.ts');
  const disabledPath = join(extensions, 'disabled.ts'), disabledMarker = join(root, 'disabled-loaded');
  const audit = join(root, 'mcp.jsonl');
  await writeFile(skillPath, '---\nname: owned-inherited-skill\ndescription: OWNED_SKILL_METADATA\n---\nOWNED_SKILL_BODY\n');
  const mcpConfig = (label: string) => ({ command: process.execPath, args: [server, audit, label], exposure: 'direct' });
  await writeFile(extensionPath, `export default pi => {
    pi.registerTool({ name: 'owned_extension', label: 'Owned extension', description: 'Owned inherited extension',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'OWNED_EXTENSION_RESULT' }], details: {} }) });
    pi.registerMcpServer('extension-owned', ${JSON.stringify(mcpConfig('extension'))});
  };`);
  await writeFile(disabledPath, `import { writeFileSync } from 'node:fs'; export default () => writeFileSync(${JSON.stringify(disabledMarker)}, 'unexpected');`);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ extensions: [`-${disabledPath}`], cacheWarming: 'off' }));
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    owned: mcpConfig('file'), disabled: { ...mcpConfig('disabled'), enabled: false },
  } }));
  await writeFile(join(agentDir, 'task-agents.json'), JSON.stringify({ roles: {
    explore: { tools: ['read', 'grep', 'find', 'ls'] },
    verifier: { tools: ['read', 'grep', 'find', 'ls'] },
    disabled: { extensions: [], skills: [], mcp: false },
  } }));
  const model = { provider: 'offline', id: 'local', api: 'test', reasoning: false, input: ['text'], contextWindow: 10000,
    maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let role = '', step = 0;
  const completed: string[] = [];
  const runtime = {
    getModel: () => model, getModels: () => [], getProviders: () => [], hasConfiguredAuth: () => true,
    getRegisteredProviderIds: () => [], getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined,
    resolveModel: async () => ({ model, thinkingLevel: 'off' }),
    streamSimple(_model: unknown, context: unknown) {
      const result = (async () => {
        const text = JSON.stringify(context);
        if (role !== 'main') assert.doesNotMatch(text, /PARENT_HISTORY_SECRET/);
        if (role === 'agent:disabled') {
          assert.doesNotMatch(text, /OWNED_SKILL_METADATA|owned_extension|mcp__owned__|mcp__extension_owned__/);
          completed.push(role);
          return answer('RESOURCES_DISABLED');
        }
        if (++step === 1) {
          assert.match(text, /OWNED_SKILL_METADATA/, `${role} must see the inherited skill before selecting tools`);
          return answer('', { stopReason: 'toolUse', content: [
            { type: 'toolCall', id: `${role}-skill`, name: 'read', arguments: { path: skillPath } },
            { type: 'toolCall', id: `${role}-extension`, name: 'owned_extension', arguments: {} },
            { type: 'toolCall', id: `${role}-mcp-file`, name: 'mcp__owned__echo', arguments: { value: role } },
            { type: 'toolCall', id: `${role}-mcp-extension`, name: 'mcp__extension_owned__echo', arguments: { value: role } },
          ] });
        }
        assert.match(text, /OWNED_SKILL_BODY/);
        assert.match(text, /OWNED_EXTENSION_RESULT/);
        assert.match(text, new RegExp(`OWNED_MCP_ECHO:file:[0-9]+:${role}`));
        assert.match(text, new RegExp(`OWNED_MCP_ECHO:extension:[0-9]+:${role}`));
        completed.push(role);
        return answer(`RESOURCES_USED:${role}`);
      })();
      return { async *[Symbol.asyncIterator]() { const message = await result; yield { type: 'done', reason: message.stopReason, message }; }, result: () => result };
    },
  };
  t.mock.method(sdk.ModelRuntime, 'create', async () => runtime as any);
  let controller: ReturnType<typeof registerTaskAgents> | undefined, ctx: ExtensionContext | undefined;
  let parent: sdk.AgentSession | undefined;
  const errors: unknown[] = [];
  try {
    const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const { loadMcpConfig } = await import(new URL('./extensions/mcp/config.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [sdk.createCodemodeExtension({ mode: 'on', models: false }), sdk.createMcpExtension({ startupWaitMs: 10000,
        loadConfig: () => loadMcpConfig({ cwd, agentDir, projectTrusted: false }), logPath: join(root, 'parent-mcp.log'),
      }), (pi) => {
        controller = registerTaskAgents(pi, { agentDir });
        pi.on('session_start', (_event, context) => { ctx = context; });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(loader.getExtensions().extensions.some(entry => entry.resolvedPath === extensionPath));
    assert.ok(loader.getSkills().skills.some(skill => skill.name === 'owned-inherited-skill'));
    const manager = sdk.SessionManager.create(cwd, join(root, 'parent-history'));
    manager.appendMessage({ role: 'user', content: 'PARENT_HISTORY_SECRET', timestamp: Date.now() });
    ({ session: parent } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader,
      modelRuntime: runtime as any, model: model as any, thinkingLevel: 'off', settingsManager: settings, sessionManager: manager }));
    await parent.bindExtensions({ mode: 'json', onError: error => errors.push(error), abortHandler() {}, shutdownHandler() {} });
    assert.ok(ctx); assert.ok(controller);
    role = 'main'; step = 0;
    await parent.prompt('Use the available owned resources');
    assert.deepEqual(completed, ['main']);
    const mainTools = parent.getCallableToolNames();
    for (const name of ['owned_extension', 'mcp__owned__echo', 'mcp__extension_owned__echo']) assert.ok(mainTools.includes(name), `main missing ${name}`);
    parent.setActiveToolsByName([...parent.getActiveToolNames(), 'codemode']);
    assert.ok(parent.getActiveToolNames().includes('codemode'));
    for (const name of ['explore', 'worker', 'verifier', 'mavis']) {
      role = name; step = 0;
      const result = await controller.start({ agent_name: name, description: `Inherited resources ${name}`, prompt: 'Use the available owned resources' }, name, undefined, parent.extensionRunner.createToolContext(name, undefined));
      assert.equal(result.status, 'succeeded', `${name}: ${result.error}`);
      assert.equal(result.final_text, `RESOURCES_USED:${name}`);
      assert.ok(controller.engine.task(result.task_id).profile.nativeToolSnapshot.includes('codemode'), name);
    }
    parent.setActiveToolsByName(parent.getActiveToolNames().filter(name => name !== 'codemode'));
    assert.deepEqual(completed, ['main', 'explore', 'worker', 'verifier', 'mavis']);
    role = 'agent:disabled'; step = 0;
    const disabled = await controller.start({ agent_name: role, description: 'Explicit resource denial', prompt: 'Check the available tools' }, role, undefined, parent.extensionRunner.createToolContext(role, undefined));
    assert.equal(disabled.status, 'succeeded', disabled.error);
    assert.equal(disabled.final_text, 'RESOURCES_DISABLED');
    assert.equal(completed.at(-1), role);
    await assert.rejects(readFile(disabledMarker), { code: 'ENOENT' });
    const events = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.some(event => event.label === 'disabled'), false);
    assert.equal(events.filter(event => event.method === 'tools/call' && event.label === 'file').length, 5);
    assert.equal(events.filter(event => event.method === 'tools/call' && event.label === 'extension').length, 5);
    assert.deepEqual(errors, []);
  } finally {
    try { await controller?.shutdown(); }
    finally {
      try { await parent?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); await parent?.dispose(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
});

test('inherited MCP tools also execute through native codemode', { timeout: 15000 }, async t => {
  const f = await fixture(t, { isCodemodeEnabled: () => true });
  const audit = join(f.root, 'mcp.jsonl');
  await writeFile(join(f.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { owned: {
    command: process.execPath, args: [server, audit, 'codemode'], exposure: 'codemode',
  } } }));
  let calls = 0;
  f.script((step, context) => {
    calls++;
    if (step === 1) return tool('codemode', { code: "text(await tools.mcp__owned__echo({ value: 'codemode' }));" });
    assert.match(JSON.stringify(context), /OWNED_MCP_ECHO:codemode:1:codemode/);
    return answer('CODEMODE_RESOURCE_USED');
  });
  const child = await f.child({ tools: ['read', 'grep', 'find', 'ls'], skills: undefined, extensions: undefined, mcp: undefined });
  assert.equal((await child.prompt('Use the inherited MCP tool through codemode')).text, 'CODEMODE_RESOURCE_USED');
  assert.equal(calls, 2);
  const events = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.method === 'tools/call').length, 1);
});
