import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPiChildFactory } from '../src/pi-backend.ts';
import type {
  AgentSession,
  CreateAgentSessionOptions,
  CreateModelRuntimeOptions,
  LoadedMcpConfig,
  PromptOptions,
} from '@earendil-works/pi-coding-agent';
import type { AgentProfile, ChildSession, CreateChild, CreateChildOptions } from '../src/types.ts';

type InstalledSdk = typeof import('@earendil-works/pi-coding-agent');
type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
type TestContent = { type: 'text'; text: string } | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
interface TestAssistant {
  role: 'assistant';
  stopReason: StopReason;
  content: TestContent[];
  usage: { input: number; output: number; totalTokens: number; cost: { total: number } };
  errorMessage?: string;
  api?: string;
  provider?: string;
  model?: string;
  timestamp?: number;
}
type TestEvent = { type: 'message_end'; message: TestAssistant }
  | { type: 'agent_settled'; aborted: boolean }
  | { type: 'agent_end'; willRetry: boolean; messages: unknown[] }
  | { type: 'auto_retry_start' }
  | { type: 'message_update'; assistantMessageEvent: { type: 'thinking_delta'; delta: string } }
  | { type: 'tool_execution_start'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_execution_end'; toolName: string; isError: boolean; result: unknown };
type TestPromptOptions = Required<Pick<PromptOptions, 'expandPromptTemplates' | 'source' | 'preflightResult'>>;
type TestBehavior = (session: FakeSession, text: string, options: TestPromptOptions) => Promise<void> | void;
type GuardHandler = (event: { toolName: string }) => { block: boolean; reason: string } | void;
type FakeFactory = (api: { on(name: string, callback: GuardHandler): void }) => void | Promise<void>;
interface FakeLoaderOptions {
  noExtensions: boolean;
  noSkills: boolean;
  noPromptTemplates: boolean;
  noThemes: boolean;
  additionalExtensionPaths: string[];
  additionalSkillPaths: string[];
  disabledBuiltinExtensions: string[];
  extensionFactories: FakeFactory[];
  systemPromptOverride(base: string): string | undefined;
  promptsOverride(base: { prompts: string[] }): { prompts: string[] };
  themesOverride(base: { themes: string[] }): { themes: string[] };
  appendSystemPromptOverride(): string[];
}
interface FakeLoader {
  options: FakeLoaderOptions;
  reload(): Promise<void>;
  getExtensions(): { extensions: unknown[]; errors: unknown[] };
  getSkills(): { skills: unknown[]; diagnostics: unknown[] };
}
type TestSettings = NonNullable<Parameters<InstalledSdk['SettingsManager']['inMemory']>[0]>;
interface FakeSessionOptions {
  modelRuntime: unknown;
  model: { provider: string; id: string };
  tools: string[];
  thinkingLevel: AgentProfile['thinking'];
  resourceLoader: FakeLoader;
  sessionManager: { getSessionFile(): string };
  settingsManager: { settings: TestSettings };
}
interface FakeBindings {
  mode?: string;
}
interface FakeMcpOptions {
  loadConfig(): LoadedMcpConfig;
  updateConfig(): never;
  openUrl(): never;
}
interface FakeSession {
  options: FakeSessionOptions;
  calls: unknown[][];
  isIdle: boolean;
  thinkingLevel: AgentProfile['thinking'];
  emit(event: TestEvent): void;
  subscribe(listener: (event: TestEvent) => void): () => void;
  bindExtensions(bindings: FakeBindings): Promise<void>;
  getCallableToolNames(): string[];
  extensionRunner: { hasHandlers(): boolean; emit(event: { type: string }): Promise<void> };
  prompt(text: string, options: TestPromptOptions): Promise<void>;
  answer(message?: string | TestAssistant): void;
  settle(aborted?: boolean): void;
  abort(): Promise<void>;
  steer(text: string): Promise<void>;
  dispose(): void;
}
interface FakeState {
  sessions: FakeSession[];
  loaders: FakeLoader[];
  options: FakeSessionOptions[];
  shutdowns: number;
  disposals: number;
  reloads?: number;
  mcpConfig?: { agentDir: string; cwd: string; projectTrusted: boolean };
  mcpOptions?: FakeMcpOptions;
  clampedThinking?: AgentProfile['thinking'];
  bindings?: FakeBindings;
  guardHandlers?: { name: string; callback: GuardHandler }[];
  unexpected?: string[];
  failBind?: boolean;
  failShutdown?: boolean;
  unsubscribed?: boolean;
  listenersAtDispose?: number;
}
interface FakeSdk {
  SettingsManager: { inMemory(settings: TestSettings): { settings: TestSettings } };
  DefaultResourceLoader: new (options: FakeLoaderOptions) => FakeLoader;
  SessionManager: { open(path: string, dir: string, cwd: string): { getSessionFile(): string } };
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
  createMcpExtension(options: FakeMcpOptions): FakeFactory;
  createAgentSession(options: FakeSessionOptions): Promise<{ session: FakeSession }>;
  ModelRuntime?: { create(options: CreateModelRuntimeOptions): Promise<typeof modelRuntime> };
}
interface Fixture {
  root: string;
  sdk: FakeSdk;
  state: FakeState;
  options: CreateChildOptions;
  output: string[];
  activity: string[];
  factory: CreateChild;
}
interface LocalModel {
  provider: string;
  id: string;
  api: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
interface LocalContext {
  messages: { role: string; toolsRemoved?: { name: string }[]; toolsAdded?: { name: string }[];
    toolName?: string; isError?: boolean; content?: unknown }[];
}
interface LocalEventStream {
  [Symbol.asyncIterator](): AsyncGenerator<{ type: 'done'; reason: StopReason; message: TestAssistant }>;
  result(): Promise<TestAssistant>;
}
interface LocalRuntime {
  getModel(provider: string, id: string): LocalModel;
  getModels(): never[];
  getProviders(): never[];
  hasConfiguredAuth(): boolean;
  resolveModel(model: LocalModel): Promise<{ model: LocalModel; thinkingLevel: 'off' }>;
  streamSimple(model: LocalModel, context: LocalContext): LocalEventStream;
}
interface RealFixture {
  sdk: InstalledSdk;
  root: string;
  agentDir: string;
  runtime: LocalRuntime;
  factory: CreateChild;
  options: CreateChildOptions;
  session(): AgentSession;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const modelRuntime = { getModel: (provider: string, id: string): { provider: string; id: string } | undefined => provider === 'test' ? { provider, id } : undefined };
// Deliberately omit optional runtime defaults to cover callers that bypass configuration loading.
const profile = Object.freeze({ name: 'reader', model: 'test/model/with/slash', thinking: 'low', instructions: 'Inspect only.' }) as AgentProfile;
const assistant = (text = 'Done', stopReason: StopReason = 'stop'): TestAssistant => ({
  role: 'assistant', stopReason, content: [{ type: 'thinking', thinking: 'private chain' }, { type: 'text', text }],
  usage: { input: 3, output: 2, totalTokens: 5, cost: { total: 0.01 } },
});
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeSdk(behavior: TestBehavior = async (session): Promise<void> => { session.answer(); session.settle(); }): { sdk: FakeSdk; state: FakeState } {
  const state: FakeState = { sessions: [], loaders: [], options: [], shutdowns: 0, disposals: 0 };
  class Loader implements FakeLoader {
    options: FakeLoaderOptions;
    constructor(options: FakeLoaderOptions) { this.options = options; state.loaders.push(this); }
    async reload(): Promise<void> { state.reloads = (state.reloads ?? 0) + 1; }
    getExtensions(): ReturnType<FakeLoader['getExtensions']> { return { extensions: [], errors: [] }; }
    getSkills(): ReturnType<FakeLoader['getSkills']> { return { skills: [], diagnostics: [] }; }
  }
  const sdk: FakeSdk = {
    SettingsManager: { inMemory: (settings) => ({ settings }) },
    DefaultResourceLoader: Loader,
    SessionManager: { open(path, dir, cwd) {
      if (!readFileSync(path, 'utf8')) writeFileSync(path, JSON.stringify({ type: 'session', version: 3, id: 'session-id', cwd }) + '\n');
      return { getSessionFile: () => path };
    } },
    loadMcpConfig: (options) => { state.mcpConfig = options; return { servers: [], errors: [] }; },
    createMcpExtension: (options) => { state.mcpOptions = options; return () => {}; },
    async createAgentSession(options) {
      state.options.push(options);
      const listeners = new Set<(event: TestEvent) => void>();
      const session: FakeSession = {
        options, calls: [], isIdle: true, thinkingLevel: state.clampedThinking ?? options.thinkingLevel,
        emit(event) { for (const listener of listeners) listener(event); },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); state.unsubscribed = true; }; },
        async bindExtensions(bindings) {
          state.bindings = bindings;
          state.guardHandlers = [];
          for (const factory of options.resourceLoader.options.extensionFactories) {
            await factory({ on: (name, callback) => state.guardHandlers!.push({ name, callback }) });
          }
          if (state.failBind) throw new Error('Bind failed');
        },
        getCallableToolNames() { return state.unexpected ?? options.tools; },
        extensionRunner: {
          hasHandlers: () => true,
          async emit(event) {
            assert.equal(event.type, 'session_shutdown');
            state.shutdowns++;
            if (state.failShutdown) throw new Error('Shutdown failed');
          },
        },
        async prompt(text, opts) {
          this.calls.push(['prompt', text, opts]);
          this.isIdle = false;
          appendFileSync(options.sessionManager.getSessionFile(), JSON.stringify({ type: 'message', message: { role: 'user', content: text } }) + '\n');
          await behavior(this, text, opts);
        },
        answer(message = assistant()) {
          if (typeof message === 'string') message = assistant(message);
          appendFileSync(options.sessionManager.getSessionFile(), JSON.stringify({ type: 'message', message }) + '\n');
          this.emit({ type: 'message_end', message });
        },
        settle(aborted = false) { this.isIdle = true; this.emit({ type: 'agent_settled', aborted }); },
        async abort() { this.calls.push(['abort']); if (!this.isIdle) this.settle(true); },
        async steer(text) { this.calls.push(['steer', text]); },
        dispose() { state.disposals++; state.listenersAtDispose = listeners.size; },
      };
      state.sessions.push(session);
      return { session };
    },
  };
  return { sdk, state };
}

