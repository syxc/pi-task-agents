import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentSessionEvent,
  ExtensionFactory,
  LoadedMcpConfig,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentProfile, CreateChild, ChildSession, ChildResult, CreateChildOptions } from './types.ts';

type McpConfigLoader = (options: { agentDir: string; cwd: string; projectTrusted: boolean }) => LoadedMcpConfig;
type PiSdk = Pick<typeof import('@earendil-works/pi-coding-agent'),
  'ModelRuntime' | 'SessionManager' | 'SettingsManager' | 'DefaultResourceLoader' | 'createMcpExtension' | 'createAgentSession'
> & { loadMcpConfig?: McpConfigLoader };
type AssistantMessage = Extract<Extract<AgentSessionEvent, { type: 'message_end' }>['message'], { role: 'assistant' }>;

export interface PiChildFactoryOptions {
  agentDir?: string;
  // Injected runtimes and SDK doubles need not implement private SDK class fields.
  modelRuntime?: unknown;
  sdk?: unknown;
}

interface ChildRun {
  usage: NonNullable<ChildResult['usage']>;
  toolErrors: number;
  resolve: () => void;
  last?: AssistantMessage;
  settled?: boolean;
  aborted?: boolean;
  failure?: Error;
  done?: Promise<ChildResult>;
}

interface ChildError extends Error {
  code?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function injectedRuntime(value: unknown): ModelRuntime {
  if (!isRecord(value) || typeof value.getModel !== 'function') throw new Error('Invalid child model runtime');
  // The SDK consumes this public runtime protocol; local doubles implement only exercised methods.
  return value as unknown as ModelRuntime;
}

const readOnlyTools = ['read', 'grep', 'find', 'ls'];
const recursiveTools = ['task', 'task_*', '*__task', '*__task_*', 'subagent', 'subagent_*', '*__subagent', '*__subagent_*'];
const mcpResources = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const isRecursive = (name: string): boolean => /(?:^|__)(?:task(?:_|$)|subagent(?:_|$))/i.test(name);
const isMcp = (name: string): boolean => name.startsWith('mcp__') || mcpResources.includes(name);
const within = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};
const abortError = (message = 'Child session aborted'): Error => Object.assign(new Error(message), { name: 'AbortError' });

// Do not forward provider diagnostics, thinking blocks, tool inputs, or tool results.
function redact(text: unknown): string {
  return String(text)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}<>]+/gi, '$1[redacted]');
}

function safeError(error: unknown): ChildError {
  const result: ChildError = new Error(redact(error instanceof Error ? error.message : error));
  if (isRecord(error) && typeof error.name === 'string' && error.name) result.name = error.name;
  if (isRecord(error) && error.code) result.code = error.code;
  return result;
}

function notify(callback: ((value: string) => void) | undefined, value: string): void {
  try { Promise.resolve(callback?.(value)).catch(() => {}); } catch {}
}

async function localPaths(paths: readonly string[], cwd: string, extensions: boolean): Promise<string[]> {
  if (!Array.isArray(paths)) throw new Error('Resource paths must be an array');
  const result: string[] = [];
  const ownRoot = await realpath(pluginRoot);
  for (const path of paths) {
    if (typeof path !== 'string' || !path || /^(?:npm:|git:|https?:|builtin:)/i.test(path)) {
      throw new Error('Resources require explicit local paths');
    }
    const actual = await realpath(resolve(cwd, path));
    const info = await stat(actual);
    if (extensions && (!info.isFile() || !/\.(?:[cm]?js|ts)$/.test(actual))) {
      throw new Error('Extensions require explicit local entry files');
    }
    if (extensions && within(resolve(ownRoot, 'src'), actual)) throw new Error('The task plugin cannot load itself in a child');
    result.push(actual);
  }
  return [...new Set(result)];
}

