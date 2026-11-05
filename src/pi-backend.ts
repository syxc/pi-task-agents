import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, ExtensionFactory, InlineExtension, CreateAgentSessionOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentProfile, CreateChild, ChildSession, ChildResult, CreateChildOptions, ThinkingLevel, ChildPromptOptions } from './types.ts';
import { childResources, type HostResources } from './resource-loader.ts';
import { childMcpFactory } from './resource-mcp.ts';
import { seedInheritedProvider, type InheritedModelRegistry } from './model-providers.ts';
import { childToolPolicy, normalizedSelectorName, normalizeSelector, recursiveTools, taskChildBlockedTools, roleAllowsTool, within } from './resource-selection.ts';
import { filterConfiguredToolDefinitions, observedToolFacts, pluginToolNames, sdkToolSelection } from './resource-tool-inventory.ts';
import { createChildSteering } from './child-steering.ts';
import { acquireSessionLease, prepareSession } from './child-session-file.ts';
import { createChildMessageWindow } from './child-message-window.ts';

type PiSdk = Pick<typeof import('@earendil-works/pi-coding-agent'),
  'ModelRuntime' | 'SessionManager' | 'SettingsManager' | 'DefaultResourceLoader' | 'createMcpExtension' | 'createAgentSession' |
  'ExtensionRunner' | 'ModelRegistry' | 'createExtensionRuntime'
> & Partial<Pick<typeof import('@earendil-works/pi-coding-agent'), 'createCodemodeExtension' | 'createToolSearchExtension'>>
  & { loadMcpConfig?: Parameters<typeof childMcpFactory>[0]['loadMcpConfig'];
    DefaultPackageManager?: typeof import('@earendil-works/pi-coding-agent')['DefaultPackageManager'] };
type AssistantMessage = Extract<Extract<AgentSessionEvent, { type: 'message_end' }>['message'], { role: 'assistant' }>;

export interface PiChildFactoryOptions {
  agentDir?: string;
  // Injected runtimes and SDK doubles need not implement private SDK class fields.
  modelRuntime?: unknown;
  sdk?: unknown;
  inheritedModel?: Model<Api>;
  inheritedThinking?: ThinkingLevel;
  inheritedModelRegistry?: InheritedModelRegistry;
  projectTrusted?: boolean;
  /** Resources already loaded under host trust, including package resources. */
  resourceLoader?: HostResources;
  customTools?: CreateAgentSessionOptions['customTools'];
}

interface ChildRun {
  id: string;
  controller: AbortController;
  eventCount: number;
  usage: NonNullable<ChildResult['usage']>;
  resolve: () => void;
  last?: AssistantMessage;
  settled?: boolean;
  aborted?: boolean;
  failure?: Error;
  done?: Promise<ChildResult>;
}
interface ChildError extends Error { code?: unknown; partialResult?: ChildResult; cleanupChild?: ChildSession }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const abortError = (): Error => Object.assign(new Error('Child session aborted'), { name: 'AbortError' });

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
function cleanupFailure(error: unknown): ChildError {
  const describe = (value: unknown, depth = 0): string => {
    const safe = safeError(value);
    const code = typeof safe.code === 'string' || typeof safe.code === 'number' ? ` [${redact(safe.code)}]` : '';
    const head = `${safe.name}${code}: ${safe.message}`;
    return value instanceof AggregateError && depth < 8
      ? [head, ...value.errors.map((item: unknown) => describe(item, depth + 1))].join('; ') : head;
  };
  return Object.assign(new Error(describe(error), { cause: safeError(error) }), { code: 'CHILD_CLEANUP_FAILED' });
}
function notify(callback: ((value: string) => void) | undefined, value: string): void {
  try { Promise.resolve(callback?.(value)).catch(() => {}); } catch {}
}

