import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
import { registerTaskAgents } from '../src/extension.ts';
import { answer, tool } from './pi-backend-test-helpers.ts';

async function setup(t, { resourcesDisabled = false, prefix = '', runtimeSkill = false, runtimeMcp = false,
  role = {}, extraFactories = [], customShell = false, codemode = false, maxThinking = false, withoutMcp = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-runtime-inheritance-'));
  const agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
  const skill = join(agentDir, 'skills', 'owned-runtime-skill'), extension = join(agentDir, 'extensions', 'owned.ts');
  const marker = join(root, 'extension-started'), injected = join(root, 'runtime-only-skill');
  await mkdir(injected);
  await writeFile(join(injected, 'SKILL.md'), '---\nname: runtime-only-skill\ndescription: OWNED_RUNTIME_ONLY_SKILL\n---\nRuntime fixture.\n');
  await Promise.all([mkdir(skill, { recursive: true }), mkdir(join(agentDir, 'extensions'), { recursive: true }), mkdir(cwd)]);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: owned-runtime-skill\ndescription: OWNED_DISABLED_SKILL_METADATA\n---\nFixture-only skill.\n');
  await writeFile(extension, `import { writeFileSync } from 'node:fs'; export default pi => {
    writeFileSync(${JSON.stringify(marker)}, 'loaded');
    pi.registerTool({ name: 'owned_runtime_tool', label: 'Owned', description: 'Owned fixture tool',
      parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'owned' }] }) });
    pi.on('before_agent_start', () => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ loaded: true, active: pi.getActiveTools() })));
  };`);
  const shell = join(root, 'owned-shell.sh'), shellMarker = join(root, 'shell-started');
  if (customShell) await writeFile(shell, `#!/bin/sh\nprintf 'shell-started\\n' >> ${JSON.stringify(shellMarker)}\nexec /bin/sh "$@"\n`, { mode: 0o700 });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ shellCommandPrefix: prefix, ...(customShell ? { shellPath: shell } : {}), cacheWarming: 'off', retry: { enabled: false }, compaction: { enabled: false } }));
  await writeFile(join(agentDir, 'task-agents.json'), JSON.stringify({ roles: { worker: { ...(!runtimeMcp ? { mcp: false } : {}),
    ...(!resourcesDisabled && !runtimeSkill && !runtimeMcp && !extraFactories.length ? { extensions: [], skills: [] } : {}),
    ...(typeof role === 'function' ? role({ skill, extension }) : role) } } }));
  const model = maxThinking ? (await sdk.ModelRuntime.create({ authPath: join(root, 'model-auth.json'),
    modelsPath: join(root, 'model-config.json'), modelsStorePath: join(root, 'model-catalog.json'),
    allowModelNetwork: false, refreshOnCreate: false })).getModel('anthropic', 'claude-opus-4-6') :
    { provider: 'offline', id: 'local', api: 'test', reasoning: false, input: ['text'], contextWindow: 10000,
      maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.ok(model);
  let mode = 'main', step = 0, script = () => answer('done'), controller, ctx, parent, api, childIndex = 0;
  const runtime = { getModel: () => model, getModels: () => [], getProviders: () => [], hasConfiguredAuth: () => true,
    getRegisteredProviderIds: () => [], getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined,
    resolveModel: async () => ({ model, thinkingLevel: maxThinking ? 'max' : 'off' }),
    streamSimple(_model, context) {
      const result = Promise.resolve(script(++step, context, mode));
      return { async *[Symbol.asyncIterator]() { const message = await result; yield { type: 'done', reason: message.stopReason, message }; }, result: () => result };
    } };
  t.mock.method(sdk.ModelRuntime, 'create', async () => runtime);
  const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
    noExtensions: resourcesDisabled, noSkills: resourcesDisabled, disabledBuiltinExtensions: withoutMcp ? ['mcp'] : undefined,
    extensionFactories: [
      ...(codemode ? [sdk.createCodemodeExtension({ mode: 'on', models: false })] : []),
      ...(runtimeMcp ? [sdk.createMcpExtension({ startupWaitMs: 10000,
        loadConfig: () => ({ servers: [], errors: [] }), logPath: join(root, 'parent-mcp.log') }),
        { name: 'owned-runtime-mcp-registration', factory: pi => pi.registerMcpServer('ownedruntime', { command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url)), join(root, 'mcp-audit.jsonl'), 'runtime-only'], exposure: 'direct' }) }] : []),
      ...(runtimeSkill ? [{ name: 'owned-runtime-skill-contribution', factory: pi => {
        pi.on('resources_discover', () => ({ skillPaths: [injected] }));
      } }] : []),
      ...extraFactories,
      { name: 'owned-task-plugin', factory: pi => {
        api = pi;
        controller = registerTaskAgents(pi, { agentDir });
        pi.on('session_start', (_event, context) => { ctx = context; });
      } }] });
  t.after(async () => {
    try { await controller?.shutdown(); }
    finally { try { await parent?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); await parent?.dispose(); }
      finally { await rm(root, { recursive: true, force: true }); } }
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  ({ session: parent } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader,
    modelRuntime: runtime, model, thinkingLevel: maxThinking ? 'max' : 'off', settingsManager: settings,
    sessionManager: sdk.SessionManager.create(cwd, join(root, 'parent')) }));
  const errors = [];
  await parent.bindExtensions({ mode: 'json', onError: error => errors.push(error), abortHandler() {}, shutdownHandler() {} });
  assert.ok(controller); assert.ok(ctx); assert.deepEqual(errors, []);
  if (codemode) parent.setActiveToolsByName([...parent.getActiveToolNames(), 'codemode']);
  return { root, cwd, agentDir, loader, parent, marker, shellMarker, settings, get api() { return api; }, get controller() { return controller; }, get ctx() { return ctx; },
    script(fn, nextMode = 'main') { mode = nextMode; step = 0; script = fn; },
    async child(overrides = {}) { return controller.start({ agent_name: 'worker', description: 'Runtime inheritance probe',
      prompt: 'Use only the assigned fixture.', ...overrides }, 'owned-' + ++childIndex, undefined,
        parent.extensionRunner.createToolContext('owned-admission-' + childIndex, undefined)); },
    toolContext(id = 'owned-control') { return parent.extensionRunner.createToolContext(id, undefined); } };
}