async function prepareSession(path: string, cwd: string, managerType: PiSdk['SessionManager']): Promise<SessionManager> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error('Session directory must not be a symlink');
  await chmod(dir, 0o700);
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Session path must be a regular file');
    await handle.chmod(0o600);
    const text = await handle.readFile('utf8');
    if (text.trim()) {
      const entries: unknown[] = text.trim().split('\n').map((line): unknown => JSON.parse(line));
      const header = entries[0];
      if (!isRecord(header) || header.type !== 'session' || typeof header.id !== 'string') {
        throw new Error('Session file requires a Pi session header');
      }
      if (typeof header.cwd !== 'string' || resolve(header.cwd) !== cwd) throw new Error('Session working directory does not match');
    }
  } finally { await handle.close(); }
  // Opening an existing empty file makes Pi initialize and flush its header at this exact path.
  const manager = managerType.open(path, dir, cwd);
  if (manager.getSessionFile() !== path) throw new Error('Pi changed the assigned session path');
  await chmod(path, 0o600);
  return manager;
}

async function mcpFactory(sdk: PiSdk, agentDir: string, cwd: string, sessionPath: string, startupWaitMs: number): Promise<ExtensionFactory> {
  // Pi 1.5.0 exposes the factory publicly, but its config loader only via this installed module.
  let loadConfig = sdk.loadMcpConfig;
  if (!loadConfig) {
    const module: unknown = await import(
      new URL('./extensions/mcp/config.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href
    );
    if (!isRecord(module) || typeof module.loadMcpConfig !== 'function') throw new Error('Pi MCP config loader is unavailable');
    loadConfig = module.loadMcpConfig as McpConfigLoader;
  }
  const load = loadConfig;
  return sdk.createMcpExtension({
    startupWaitMs,
    loadConfig: () => ({ ...load({ agentDir, cwd, projectTrusted: false }), autoEnableCodemode: false }),
    logPath: resolve(dirname(sessionPath), 'mcp.log'),
    openUrl: () => { throw new Error('Child MCP sign-in requires the parent host'); },
    updateConfig: () => { throw new Error('Child sessions cannot change MCP settings'); },
  });
}

/** Create isolated leaf sessions. Tool restrictions are not an OS sandbox. */
export function createPiChildFactory({ agentDir, modelRuntime, sdk }: PiChildFactoryOptions = {}): CreateChild {
  if (!agentDir) throw new Error('agentDir is required');
  const configDir = resolve(agentDir);
  let sdkPromise: Promise<PiSdk> | undefined;
  let runtimePromise: Promise<ModelRuntime> | undefined;
  return async function createChild({ profile, cwd, sessionPath, onOutput, onActivity }: CreateChildOptions): Promise<ChildSession> {
    // Only the injected SDK crosses an untyped boundary; the installed SDK retains its real types.
    const api = await (sdkPromise ??= Promise.resolve((sdk as PiSdk | undefined) ?? import('@earendil-works/pi-coding-agent')));
    const workDir = resolve(cwd);
    const path = resolve(sessionPath);
    const tools: AgentProfile['tools'][number][] = [...new Set(profile.tools ?? readOnlyTools)];
    if (!Array.isArray(profile.tools ?? readOnlyTools) || tools.some((name) =>
      typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) || isRecursive(name))) {
      throw new Error('Child tools must be exact, non-recursive tool names');
    }
    if (!profile.mcp && tools.some(isMcp)) throw new Error('MCP tools require mcp: true');
    const extensions = await localPaths(profile.extensions ?? [], workDir, true);
    const skills = await localPaths(profile.skills ?? [], workDir, false);
    if (typeof profile.model !== 'string' || profile.model.indexOf('/') < 1 || profile.model.endsWith('/')) {
      throw new Error('Child model must be provider/id');
    }
    const slash = profile.model.indexOf('/');
    const runtime = await (runtimePromise ??= Promise.resolve(modelRuntime == null ? api.ModelRuntime.create({
      authPath: resolve(configDir, 'auth.json'), modelsPath: resolve(configDir, 'models.json'),
      allowModelNetwork: false, refreshOnCreate: false,
    }) : injectedRuntime(modelRuntime)));
    const model = runtime.getModel(profile.model.slice(0, slash), profile.model.slice(slash + 1));
    if (!model) throw new Error(`Unknown child model: ${profile.model}`);
    const manager = await prepareSession(path, workDir, api.SessionManager);
    const settings = api.SettingsManager.inMemory({
      packages: [], extensions: [], skills: [], prompts: [], themes: [],
      cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false,
    });
    const allow = new Set(tools);
    const guard: ExtensionFactory = (pi): void => {
      pi.on('tool_call', (event) => {
        if (!allow.has(event.toolName) || isRecursive(event.toolName)) {
          return { block: true, reason: 'Tool is outside the child allowlist' };
        }
      });
    };
    const factories: ExtensionFactory[] = [guard];
    const startupWaitMs = profile.timeoutMs > 0 ? Math.min(profile.timeoutMs, 10000) : 10000;
    if (profile.mcp) factories.push(await mcpFactory(api, configDir, workDir, path, startupWaitMs));
    const loader = new api.DefaultResourceLoader({
      cwd: workDir, agentDir: configDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: extensions, additionalSkillPaths: skills, extensionFactories: factories,
      disabledBuiltinExtensions: profile.mcp ? [] : ['mcp'],
      promptsOverride: (base) => ({ ...base, prompts: [] }),
      themesOverride: (base) => ({ ...base, themes: [] }),
      systemPromptOverride: () => undefined,
      appendSystemPromptOverride: () => [
        'You are a leaf worker. Complete the assigned task. Do not create or delegate tasks.',
        profile.instructions ?? '',
      ].filter(Boolean),
      skillsOverride: (base) => ({ ...base, skills: base.skills.filter((skill) =>
        skills.some((entry) => within(entry, resolve(skill.filePath)))) }),
    });
    await loader.reload();
    if (loader.getExtensions().errors.length || loader.getSkills().diagnostics.some((item) => item.type === 'error')) {
      throw new Error('Could not load the explicitly configured child resources');
    }
    const excludeTools = [...recursiveTools, ...mcpResources.filter((name) => !allow.has(name))];
    if (!profile.mcp || !tools.some((name) => name.startsWith('mcp__'))) excludeTools.push('mcp__*');
    const { session } = await api.createAgentSession({
      cwd: workDir, agentDir: configDir, modelRuntime: runtime, model,
      thinkingLevel: profile.thinking, tools, excludeTools,
      settingsManager: settings, resourceLoader: loader, sessionManager: manager,
    });
    let current: ChildRun | undefined;
    let closed = false;
    let closing: Promise<void> | undefined;
    let extensionError: Error | undefined;
    const unsubscribe = session.subscribe((event) => {
      const run = current;
      if (!run) return;
      switch (event.type) {
        case 'message_end': {
          if (event.message.role !== 'assistant') break;
          const message = event.message;
          run.last = message;
          const text = (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
          if (text) notify(onOutput, `${redact(text)}\n`);
          if (message.usage) {
            for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
              run.usage[key] += Number(message.usage[key] ?? 0);
            }
            run.usage.cost += Number(message.usage.cost?.total ?? 0);
          }
          break;
        }
        case 'tool_execution_start':
        case 'tool_execution_end': {
          const name = /^[A-Za-z0-9_.-]+$/.test(event.toolName) ? event.toolName : 'tool';
          const end = event.type === 'tool_execution_end';
          const activity = `${name}: ${end ? (event.isError ? 'failed' : 'done') : 'running'}`;
          if (end && event.isError) run.toolErrors++;
          notify(onOutput, `[${activity}]\n`);
          notify(onActivity, activity);
          break;
        }
        case 'auto_retry_start': notify(onActivity, 'Retrying model request'); break;
        case 'compaction_start': notify(onActivity, 'Compacting context'); break;
        case 'agent_settled':
          run.settled = true;
          run.aborted ||= event.aborted;
          run.resolve();
          break;
      }
    });
    async function shutdown(): Promise<void> {
      try {
        if (session.extensionRunner.hasHandlers('session_shutdown')) {
          await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        }
      } finally { unsubscribe(); session.dispose(); }
    }
    const child: ChildSession = {
      sessionPath: path,
      prompt(text: string): Promise<ChildResult> {
        if (closed) return Promise.reject(new Error('Child session is disposed'));
        if (current) return Promise.reject(new Error('Child session is already running'));
        if (typeof text !== 'string' || !text.trim()) return Promise.reject(new Error('Prompt must not be empty'));
        const run: ChildRun = {
          resolve: () => {},
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
          toolErrors: 0,
        };
        const settled = new Promise<void>((resolve) => { run.resolve = resolve; });
        current = run;
        let timer: ReturnType<typeof setTimeout> | undefined;
        run.done = (async (): Promise<ChildResult> => {
          try {
            notify(onActivity, 'Running');
            if (profile.timeoutMs > 0) {
              timer = setTimeout(() => {
                run.failure = Object.assign(new Error('Child session timed out'), { name: 'TimeoutError' });
                child.abort().catch(() => {});
              }, profile.timeoutMs);
            }
            // Disable slash commands: they can finish without starting a run or settling it.
            await session.prompt(text, { expandPromptTemplates: false, source: 'extension',
              preflightResult: (result) => { if (result === 'handled') run.resolve(); },
            });
            if (run.aborted && !run.settled) await session.abort();
            await settled;
            if (run.failure) throw run.failure;
            if (run.aborted) throw abortError();
            if (extensionError) throw extensionError;
            if (!run.settled || !run.last) throw new Error('Child prompt completed without a settled assistant response');
            if (run.last.stopReason === 'aborted') throw abortError();
            if (run.last.stopReason === 'error') throw new Error(redact(run.last.errorMessage ?? 'Child model request failed'));
            const finalText = run.last.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
            notify(onActivity, 'Completed');
            return { text: redact(finalText), usage: run.usage, verification: {
              agentSettled: true, stopReason: run.last.stopReason, toolErrors: run.toolErrors,
            } };
          } catch (error) {
            await session.abort();
            throw safeError(error);
          } finally {
            clearTimeout(timer);
            current = undefined;
            await chmod(path, 0o600);
          }
        })();
        return run.done;
      },
      async steer(text: string): Promise<unknown> {
        if (closed || !current || current.settled) throw new Error('Child session is not running');
        if (current.aborted) throw abortError();
        return session.steer(text, undefined, { source: 'extension' });
      },
      async abort(): Promise<void> {
        if (current) current.aborted = true;
        await session.abort();
      },
      dispose(): Promise<void> {
        if (!closing) {
          closed = true;
          closing = (async () => {
            try {
              const done = current?.done;
              await child.abort();
              await done?.catch(() => {});
            } finally { await shutdown(); }
          })();
        }
        return closing;
      },
    };
    try {
      if (profile.thinking !== undefined && session.thinkingLevel !== profile.thinking) {
        throw new Error(`Requested child thinking level ${profile.thinking} is unsupported for ${profile.model}; Pi selected ${session.thinkingLevel}`);
      }
      await session.bindExtensions({
        mode: 'json', abortHandler: () => { child.abort().catch(() => {}); },
        shutdownHandler: () => { child.abort().catch(() => {}); },
        onError: () => { extensionError = new Error('Child extension failed'); },
      });
      if (extensionError) throw extensionError;
      const unexpected = session.getCallableToolNames().filter((name) => !allow.has(name) || isRecursive(name));
      if (unexpected.length) throw new Error('Pi exposed tools outside the child allowlist');
      const missing = (): string[] => {
        const callable = new Set(session.getCallableToolNames());
        return tools.filter((name) => !callable.has(name));
      };
      const ordinary = missing().filter((name) => !isMcp(name));
      if (ordinary.length) throw new Error(`Missing requested child tools: ${ordinary.join(', ')}`);
      // bindExtensions starts MCP connections in the background. Match Pi's startup window
      // and wait for dynamic registration before declaring exact MCP tools unavailable.
      const deadline = Date.now() + startupWaitMs;
      while (missing().length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, deadline - Date.now())));
      }
      const unavailable = missing();
      if (unavailable.length) throw new Error(`Missing requested child tools after MCP initialization: ${unavailable.join(', ')}`);
    } catch (error) {
      await child.dispose();
      throw safeError(error);
    }
    return child;
  };
}