/** Create isolated leaf sessions with Pi's native tools. Tool restrictions are not an OS sandbox. */
export function createPiChildFactory({ agentDir, modelRuntime, sdk, inheritedModel, inheritedThinking, inheritedModelRegistry,
  projectTrusted = false, resourceLoader, customTools }: PiChildFactoryOptions = {}): CreateChild {
  if (!agentDir) throw new Error('agentDir is required');
  const configDir = resolve(agentDir);
  let sdkPromise: Promise<PiSdk> | undefined;
  let runtimePromise: Promise<ModelRuntime> | undefined;
  const seededProviders = new Set<string>();
  return async function createChild({ profile, cwd, sessionPath, onActivity, onProfileResolved }: CreateChildOptions): Promise<ChildSession> {
    const api = await (sdkPromise ??= Promise.resolve((sdk as PiSdk | undefined) ?? import('@earendil-works/pi-coding-agent')));
    const workDir = resolve(cwd), path = resolve(sessionPath);
    const requested = profile.tools ?? ['read', 'grep', 'find'];
    if (!Array.isArray(requested) || requested.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error('Child tool selectors must be nonempty strings');
    }
    const tools = [...new Set(requested.map(normalizedSelectorName))];
    for (const snapshot of [profile.skillSnapshot, profile.nativeToolSnapshot, profile.toolInventory]) {
      if (snapshot !== undefined && (!Array.isArray(snapshot) || snapshot.some((name) => typeof name !== 'string' || !name.trim()))) {
        throw new Error('Child resource snapshots must contain names');
      }
    }
    let skillCeiling = normalizeSelector(profile.skillSnapshot);
    const resources = await childResources(profile, workDir, configDir, projectTrusted, resourceLoader, api);
    if (profile.model !== undefined && (typeof profile.model !== 'string' || profile.model.indexOf('/') < 1 || profile.model.endsWith('/'))) {
      throw new Error('Child model must be provider/id');
    }
    if (modelRuntime != null && (!isRecord(modelRuntime) || typeof modelRuntime.getModel !== 'function')) throw new Error('Invalid child model runtime');
    const runtime = await (runtimePromise ??= Promise.resolve(modelRuntime == null ? api.ModelRuntime.create({
      authPath: resolve(configDir, 'auth.json'), modelsPath: resolve(configDir, 'models.json'),
      allowModelNetwork: false, refreshOnCreate: false,
    }) : modelRuntime as unknown as ModelRuntime));
    const slash = profile.model?.indexOf('/') ?? -1;
    const provider = profile.model?.slice(0, slash) ?? inheritedModel?.provider;
    if (provider) {
      if (seededProviders.delete(provider)) runtime.unregisterProvider(provider);
      if (seedInheritedProvider(runtime, inheritedModelRegistry, provider)) seededProviders.add(provider);
    }
    const model = profile.model ? runtime.getModel(profile.model.slice(0, slash), profile.model.slice(slash + 1)) : inheritedModel;
    if (!model) throw new Error(profile.model ? `Unknown child model: ${profile.model}` : 'Child model requires an inherited host model');
    // Accept only native Pi levels. Provider effort/managed protocol translation belongs to the SDK, not this plugin.
    const requestedThinking = profile.effort ?? profile.thinking ?? (profile.model ? undefined : inheritedThinking);
    if (requestedThinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(requestedThinking)) {
      throw new Error('Invalid Pi thinking level');
    }
    const thinkingLevel = requestedThinking as ThinkingLevel | undefined;
    const manager = await prepareSession(path, workDir, api.SessionManager);
    const releaseLease = await acquireSessionLease(path);
    let child: ChildSession | undefined;
    let loader: InstanceType<PiSdk['DefaultResourceLoader']> | undefined;
    try {
      const settings = api.SettingsManager.inMemory({
        packages: [], extensions: [], skills: [], prompts: [], themes: [],
        cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false,
      }, { projectTrusted });
      let current: ChildRun | undefined;
      const steering = createChildSteering(() => current);
      const messages = createChildMessageWindow<ChildRun>(manager);
      const configuredTools = customTools?.filter((tool) => roleAllowsTool(profile.name, tool.name, 'configured'));
      const extraTools = new Set(configuredTools?.map((tool) => tool.name));
      let serverFor = (_name: string): string | undefined => undefined;
      let policy = childToolPolicy(profile, tools, extraTools, (name) => serverFor(name));
      const allow = (name: string): boolean => policy(name);
      const guard: ExtensionFactory = (pi) => {
        pi.on('tool_call', (event) => {
          if (!allow(event.toolName)) return { block: true, reason: 'Tool is outside the child allowlist' };
        });
      };
      const factories: InlineExtension[] = [guard];
      const mcpEnabled = profile.mcp !== false && profile.mcpServers?.length !== 0;
      const discovery: string[] = [];
      let initialDiscovery: string[] = [];
      if (mcpEnabled) {
        const mcp = await childMcpFactory(api, { ...profile, extensions: resources.extensions }, configDir, workDir, projectTrusted, path,
          profile.timeoutMs > 0 ? Math.min(profile.timeoutMs, 10000) : 10000);
        serverFor = mcp.serverFor; initialDiscovery = mcp.indirect;
        if (allow('codemode') && api.createCodemodeExtension) { factories.push(api.createCodemodeExtension({ mode: 'on', models: false })); discovery.push('codemode'); }
        if (allow('tool_search') && api.createToolSearchExtension) { factories.push(api.createToolSearchExtension()); discovery.push('tool_search'); }
        factories.push(mcp.extension);
      }
      // Last input handler, followed by a synchronous guard at the actual SDK steering sink.
      factories.push({ name: 'task-agents-steering-guard', factory: steering.extension });
      loader = new api.DefaultResourceLoader({
        cwd: workDir, agentDir: configDir, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: resources.extensions, additionalSkillPaths: resources.skillPaths, extensionFactories: factories,
        disabledBuiltinExtensions: ['mcp'],
        extensionsOverride: (base) => filterConfiguredToolDefinitions(base, resources.extensions, profile.name),
        promptsOverride: (base) => ({ ...base, prompts: [] }), themesOverride: (base) => ({ ...base, themes: [] }),
        systemPromptOverride: () => undefined,
        appendSystemPromptOverride: () => [
          'You are a leaf worker. Complete the assigned task. Do not create or delegate tasks.', profile.instructions ?? '',
        ].filter(Boolean),
        skillsOverride: (base) => {
          const skills = [...resources.inheritedSkills, ...base.skills.filter((skill) =>
            resources.inheritSkills || resources.skillNames.includes(normalizedSelectorName(skill.name)) ||
            resources.selectedPaths.some((entry) => within(entry, resolve(skill.filePath))))];
          return { ...base, skills: [...new Map(skills.filter((skill) => !skillCeiling || skillCeiling.has(normalizedSelectorName(skill.name)))
            .map((skill) => [skill.name, skill])).values()] };
        },
      });
      await loader.reload();
      const plugins = [...pluginToolNames(loader, resources.extensions), ...(configuredTools?.map((tool) => tool.name) ?? [])];
      for (const name of plugins) extraTools.add(name);
      const excludeTools = [...new Set([...recursiveTools, ...taskChildBlockedTools])];
      if (!mcpEnabled) excludeTools.push('mcp__*', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource');
      const { session } = await api.createAgentSession({
        cwd: workDir, agentDir: configDir, modelRuntime: steering.scopeRuntime(runtime), model, thinkingLevel,
        tools: sdkToolSelection(tools, plugins, allow, discovery, mcpEnabled), excludeTools,
        customTools: configuredTools?.filter((tool) => allow(tool.name)), settingsManager: settings, resourceLoader: loader, sessionManager: manager,
      });
      if (session.setActiveToolsByName && session.getActiveToolNames) session.setActiveToolsByName(session.getActiveToolNames()
        .filter((name) => !discovery.includes(name) || tools.includes(name) || initialDiscovery.includes(name)));
      let profileReady = false;
      const sessionPrompt = session.prompt.bind(session);
      session.prompt = (text, options) => profileReady ? sessionPrompt(text, options) :
        Promise.reject(new Error('Child profile must be persisted before prompting'));
      steering.attach(session);
      let closed = false, shutdownComplete = false;
      let closing: Promise<void> | undefined, extensionError: Error | undefined;
      const unsubscribe = session.subscribe((event) => {
        const run = current;
        if (!run) return;
        run.eventCount++;
        switch (event.type) {
          case 'message_end': {
            messages.observe(run, event.message);
            if (event.message.role !== 'assistant' && event.message.role !== 'toolResult') break;
            if (event.message.role === 'assistant') run.last = event.message;
            const usage = event.message.usage;
            if (usage) {
              for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) run.usage[key] += Number(usage[key] ?? 0);
              run.usage.cost += Number(usage.cost?.total ?? 0);
            }
            break;
          }
          case 'tool_execution_start':
          case 'tool_execution_end': {
            const name = /^[A-Za-z0-9_.-]+$/.test(event.toolName) ? event.toolName : 'tool';
            notify(onActivity, `${name}: ${event.type === 'tool_execution_end' ? (event.isError ? 'failed' : 'done') : 'running'}`);
            break;
          }
          case 'auto_retry_start': notify(onActivity, 'Retrying model request'); break;
          case 'compaction_start': notify(onActivity, 'Compacting context'); break;
          case 'agent_settled': run.settled = true; run.aborted ||= event.aborted; run.resolve(); break;
        }
      });
      async function shutdown(): Promise<void> {
        if (!shutdownComplete) {
          const priorError = extensionError;
          if (session.extensionRunner.hasHandlers('session_shutdown')) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
          if (extensionError !== priorError) throw extensionError;
          shutdownComplete = true;
        }
        // Do not release the lease or forget subscriptions until disposal succeeds.
        await session.dispose();
        unsubscribe(); current = undefined; releaseLease();
      }
      child = {
        sessionPath: path,
        prompt(text: string, options: ChildPromptOptions = {}): Promise<ChildResult> {
          if (closed) return Promise.reject(new Error('Child session is disposed'));
          if (current) return Promise.reject(new Error('Child session is already running'));
          if (typeof text !== 'string') return Promise.reject(new Error('Prompt must be a string'));
          if (options.turnId !== undefined && (typeof options.turnId !== 'string' || !options.turnId.trim())) return Promise.reject(new Error('Turn ID must be a nonempty string'));
          const run: ChildRun = { id: options.turnId ?? randomUUID(), controller: new AbortController(), resolve: () => {}, eventCount: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } };
          const settled = new Promise<void>((resolve) => { run.resolve = resolve; });
          current = run;
          messages.begin(run);
          let timer: ReturnType<typeof setTimeout> | undefined;
          run.done = (async (): Promise<ChildResult> => {
            let returnedStatus: 'succeeded' | 'failed' | 'aborted' | undefined;
            let failure: unknown, cleanupSucceeded = true;
            try {
              notify(onActivity, 'Running');
              if (profile.timeoutMs > 0) timer = setTimeout(() => {
                run.failure = Object.assign(new Error('Child session timed out'), { name: 'TimeoutError' });
                child!.abort().catch(() => {});
              }, profile.timeoutMs);
              await steering.prompt(session, run, text, { expandPromptTemplates: false, source: 'extension',
                preflightResult: (result) => { if (result === 'handled') run.resolve(); } });
              if (run.aborted && !run.settled) await session.abort();
              await settled;
              if ((!run.settled && !run.aborted) || (!run.last && !run.aborted && !run.controller.signal.aborted)) {
                throw new Error('Child prompt completed without a settled assistant response');
              }
              failure = run.failure ?? (run.aborted || run.last?.stopReason === 'aborted' ? abortError() : extensionError ??
                (run.last?.stopReason === 'error' ? new Error(redact(run.last.errorMessage ?? 'Child model request failed')) : undefined));
              returnedStatus = run.failure ? 'failed' : run.aborted || run.last?.stopReason === 'aborted' ? 'aborted' : failure ? 'failed' : 'succeeded';
            } catch (error) {
              failure = run.failure ?? error;
              run.controller.abort(error);
              try { await session.abort(); } catch (abortFailure) {
                cleanupSucceeded = false;
                failure = cleanupFailure(new AggregateError([failure, abortFailure], 'Child abort cleanup failed'));
              }
            } finally { clearTimeout(timer); }
            try { await steering.close(run, session); await chmod(path, 0o600); }
            catch (error) { cleanupSucceeded = false; returnedStatus = undefined; failure = cleanupFailure(error); }
            const committed = messages.read(run);
            if (!committed.available && returnedStatus) { returnedStatus = undefined; failure = new Error('Child committed messages are unavailable'); }
            const result: ChildResult = { text: redact(committed.text), usage: run.usage, eventCount: run.eventCount,
              outcome: returnedStatus ? { kind: 'returned', status: returnedStatus } : { kind: 'exception' },
              subTurnId: run.id, resolvedAgentName: profile.name };
            if (cleanupSucceeded) current = undefined;
            if (failure) throw Object.assign(safeError(failure), { partialResult: result });
            notify(onActivity, 'Completed');
            return result;
          })();
          return run.done;
        },
        async steer(text: string): Promise<unknown> {
          if (typeof text !== 'string') throw Object.assign(new Error('Steering input must be a string'), { steerAccepted: false });
          if (closed || !current || current.settled || !session.isStreaming) throw Object.assign(new Error('Child session is not running'), { steerAccepted: false });
          if (current.aborted || current.controller.signal.aborted) throw Object.assign(abortError(), { steerAccepted: false });
          return steering.steer(session, text);
        },
        async abort(): Promise<void> {
          if (current) { current.aborted = true; current.controller.abort(abortError()); }
          await session.abort();
        },
        dispose(): Promise<void> {
          if (!closing) {
            closed = true;
            const attempt = (async () => {
              const done = current?.done;
              // Failed abort/dispose keeps the lease and can be retried by the owner.
              await child!.abort();
              await done?.catch(() => {});
              await shutdown();
            })().catch((error) => { throw cleanupFailure(error); });
            closing = attempt;
            void attempt.catch(() => { if (closing === attempt) closing = undefined; });
          }
          return closing;
        },
      };
      try {
        if (thinkingLevel !== undefined && session.thinkingLevel !== thinkingLevel) {
          throw new Error(`Requested child thinking level ${thinkingLevel} is unsupported for ${profile.model ?? model.id}; Pi selected ${session.thinkingLevel}`);
        }
        await session.bindExtensions({ mode: 'json', abortHandler: () => { child!.abort().catch(() => {}); },
          shutdownHandler: () => { child!.abort().catch(() => {}); },
          onError: (error) => { if (!steering.staleInput()) extensionError = new Error(`Child extension failed: ${redact(error.error)}`); } });
        // Factories already ran during reload. Reject diagnostics only once native shutdown is owned and observable.
        if (loader.getExtensions().errors.length || loader.getSkills().diagnostics.some((item) => item.type === 'error')) {
          throw new Error('Could not load the explicitly configured child resources');
        }
        if (extensionError) throw extensionError;
        for (const name of pluginToolNames(loader, resources.extensions)) extraTools.add(name);
        if (session.getCallableToolNames().some((name) => !allow(name))) throw new Error('Pi exposed tools outside the child allowlist');
        const names = [...new Set(loader.getSkills().skills.map((skill) => skill.name))];
        skillCeiling = normalizeSelector(names);
        const facts = observedToolFacts(session, allow, extraTools);
        policy = childToolPolicy({ ...profile, nativeToolSnapshot: facts.nativeToolSnapshot }, tools, extraTools, (name) => serverFor(name));
        const actualModel = session.model ?? model;
        const resolved = { ...profile, tools: requested, ...facts, model: `${actualModel.provider}/${actualModel.id}`,
          thinking: session.thinkingLevel, skills: names, skillSnapshot: names };
        const frozen = Object.freeze(Object.fromEntries(Object.entries(resolved).map(([key, value]) =>
          [key, Array.isArray(value) ? Object.freeze([...value]) : value]))) as unknown as AgentProfile;
        await onProfileResolved?.(frozen);
        if (extensionError) throw extensionError;
        profileReady = true;
      } catch (error) {
        try { await child.dispose(); }
        catch (cleanupError) {
          throw Object.assign(cleanupFailure(new AggregateError([error, cleanupError], 'Child initialization and cleanup failed')),
            { cleanupChild: child });
        }
        throw safeError(error);
      }
      return child;
    } catch (error) {
      const loaded = !child ? loader?.getExtensions() : undefined;
      if (loaded?.extensions.length) {
        // A constructor may bind the shared runtime before throwing, without returning its session.
        // Restore native uninitialized actions; keep the original invalidator for event-bus cleanup.
        let runner: InstanceType<PiSdk['ExtensionRunner']> | undefined, closing: Promise<void> | undefined;
        child = {
          sessionPath: path,
          prompt: async () => { throw new Error('Child session is not initialized'); },
          steer: async () => { throw Object.assign(new Error('Child session is not initialized'), { steerAccepted: false }); },
          abort: async () => {},
          dispose() {
            if (!closing) {
              const attempt = (async () => {
                if (!runner) {
                  const inactive = api.createExtensionRuntime();
                  for (const key of Object.keys(inactive) as (keyof typeof inactive)[]) {
                    if (typeof inactive[key] === 'function' && !['assertActive', 'invalidate', 'trackEventBusSubscription'].includes(key)) {
                      Object.defineProperty(loaded.runtime, key, { value: inactive[key], configurable: true, writable: true });
                    }
                  }
                  const cleanupRunner = new api.ExtensionRunner(loaded.extensions, loaded.runtime, workDir, manager, new api.ModelRegistry(runtime));
                  const createContext = cleanupRunner.createContext.bind(cleanupRunner);
                  cleanupRunner.createContext = () => {
                    const context = createContext();
                    return Object.defineProperties(context, {
                      model: { get: () => { void context.cwd; return model; } },
                      thinkingLevel: { get: () => { void context.cwd; return manager.buildSessionContext().thinkingLevel; } },
                      isProjectTrusted: { value: () => { void context.cwd; return projectTrusted; } },
                    });
                  };
                  runner = cleanupRunner;
                }
                let shutdownError: Error | undefined;
                const unsubscribe = runner.onError((failure) => { shutdownError = new Error(`Child extension failed: ${redact(failure.error)}`); });
                try {
                  await runner.emit({ type: 'session_shutdown', reason: 'quit' });
                  if (shutdownError) throw shutdownError;
                  runner.invalidate();
                  releaseLease();
                } finally { unsubscribe(); }
              })().catch((failure) => { throw cleanupFailure(failure); });
              closing = attempt;
              void attempt.catch(() => { if (closing === attempt) closing = undefined; });
            }
            return closing;
          },
        };
        try { await child.dispose(); }
        catch (cleanupError) {
          error = Object.assign(cleanupFailure(new AggregateError([error, cleanupError], 'Child initialization and cleanup failed')),
            { cleanupChild: child });
        }
      }
      if (!child) releaseLease();
      const failure = safeError(error);
      if (child && isRecord(error) && error.cleanupChild === child) failure.cleanupChild = child;
      throw failure;
    }
  };
}