async function fixture(t: TestContext, behavior?: TestBehavior): Promise<Fixture> {
  const root = await mkdtemp(join(testDir, '.pi-backend-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { sdk, state } = fakeSdk(behavior);
  const output: string[] = [];
  const activity: string[] = [];
  const options: CreateChildOptions = { profile, cwd: root, sessionPath: join(root, 'history', 'assigned.jsonl'),
    onOutput: (text) => output.push(text), onActivity: (text) => activity.push(text) };
  const factory = createPiChildFactory({ agentDir: join(root, 'agent'), modelRuntime, sdk });
  return { root, sdk, state, options, output, activity, factory };
}

test('exact private JSONL path resumes; default resources and tools are isolated', async (t) => {
  const f = await fixture(t);
  const child = await f.factory(f.options);
  assert.equal(child.sessionPath, f.options.sessionPath);
  assert.equal((await stat(dirname(child.sessionPath))).mode & 0o777, 0o700);
  assert.equal((await stat(child.sessionPath)).mode & 0o777, 0o600);
  const result = await child.prompt('Inspect');
  assert.equal(result.text, 'Done');
  assert.deepEqual(result.usage, { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: 0.01 });
  assert.deepEqual(result.verification, { agentSettled: true, stopReason: 'stop', toolErrors: 0 });
  const options = f.state.options[0];
  assert.equal(options.modelRuntime, modelRuntime);
  assert.equal(options.model.id, 'model/with/slash');
  assert.deepEqual(options.tools, ['read', 'grep', 'find', 'ls']);
  assert.equal(options.thinkingLevel, 'low');
  const loader = f.state.loaders[0].options;
  for (const name of ['noExtensions', 'noSkills', 'noPromptTemplates', 'noThemes'] as const) assert.equal(loader[name], true);
  assert.deepEqual(loader.additionalExtensionPaths, []);
  assert.deepEqual(loader.additionalSkillPaths, []);
  assert.deepEqual(loader.disabledBuiltinExtensions, ['mcp']);
  assert.equal(loader.systemPromptOverride('Global fixture'), undefined);
  assert.deepEqual(loader.promptsOverride({ prompts: ['unexpected'] }).prompts, []);
  assert.deepEqual(loader.themesOverride({ themes: ['unexpected'] }).themes, []);
  assert.match(loader.appendSystemPromptOverride().join('\n'), /Inspect only/);
  assert.equal(options.settingsManager.settings.cacheWarming, 'off');
  assert.deepEqual(options.settingsManager.settings.packages, []);
  assert.equal(f.state.bindings!.mode, 'json');
  assert.deepEqual(f.output, ['Done\n']);
  await child.dispose();
  await child.dispose();
  assert.equal(f.state.shutdowns, 1);
  assert.equal(f.state.disposals, 1);
  assert.equal(f.state.listenersAtDispose, 0);
  const before = await readFile(child.sessionPath, 'utf8');
  const resumed = await f.factory(f.options);
  await resumed.prompt('Continue');
  await resumed.dispose();
  const after = await readFile(child.sessionPath, 'utf8');
  assert.ok(after.startsWith(before));
  assert.equal(after.trim().split('\n').filter((line) => JSON.parse(line).type === 'session').length, 1);
});

test('creates one model runtime per factory without copying credentials or refreshing over the network', async (t) => {
  const f = await fixture(t);
  const calls: CreateModelRuntimeOptions[] = [];
  f.sdk.ModelRuntime = { create: async (options) => { calls.push(options); return modelRuntime; } };
  const factory = createPiChildFactory({ agentDir: join(f.root, 'agent'), sdk: f.sdk });
  await (await factory(f.options)).dispose();
  await (await factory(f.options)).dispose();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { authPath: join(f.root, 'agent', 'auth.json'), modelsPath: join(f.root, 'agent', 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
});

test('waits for agent_settled through retry and steering after prompt and agent_end return', async (t) => {
  const f = await fixture(t, async (session) => {
    session.answer(assistant('Retrying', 'error'));
    session.emit({ type: 'agent_end', willRetry: true, messages: [] });
    session.emit({ type: 'auto_retry_start' });
  });
  const child = await f.factory(f.options);
  let finished = false;
  const pending = child.prompt('Run').then((result) => { finished = true; return result; });
  await tick();
  assert.equal(finished, false);
  await child.steer('Also inspect the caller');
  assert.deepEqual(f.state.sessions[0].calls.at(-1), ['steer', 'Also inspect the caller']);
  f.state.sessions[0].answer('Recovered');
  f.state.sessions[0].emit({ type: 'agent_end', willRetry: false, messages: [] });
  await tick();
  assert.equal(finished, false);
  f.state.sessions[0].settle();
  assert.equal((await pending).text, 'Recovered');
  await child.dispose();
});

test('thinking clamping fails clearly and explore/verifier may explicitly opt in to bash', async (t) => {
  const f = await fixture(t);
  f.state.clampedThinking = 'off';
  await assert.rejects(f.factory(f.options), /Requested child thinking level low.*Pi selected off/);
  assert.equal(f.state.disposals, 1);
  f.state.clampedThinking = undefined;
  for (const name of ['explore', 'verifier']) {
    const child = await f.factory({ ...f.options, profile: { ...profile, name, tools: ['read', 'bash'] } });
    assert.deepEqual(f.state.options.at(-1)!.tools, ['read', 'bash']);
    await child.dispose();
  }
});

test('error stopReason rejects; output omits thinking, tool payloads and credentials', async (t) => {
  const f = await fixture(t, async (session) => {
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private chain' } });
    session.emit({ type: 'tool_execution_start', toolName: 'read', args: { token: 'secret-tool-argument' } });
    session.emit({ type: 'tool_execution_end', toolName: 'read', isError: true, result: { secret: 'secret-tool-result' } });
    session.answer({ ...assistant('api_key=secret-value Bearer private-token', 'error'), errorMessage: 'Authorization: Bearer private-token' });
    session.settle();
  });
  const child = await f.factory(f.options);
  await assert.rejects(child.prompt('Run'), /redacted/);
  const output = f.output.join('');
  for (const text of ['private chain', 'secret-tool-argument', 'secret-tool-result', 'secret-value', 'private-token']) assert.equal(output.includes(text), false);
  assert.match(output, /read: running/);
  assert.match(output, /read: failed/);
  await child.dispose();
});

test('abort, timeout and disposal reject in-flight work; shutdown happens once', async (t) => {
  for (const kind of ['abort', 'timeout', 'dispose']) {
    const f = await fixture(t, async () => {});
    if (kind === 'timeout') f.options.profile = { ...profile, timeoutMs: 5 };
    const child = await f.factory(f.options);
    const pending = child.prompt('Run');
    const rejected = assert.rejects(pending, { name: kind === 'timeout' ? 'TimeoutError' : 'AbortError' });
    await tick();
    if (kind === 'abort') await child.abort();
    if (kind === 'dispose') await child.dispose();
    await rejected;
    await child.dispose();
    assert.equal(f.state.shutdowns, 1);
    assert.equal(f.state.disposals, 1);
    await assert.rejects(child.prompt('Again'), /disposed/);
  }
});

test('prompt rejection, interception, concurrency and unexpected tools fail closed', async (t) => {
  for (const [behavior, pattern] of [
    [async () => { throw new Error('Prompt failed'); }, /Prompt failed/],
    [async (_session: FakeSession, _text: string, options: TestPromptOptions): Promise<void> => options.preflightResult('handled'), /without a settled assistant response/],
  ] as const) {
    const f = await fixture(t, behavior);
    const child = await f.factory(f.options);
    await assert.rejects(child.prompt('Run'), pattern);
    await child.dispose();
  }
  const f = await fixture(t, async () => {});
  const child = await f.factory(f.options);
  const pending = child.prompt('Run');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(child.prompt('Run again'), /already running/);
  await child.abort();
  await rejected;
  await child.dispose();
  f.state.unexpected = ['bash'];
  await assert.rejects(f.factory(f.options), /outside the child allowlist/);
  assert.equal(f.state.disposals, 2);
});

test('rejects recursive names, patterns, remote resources and this plugin before SDK creation', async (t) => {
  const f = await fixture(t);
  for (const change of [
    ...['task', 'task_append', 'task_query', 'task_output', 'task_stop', 'task_agents'].map((name) => ({ tools: [name] })),
    { tools: ['mcp__host__task_append'], mcp: true },
    { tools: ['+bash'] }, { tools: ['*'] }, { tools: ['mcp__host__read'] },
    { extensions: ['npm:unexpected'] }, { extensions: [fileURLToPath(new URL('../src/pi-backend.ts', import.meta.url))] },
    { extensions: [f.root] }, { model: 'missing/model' },
  ]) await assert.rejects(f.factory({ ...f.options, profile: { ...profile, ...change } }));
  assert.equal(f.state.sessions.length, 0);
});

test('MCP is explicit, untrusted project config is excluded, and runtime guard blocks unexpected tools', async (t) => {
  const f = await fixture(t);
  f.options.profile = Object.freeze({ ...profile, tools: ['read', 'mcp__docs__lookup'], mcp: true });
  const child = await f.factory(f.options);
  const mcpOptions = f.state.mcpOptions;
  assert.ok(mcpOptions);
  assert.equal(mcpOptions.loadConfig().autoEnableCodemode, false);
  assert.ok(f.state.mcpConfig);
  assert.equal(f.state.mcpConfig.projectTrusted, false);
  assert.equal(f.state.mcpConfig.agentDir, join(f.root, 'agent'));
  assert.throws(() => mcpOptions.updateConfig(), /cannot change/);
  assert.throws(() => mcpOptions.openUrl(), /parent host/);
  const handler = f.state.guardHandlers?.find((item) => item.name === 'tool_call');
  assert.ok(handler);
  const guard = handler.callback;
  assert.equal(guard({ toolName: 'read' }), undefined);
  assert.equal(guard({ toolName: 'mcp__docs__lookup' }), undefined);
  assert.equal(guard({ toolName: 'bash' })?.block, true);
  assert.equal(guard({ toolName: 'task_append' })?.block, true);
  await child.dispose();
});

test('invalid history is preserved; binding/shutdown failures still dispose the SDK', async (t) => {
  const f = await fixture(t);
  f.state.failBind = true;
  await assert.rejects(f.factory(f.options), /Bind failed/);
  assert.equal(f.state.disposals, 1);
  f.state.failBind = false;
  const child = await f.factory(f.options);
  f.state.failShutdown = true;
  await assert.rejects(child.dispose(), /Shutdown failed/);
  assert.equal(f.state.disposals, 2);
  const invalid = JSON.stringify({ type: 'message' }) + '\n';
  await writeFile(f.options.sessionPath, invalid);
  await assert.rejects(f.factory(f.options), /session header/);
  assert.equal(await readFile(f.options.sessionPath, 'utf8'), invalid);
});

test('actual Pi resources and SessionManager preserve paths without auth access or model calls', async (t) => {
  let sdk: InstalledSdk;
  try { sdk = await import('@earendil-works/pi-coding-agent'); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    if (!process.env.PI_SDK_PATH) return t.skip('SDK peer unavailable; set PI_SDK_PATH for local SDK validation');
    sdk = await import(pathToFileURL(join(process.env.PI_SDK_PATH, 'dist/index.js')).href);
  }
  const root = await mkdtemp(join(testDir, '.pi-backend-real-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let authChecks = 0;
  let streams = 0;
  const realRuntime: LocalRuntime = {
    getModel: (provider, id) => ({ provider, id, api: 'test', reasoning: false, input: ['text'],
      contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    getModels: () => [], getProviders: () => [],
    hasConfiguredAuth: () => { authChecks++; return true; },
    resolveModel: async (model) => ({ model, thinkingLevel: 'off' }),
    streamSimple(model) {
      streams++;
      const message = { ...assistant('Local SDK response'), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message }; },
        result: async () => message,
      };
    },
  };
  const options: CreateChildOptions = { profile: { ...profile, thinking: 'off' }, cwd: root, sessionPath: join(root, 'history', 'exact.jsonl') };
  const createChild = createPiChildFactory({ agentDir: join(root, 'agent'), modelRuntime: realRuntime, sdk });
  await assert.rejects(createChild({ ...options, profile }), /Requested child thinking level low.*Pi selected off/);
  const smoke = await createChild(options);
  await smoke.dispose();
  assert.equal(authChecks, 0);
  assert.equal(streams, 0);
  const child = await createChild(options);
  assert.equal((await child.prompt('Use only the injected local response')).text, 'Local SDK response');
  assert.equal(streams, 1);
  const first = await readFile(child.sessionPath, 'utf8');
  assert.equal(JSON.parse(first.split('\n')[0]).type, 'session');
  assert.equal((await stat(child.sessionPath)).mode & 0o777, 0o600);
  await child.dispose();
  const resumed = await createChild(options);
  await resumed.dispose();
  const after = await readFile(child.sessionPath, 'utf8');
  assert.ok(after.startsWith(first));
  assert.equal(after.trim().split('\n').filter((line) => JSON.parse(line).type === 'session').length, 1);
});


async function realFixture(t: TestContext): Promise<RealFixture> {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const artifacts = join(testDir, '..', 'artifacts', 'backend-mcp-smoke');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(artifacts, 'run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  await mkdir(agentDir, { mode: 0o700 });
  let session: AgentSession | undefined;
  const api = { ...sdk, async createAgentSession(options: CreateAgentSessionOptions) {
    const result = await sdk.createAgentSession(options);
    session = result.session;
    return result;
  } };
  const runtime: LocalRuntime = {
    getModel: (provider, id) => ({ provider, id, api: 'test', reasoning: false, input: ['text'],
      contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    getModels: () => [], getProviders: () => [],
    hasConfiguredAuth: () => true,
    resolveModel: async (model) => ({ model, thinkingLevel: 'off' }),
    streamSimple() { throw new Error('A local response must be explicitly injected'); },
  };
  const factory = createPiChildFactory({ agentDir, modelRuntime: runtime, sdk: api });
  const options: CreateChildOptions = { profile: { ...profile, thinking: 'off' }, cwd: root, sessionPath: join(root, 'history', 'child.jsonl') };
  return { sdk, root, agentDir, runtime, factory, options, session: (): AgentSession => { assert.ok(session); return session; } };
}

test('real Pi MCP binds local stdio, exposes only the exact allowed tool, calls it and closes the server', { timeout: 20000 }, async (t) => {
  const f = await realFixture(t);
  const serverPath = join(f.root, 'server.mjs');
  const auditPath = join(f.root, 'server-audit.jsonl');
  await writeFile(serverPath, [
    "import { createInterface } from 'node:readline';",
    "import { appendFileSync } from 'node:fs';",
    "const audit = (event) => appendFileSync(process.argv[2], JSON.stringify(event) + '\\n');",
    "audit({ event: 'started', pid: process.pid });",
    "const input = createInterface({ input: process.stdin });",
    "input.on('close', () => process.exit(0));",
    "input.on('line', (line) => {",
    "  const request = JSON.parse(line);",
    "  audit({ method: request.method, params: request.params });",
    "  if (request.id === undefined) return;",
    "  let result;",
    "  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-smoke', version: '1' } };",
    "  else if (request.method === 'tools/list') result = { tools: ['echo', 'other', 'task_append'].map((name) => ({ name, description: 'Local fixture ' + name, inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })) };",
    "  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'local-echo:' + request.params.arguments.value }] };",
    "  else if (request.method === 'ping') result = {};",
    "  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\\n'); return; }",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
    "});",
  ].join('\n'), { mode: 0o600 });
  const configPath = join(f.agentDir, 'mcp.json');
  const config = { autoEnableCodemode: true, mcpServers: { smoke: {
    command: process.execPath, args: [serverPath, auditPath], exposure: 'codemode',
    toolExposure: { echo: 'direct', other: 'deferred' }, timeout: 3,
  } } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const { loadMcpConfig } = await import(new URL('./extensions/mcp/config.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href) as {
    loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
  };
  const loaded = loadMcpConfig({ agentDir: f.agentDir, cwd: f.root, projectTrusted: false });
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.servers.map(({ name, scope, source }) => ({ name, scope, source })), [{ name: 'smoke', scope: 'global', source: configPath }]);
  const name = 'mcp__smoke__echo';
  let turns = 0;
  f.runtime.streamSimple = (model, context) => {
    const declared = new Set<string>();
    for (const message of context.messages.filter((item) => item.role === 'system')) {
      for (const tool of message.toolsRemoved ?? []) declared.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) declared.add(tool.name);
    }
    assert.deepEqual([...declared], [name]);
    turns++;
    if (turns === 2) {
      const result = context.messages.findLast((message) => message.role === 'toolResult');
      assert.ok(result);
      assert.equal(result.toolName, name);
      assert.equal(result.isError, false);
      assert.match(JSON.stringify(result.content), /local-echo:fixture-value/);
    }
    const message = { ...assistant('MCP completed'), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
    if (turns === 1) {
      message.stopReason = 'toolUse';
      message.content = [{ type: 'toolCall', id: 'local-call', name, arguments: { value: 'fixture-value' } }];
    }
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
  };
  const child = await f.factory({ ...f.options, profile: { ...f.options.profile, mcp: true, tools: [name], timeoutMs: 10000 } });
  t.after(() => child.dispose());
  assert.equal((await child.prompt('Call the local fixture')).text, 'MCP completed');
  assert.equal(turns, 2);
  assert.deepEqual(f.session().getActiveToolNames(), [name]);
  assert.deepEqual(f.session().getCallableToolNames(), [name]);
  assert.deepEqual(f.session().getAllTools().map((tool) => tool.name), [name]);
  const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.filter((entry) => entry.method === 'initialize').length, 1);
  assert.equal(audit.filter((entry) => entry.method === 'tools/list').length, 1);
  assert.deepEqual(audit.filter((entry) => entry.method === 'tools/call').map(({ params }) => ({ name: params.name, arguments: params.arguments })), [{ name: 'echo', arguments: { value: 'fixture-value' } }]);
  await child.dispose();
  assert.throws(() => process.kill(audit[0].pid, 0), { code: 'ESRCH' });
  assert.equal(await readFile(configPath, 'utf8'), JSON.stringify(config));
  const missing = { ...f.options, profile: { ...f.options.profile, mcp: true, tools: ['mcp__smoke__absent'], timeoutMs: 1000 } };
  await assert.rejects(f.factory(missing), /Missing requested child tools after MCP initialization: mcp__smoke__absent/);
  const afterMissing = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(afterMissing.filter((entry) => entry.method === 'tools/list').length, 2);
  assert.throws(() => process.kill(afterMissing.filter((entry) => entry.event === 'started').at(-1).pid, 0), { code: 'ESRCH' });
  await writeFile(configPath, JSON.stringify({ mcpServers: { smoke: { command: process.execPath, args: ['-e', 'process.exit(17)'], exposure: 'direct' } } }));
  await assert.rejects(f.factory({ ...missing, profile: { ...missing.profile, tools: [name] } }), /Missing requested child tools after MCP initialization: mcp__smoke__echo/);
  assert.equal(turns, 2);
});

test('real Pi loads only explicit local extensions and skills, preserves AGENTS and filters discovered extras', async (t) => {
  const f = await realFixture(t);
  const projectConfig = join(f.root, '.pi');
  const allowedDir = join(f.root, 'explicit-skill');
  const discoveredDir = join(f.root, 'discovered-skill');
  const globalSkill = join(f.agentDir, 'skills', 'global-fixture-skill');
  const globalExtensions = join(f.agentDir, 'extensions');
  const projectExtensions = join(projectConfig, 'extensions');
  await Promise.all([allowedDir, discoveredDir, globalSkill, globalExtensions, projectExtensions].map((path) => mkdir(path, { recursive: true })));
  const skill = (name: string): string => '---\nname: ' + name + '\ndescription: A local fixture skill.\n---\nPerform local fixture work.\n';
  await Promise.all([
    writeFile(join(allowedDir, 'SKILL.md'), skill('explicit-skill')),
    writeFile(join(discoveredDir, 'SKILL.md'), skill('discovered-skill')),
    writeFile(join(globalSkill, 'SKILL.md'), skill('global-fixture-skill')),
    writeFile(join(globalExtensions, 'poison.mjs'), "throw new Error('Global extension must not load');"),
    writeFile(join(projectExtensions, 'poison.mjs'), "throw new Error('Project extension must not load');"),
    writeFile(join(f.agentDir, 'SYSTEM.md'), 'Global fixture system content must not be inherited.'),
    writeFile(join(f.root, 'AGENTS.md'), 'LOCAL_AGENTS_CONTEXT: inspect the fixture.'),
  ]);
  const extraPrompt = join(f.root, 'extra-prompt.md');
  await writeFile(extraPrompt, 'Unexpected prompt template.');
  const extension = join(f.root, 'explicit-extension.mjs');
  const marker = join(f.root, 'extension-started');
  await writeFile(extension, [
    "import { writeFileSync } from 'node:fs';",
    "import { Type } from 'typebox';",
    "export default function (pi) {",
    "  for (const name of ['fixture_probe', 'fixture_unlisted', 'task_append']) pi.registerTool({ name, label: name, description: 'Local fixture tool', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'fixture' }] }) });",
    "  pi.on('session_start', () => writeFileSync(" + JSON.stringify(marker) + ", 'loaded'));",
    "  pi.on('resources_discover', () => ({ skillPaths: [" + JSON.stringify(discoveredDir) + "], promptPaths: [" + JSON.stringify(extraPrompt) + "] }));",
    "}",
  ].join('\n'));
  const defaults = await f.factory(f.options);
  assert.deepEqual(f.session().resourceLoader.getSkills().skills, []);
  assert.deepEqual(f.session().getActiveToolNames().sort(), ['find', 'grep', 'ls', 'read']);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await defaults.dispose();
  const child = await f.factory({ ...f.options, profile: { ...f.options.profile, tools: ['fixture_probe', 'read'], extensions: [extension], skills: [allowedDir] } });
  t.after(() => child.dispose());
  assert.equal(await readFile(marker, 'utf8'), 'loaded');
  assert.deepEqual(f.session().getActiveToolNames().sort(), ['fixture_probe', 'read']);
  assert.deepEqual(f.session().getCallableToolNames().sort(), ['fixture_probe', 'read']);
  assert.deepEqual(f.session().getAllTools().map((tool) => tool.name).sort(), ['fixture_probe', 'read']);
  assert.deepEqual(f.session().resourceLoader.getSkills().skills.map((entry) => entry.name), ['explicit-skill']);
  assert.deepEqual(f.session().resourceLoader.getPrompts().prompts, []);
  assert.match(f.session().systemPrompt, /LOCAL_AGENTS_CONTEXT/);
  assert.match(f.session().systemPrompt, /explicit-skill/);
  assert.doesNotMatch(f.session().systemPrompt, /Global fixture|global-fixture-skill|discovered-skill/);
  await child.dispose();
  await assert.rejects(f.factory({ ...f.options, profile: { ...f.options.profile, tools: ['unknown_builtin'] } }), /Missing requested child tools: unknown_builtin/);
  await assert.rejects(f.factory({ ...f.options, profile: { ...f.options.profile, tools: ['extension_missing'], extensions: [extension] } }), /Missing requested child tools: extension_missing/);
});