test('default controller respects parent-session noSkills/noExtensions instead of rediscovering disabled resources', { timeout: 15000 }, async t => {
  const f = await setup(t, { resourcesDisabled: true });
  assert.deepEqual(f.loader.getSkills().skills, []);
  assert.equal(f.parent.getAllTools().some(tool => tool.name === 'owned_runtime_tool'), false);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  let childSkill = false, childTool = false;
  f.script((_step, context) => {
    const text = JSON.stringify(context); childSkill = text.includes('OWNED_DISABLED_SKILL_METADATA');
    childTool = context.tools?.some(tool => tool.name === 'owned_runtime_tool') === true;
    return answer('done');
  }, 'child');
  const result = await f.child(); assert.equal(result.status, 'succeeded', result.error);
  const childLoaded = await readFile(f.marker, 'utf8').catch(() => undefined);
  if (childLoaded) childTool = JSON.parse(childLoaded).active.includes('owned_runtime_tool');
  assert.equal(childSkill, false); assert.equal(childTool, false); assert.equal(childLoaded, undefined);
});

test('default controller carries parent runtime resources_discover Skill contributions', { timeout: 15000 }, async t => {
  const f = await setup(t, { runtimeSkill: true });
  const observed = {};
  const script = (_step, context, mode) => { observed[mode] = JSON.stringify(context).includes('OWNED_RUNTIME_ONLY_SKILL'); return answer('done'); };
  f.script(script); await f.parent.prompt('Use no tools.');
  assert.equal(observed.main, true);
  f.script(script, 'child'); const result = await f.child(); assert.equal(result.status, 'succeeded', result.error);
  assert.equal(observed.child, true);
});

test('default controller carries an enabled runtime-only parent MCP registration', { timeout: 20000 }, async t => {
  const f = await setup(t, { runtimeMcp: true });
  const observed = {};
  const script = (step, context, mode) => {
    if (step === 1) return tool('mcp__ownedruntime__echo', { value: mode });
    const reply = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'mcp__ownedruntime__echo');
    observed[mode + 'Reply'] = reply?.content?.filter(part => part.type === 'text').map(part => part.text).join('');
    observed[mode] = /OWNED_MCP_ECHO:runtime-only:\d+:/.test(observed[mode + 'Reply'] ?? '') && observed[mode + 'Reply'].includes(':' + mode);
    return answer('done');
  };
  f.script(script); await f.parent.prompt('Call only the owned local stdio fixture.');
  assert.equal(observed.main, true);
  f.script(script, 'child'); const result = await f.child();
  assert.equal(result.status, 'succeeded', result.error); assert.equal(observed.child, true);
});

test('default controller preserves the configured native shell prefix used by the actual parent', { timeout: 15000 }, async t => {
  const f = await setup(t, { prefix: 'export OWNED_SHELL_PREFIX=PARENT_PREFIX' });
  const observed = {};
  const script = (step, context, mode) => {
    if (step === 1) return tool('bash', { command: 'printf "%s" "${OWNED_SHELL_PREFIX-UNSET}"' });
    const output = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'bash');
    assert.ok(output); observed[mode] = output.content.filter(part => part.type === 'text').map(part => part.text).join('');
    return answer('done');
  };
  f.script(script); await f.parent.prompt('Run only the assigned fixture command.');
  assert.equal(observed.main, 'PARENT_PREFIX');
  f.script(script, 'child'); const result = await f.child(); assert.equal(result.status, 'succeeded', result.error);
  assert.equal(observed.child, observed.main);
});

for (const selection of ['inherit', 'input', 'role']) test('native max thinking survives default admission: ' + selection, { timeout: 15000 }, async t => {
  const f = await setup(t, { maxThinking: true, role: selection === 'role' ? { thinking: 'max' } : {} });
  assert.ok(f.parent.getAvailableThinkingLevels().includes('max'));
  assert.equal(f.parent.thinkingLevel, 'max'); assert.equal(f.api.getThinkingLevel(), 'max');
  f.script(() => answer('owned max reply', { api: 'anthropic-messages', provider: 'anthropic', model: 'claude-opus-4-6' }), 'child');
  const result = await f.child(selection === 'input' ? { effort: 'max' } : {});
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(f.controller.engine.task(result.task_id).profile.thinking, 'max');
});

test('MCP-off event observers preserve a null snapshot and default child admission', { timeout: 15000 }, async t => {
  const f = await setup(t, { withoutMcp: true, extraFactories: [{ name: 'owned-mcp-observer',
    factory: pi => pi.on('mcp_servers_change', () => {}) }] });
  assert.equal(typeof f.api.getResources, 'undefined');
  assert.equal(f.parent.getAllTools().some(tool => tool.name.startsWith('mcp__')), false);
  f.script(() => answer('owned observer reply'), 'child');
  const result = await f.child(); assert.equal(result.status, 'succeeded', result.error);
});

test('role paths cannot resurrect files and Skills disabled in the parent', async t => {
  const f = await setup(t, { resourcesDisabled: true, role: ({ skill, extension }) => ({ extensions: [extension], skills: [skill] }) });
  let advertised;
  f.script((_step, context) => { advertised = JSON.stringify(context); return answer('done'); }, 'child');
  assert.equal((await f.child()).status, 'succeeded');
  assert.equal(advertised.includes('OWNED_DISABLED_SKILL_METADATA'), false);
  assert.equal(advertised.includes('owned_runtime_tool'), false);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});

test('parent hook-only factories are not re-executed and child history stays independent', async t => {
  const apis = [], sessions = [];
  const f = await setup(t, { extraFactories: [{ name: 'hook-only', factory: pi => {
    apis.push(pi); pi.on('session_start', (_event, ctx) => { sessions.push(ctx.sessionManager.getSessionId()); });
  } }] });
  f.script(() => answer('parent-only-marker')); await f.parent.prompt('Parent-only-briefing-7a8d.');
  let childContext;
  f.script((_step, context) => { childContext = JSON.stringify(context); return answer('done'); }, 'child');
  const result = await f.child(); assert.equal(result.status, 'succeeded', result.error);
  assert.equal(apis.length, 1);
  assert.deepEqual(sessions, [f.parent.sessionId]);
  assert.equal(childContext.includes('Parent-only-briefing-7a8d'), false);
  assert.equal(childContext.includes('parent-only-marker'), false);
});

test('role Skills disable survives inherited resources_discover hooks', async t => {
  const f = await setup(t, { runtimeSkill: true, role: { skills: [] } });
  f.script(() => answer('done')); await f.parent.prompt('Use no tools.');
  assert.ok(f.loader.getSkills().skills.some(skill => skill.name === 'runtime-only-skill'));
  let advertised;
  f.script((_step, context) => { advertised = JSON.stringify(context); return answer('done'); }, 'child');
  const result = await f.child(); assert.equal(result.status, 'succeeded', result.error);
  assert.equal(advertised.includes('OWNED_RUNTIME_ONLY_SKILL'), false);
});

for (const role of [{ extensions: [] }, { mcp: false }]) test('role narrowing does not reconnect a forbidden runtime MCP: ' + JSON.stringify(role), async t => {
  const f = await setup(t, { runtimeMcp: true, role });
  f.script(() => answer('done')); await f.parent.prompt('Use no tools.');
  const before = await readFile(join(f.root, 'mcp-audit.jsonl'), 'utf8');
  let advertised;
  f.script((_step, context) => { advertised = context.tools?.map(tool => tool.name) ?? []; return answer('done'); }, 'child');
  const result = await f.child(); assert.equal(result.status, 'succeeded', result.error);
  assert.equal(advertised.some(name => name.startsWith('mcp__ownedruntime__')), false);
  assert.equal(await readFile(join(f.root, 'mcp-audit.jsonl'), 'utf8'), before);
});

test('real SDK reload restores child identity ceilings without executing a newly accepted hook', async t => {
  const f = await setup(t, { role: { extensions: undefined, skills: [] } });
  f.script(() => answer('first'), 'child');
  const first = await f.child(); assert.equal(first.status, 'succeeded', first.error);
  const marker = join(f.root, 'new-hook-started'), oldApi = f.api;
  await writeFile(join(f.agentDir, 'extensions/new-hook.ts'), `import { appendFileSync } from 'node:fs';
export default pi => { appendFileSync(${JSON.stringify(marker)}, 'initialized\\n'); pi.on('before_agent_start', () => {}); };`);
  await f.parent.reload();
  assert.equal(await readFile(marker, 'utf8'), 'initialized\n');
  assert.throws(() => oldApi.getSettings(), /active|reload|invalid|dispos/i);
  f.script(() => answer('continued'), 'child');
  const restored = await f.controller.send({ task_id: first.task_id, content: 'Continue only the owned fixture.' },
    'restore-after-reload', undefined, f.toolContext());
  assert.equal(restored.status, 'succeeded', restored.error);
  assert.equal(restored.session_id, first.session_id);
  assert.equal(await readFile(marker, 'utf8'), 'initialized\n');
});

test('managed Bash inherits the actual parent shell executable and prefix', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const f = await setup(t, { prefix: 'export OWNED_SHELL_PREFIX=MANAGED_PREFIX', customShell: true });
  const command = 'printf "%s" "${OWNED_SHELL_PREFIX-UNSET}"';
  f.script(step => step === 1 ? tool('bash', { command }) : answer('parent'));
  await f.parent.prompt('Run only the assigned native shell fixture.');
  assert.equal(await readFile(f.shellMarker, 'utf8'), 'shell-started\n');
  const target = join(f.cwd, 'managed-prefix.txt');
  f.script((step, context) => {
    if (step === 1) return tool('bash_task', { action: 'start', command: command + ' > ' + JSON.stringify(target) });
    const message = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'bash_task');
    const previous = JSON.parse(message.content.filter(part => part.type === 'text').map(part => part.text).join(''));
    if (step === 2 || previous.status === 'running') return tool('bash_task', { action: 'output', command_id: previous.command_id, wait_ms: 5000 });
    assert.equal(previous.status, 'succeeded'); return answer('managed');
  }, 'child');
  const result = await f.child(); assert.equal(result.status, 'succeeded', result.error);
  assert.equal(await readFile(target, 'utf8'), 'MANAGED_PREFIX');
  assert.equal(await readFile(f.shellMarker, 'utf8'), 'shell-started\nshell-started\n');
  assert.ok(result.verification.changedFiles.includes('managed-prefix.txt'));
});

test('native codemode uses the same inherited shell settings without a parallel executor', { skip: process.platform === 'win32' }, async t => {
  const f = await setup(t, { prefix: 'export OWNED_SHELL_PREFIX=CODEMODE_PREFIX', customShell: true, codemode: true });
  assert.ok(f.parent.getActiveToolNames().includes('codemode'));
  for (const mode of ['main', 'child']) {
    const target = join(f.cwd, 'codemode-prefix-' + mode + '.txt');
    const command = 'printf "%s" "${OWNED_SHELL_PREFIX-UNSET}" > ' + JSON.stringify(target);
    f.script(step => step === 1 ? tool('codemode', { code: 'text(await tools.bash(' + JSON.stringify({ command }) + '));' }) : answer('done'), mode);
    if (mode === 'main') await f.parent.prompt('Run only the assigned native codemode fixture.');
    else { const result = await f.child(); assert.equal(result.status, 'succeeded', result.error); }
    assert.equal(await readFile(target, 'utf8'), 'CODEMODE_PREFIX');
  }
  assert.equal(await readFile(f.shellMarker, 'utf8'), 'shell-started\nshell-started\n');
});
