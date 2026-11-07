import { randomUUID } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import type * as PiSdkModule from '@earendil-works/pi-coding-agent'
import type {
  AgentSessionEvent,
  ExtensionFactory,
  InlineExtension,
  CreateAgentSessionOptions,
  ModelRuntime,
  ExtensionUIContext
} from '@earendil-works/pi-coding-agent'
import type {
  AgentProfile,
  CreateChild,
  ChildSession,
  ChildResult,
  CreateChildOptions,
  ThinkingLevel,
  ChildPromptOptions
} from './types.ts'
import { childResources, type HostResources } from './resource-loader.ts'
import { childMcpFactory } from './resource-mcp.ts'
import { seedInheritedProvider, type InheritedModelRegistry } from './model-providers.ts'
import { thinkingLevels } from './config.ts'
import {
  childToolPolicy,
  normalizedSelectorName,
  normalizeSelector,
  recursiveTools,
  taskChildBlockedTools,
  roleAllowsTool,
  within
} from './resource-selection.ts'
import {
  filterConfiguredToolDefinitions,
  observedToolFacts,
  pluginToolNames,
  sdkToolSelection
} from './resource-tool-inventory.ts'
import { createChildSteering } from './child-steering.ts'
import { acquireSessionLease, prepareSession } from './child-session-file.ts'
import { createChildMessageWindow } from './child-message-window.ts'
import { captureWorkspace } from './workspace-observation.ts'
import { parseModelVerdict } from './task-verification.ts'
import { createToolFileObservation } from './tool-file-observation.ts'
import { createChildCommands } from './child-commands.ts'
import type { ParentRuntimeSnapshot } from './parent-runtime.ts'
import { selectParentTools } from './child-parent-tools.ts'

type PiSdk = Pick<
  typeof PiSdkModule,
  | 'ModelRuntime'
  | 'SessionManager'
  | 'SettingsManager'
  | 'DefaultResourceLoader'
  | 'createMcpExtension'
  | 'createAgentSession'
  | 'ExtensionRunner'
  | 'ModelRegistry'
  | 'createExtensionRuntime'
> &
  Partial<
    Pick<
      typeof PiSdkModule,
      'createCodemodeExtension' | 'createToolSearchExtension' | 'getPackageDir'
    >
  > & {
    loadMcpConfig?: Parameters<typeof childMcpFactory>[0]['loadMcpConfig']
    DefaultPackageManager?: (typeof PiSdkModule)['DefaultPackageManager']
  }
type AssistantMessage = Extract<
  Extract<AgentSessionEvent, { type: 'message_end' }>['message'],
  { role: 'assistant' }
>

export interface PiChildFactoryOptions {
  agentDir?: string
  // Injected runtimes and SDK doubles need not implement private SDK class fields.
  modelRuntime?: unknown
  sdk?: unknown
  inheritedModel?: Model<Api>
  inheritedThinking?: ThinkingLevel
  inheritedModelRegistry?: InheritedModelRegistry
  /** Host tool state, not a child configuration switch. Missing authority keeps codemode off. */
  isCodemodeEnabled?: () => boolean
  projectTrusted?: boolean
  /** Resources already loaded under host trust, including package resources. */
  resourceLoader?: HostResources
  /** Approved owner runtime; contains transient factory references and MCP configuration. */
  getParentRuntime?: () => ParentRuntimeSnapshot
  customTools?: CreateAgentSessionOptions['customTools']
}

interface ChildRun {
  id: string
  controller: AbortController
  eventCount: number
  activeTools: Map<string, { toolName: string; name: string }[]>
  usage: NonNullable<ChildResult['usage']>
  resolve: () => void
  last?: AssistantMessage
  settled?: boolean
  aborted?: boolean
  failure?: Error
  done?: Promise<ChildResult>
}
interface ChildError extends Error {
  code?: unknown
  partialResult?: ChildResult
  cleanupChild?: ChildSession
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'
const abortError = (): Error =>
  Object.assign(new Error('Child session aborted'), { name: 'AbortError' })

// Do not forward provider diagnostics, thinking blocks, tool inputs, or tool results.
function redact(text: unknown): string {
  return String(text)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}<>]+/gi,
      '$1[redacted]'
    )
}
function safeError(error: unknown): ChildError {
  const result: ChildError = new Error(redact(error instanceof Error ? error.message : error))
  if (isRecord(error) && typeof error.name === 'string' && error.name) {
    result.name = error.name
  }
  if (isRecord(error) && error.code) {
    result.code = error.code
  }
  return result
}
function cleanupFailure(error: unknown): ChildError {
  const describe = (value: unknown, depth = 0): string => {
    const safe = safeError(value)
    const code =
      typeof safe.code === 'string' || typeof safe.code === 'number'
        ? ` [${redact(safe.code)}]`
        : ''
    const head = `${safe.name}${code}: ${safe.message}`
    return value instanceof AggregateError && depth < 8
      ? [head, ...value.errors.map((item: unknown) => describe(item, depth + 1))].join('; ')
      : head
  }
  return Object.assign(new Error(describe(error), { cause: safeError(error) }), {
    code: 'CHILD_CLEANUP_FAILED'
  })
}
function notify(callback: ((value: string) => void) | undefined, value: string): void {
  try {
    Promise.resolve(callback?.(value)).catch(() => {})
  } catch {}
}

/** Create isolated leaf sessions with Pi's native tools. Tool restrictions are not an OS sandbox. */
export function createPiChildFactory({
  agentDir,
  modelRuntime,
  sdk,
  inheritedModel,
  inheritedThinking,
  inheritedModelRegistry,
  isCodemodeEnabled,
  projectTrusted = false,
  resourceLoader,
  getParentRuntime,
  customTools
}: PiChildFactoryOptions = {}): CreateChild {
  if (!agentDir) {
    throw new Error('agentDir is required')
  }
  const configDir = resolve(agentDir)
  let sdkPromise: Promise<PiSdk> | undefined
  let runtimePromise: Promise<ModelRuntime> | undefined
  const seededProviders = new Set<string>()
  return async function createChild({
    profile,
    cwd,
    sessionPath,
    onActivity,
    onProfileResolved,
    onOwnedCommandStarted
  }: CreateChildOptions): Promise<ChildSession> {
    const api = await (sdkPromise ??= Promise.resolve(
      (sdk as PiSdk | undefined) ?? import('@earendil-works/pi-coding-agent')
    ))
    const parentRuntime = getParentRuntime?.()
    const shared =
      parentRuntime?.tools && selectParentTools(parentRuntime.tools, profile, resolve(cwd))
    const resourceHost = parentRuntime?.resources ?? resourceLoader
    const required = {
      createAgentSession: api.createAgentSession,
      DefaultResourceLoader: api.DefaultResourceLoader,
      'SessionManager.create': api.SessionManager?.create,
      'SessionManager.open': api.SessionManager?.open,
      'SettingsManager.inMemory': api.SettingsManager?.inMemory,
      ExtensionRunner: api.ExtensionRunner,
      ModelRegistry: api.ModelRegistry,
      createExtensionRuntime: api.createExtensionRuntime,
      ...(modelRuntime == null ? { 'ModelRuntime.create': api.ModelRuntime?.create } : {}),
      ...(!resourceHost && (profile.extensions === undefined || profile.skills === undefined)
        ? {
            DefaultPackageManager: api.DefaultPackageManager,
            'SettingsManager.fromStorage': api.SettingsManager?.fromStorage
          }
        : {})
    }
    const missing = Object.entries(required)
      .filter(([, value]) => typeof value !== 'function')
      .map(([name]) => name)
    if (missing.length) {
      throw new Error(
        `Pi SDK is missing required child-session APIs: ${missing.join(', ')}. Use a compatible Pi release and plugin version.`
      )
    }
    if (
      ((profile.mcp !== false && profile.mcpServers?.length !== 0) || parentRuntime?.mcp != null) &&
      typeof api.createMcpExtension !== 'function'
    ) {
      throw new Error(
        'Pi SDK native MCP support is unavailable. Use a compatible Pi release and plugin version.'
      )
    }
    const workDir = resolve(cwd),
      path = resolve(sessionPath)
    const requested = profile.tools ?? ['read', 'grep', 'find']
    if (
      !Array.isArray(requested) ||
      requested.some((name) => typeof name !== 'string' || !name.trim())
    ) {
      throw new Error('Child tool selectors must be nonempty strings')
    }
    const tools = [...new Set(requested.map(normalizedSelectorName))]
    const canManageCommands =
      (!shared || shared.native.has('bash')) &&
      profile.name !== 'explore' &&
      tools.includes('bash') &&
      !profile.disallowedTools?.some((name) =>
        ['bash', 'bash_task'].includes(normalizedSelectorName(name))
      ) &&
      (profile.nativeToolSnapshot === undefined ||
        profile.nativeToolSnapshot.some((name) => normalizedSelectorName(name) === 'bash_task'))
    if (canManageCommands && !tools.includes('bash_task')) {
      tools.push('bash_task')
    }
    if (!canManageCommands) {
      const index = tools.indexOf('bash_task')
      if (index >= 0) {
        tools.splice(index, 1)
      }
    }
    for (const snapshot of [
      profile.skillSnapshot,
      profile.nativeToolSnapshot,
      profile.toolInventory,
      profile.extensionSnapshot
    ]) {
      if (
        snapshot !== undefined &&
        (!Array.isArray(snapshot) ||
          snapshot.some((name) => typeof name !== 'string' || !name.trim()))
      ) {
        throw new Error('Child resource snapshots must contain names')
      }
    }
    let skillCeiling = normalizeSelector(profile.skillSnapshot)
    const resources = await childResources(
      profile,
      workDir,
      configDir,
      projectTrusted,
      resourceHost,
      api
    )
    if (
      profile.model !== undefined &&
      (typeof profile.model !== 'string' ||
        profile.model.indexOf('/') < 1 ||
        profile.model.endsWith('/'))
    ) {
      throw new Error('Child model must be provider/id')
    }
    if (
      modelRuntime != null &&
      (!isRecord(modelRuntime) || typeof modelRuntime.getModel !== 'function')
    ) {
      throw new Error('Invalid child model runtime')
    }
    const runtime = await (runtimePromise ??= Promise.resolve(
      modelRuntime == null
        ? api.ModelRuntime.create({
            authPath: resolve(configDir, 'auth.json'),
            modelsPath: resolve(configDir, 'models.json'),
            allowModelNetwork: false,
            refreshOnCreate: false
          })
        : (modelRuntime as unknown as ModelRuntime)
    ))
    const slash = profile.model?.indexOf('/') ?? -1
    const provider = profile.model?.slice(0, slash) ?? inheritedModel?.provider
    if (provider) {
      if (seededProviders.delete(provider)) {
        runtime.unregisterProvider(provider)
      }
      if (seedInheritedProvider(runtime, inheritedModelRegistry, provider)) {
        seededProviders.add(provider)
      }
    }
    const model = profile.model
      ? runtime.getModel(profile.model.slice(0, slash), profile.model.slice(slash + 1))
      : inheritedModel
    if (!model) {
      throw new Error(
        profile.model
          ? `Unknown child model: ${profile.model}. Select an available model in Pi or omit roles.${profile.name}.model to inherit the current conversation.`
          : 'Child model requires an inherited host model. Select a model in the parent conversation first.'
      )
    }
    // Accept only native Pi levels. Provider effort/managed protocol translation belongs to the SDK, not this plugin.
    const requestedThinking =
      profile.effort ?? profile.thinking ?? (profile.model ? undefined : inheritedThinking)
    if (requestedThinking !== undefined && !thinkingLevels.includes(requestedThinking)) {
      throw new Error('Invalid Pi thinking level')
    }
    const thinkingLevel = requestedThinking as ThinkingLevel | undefined
    const manager = await prepareSession(path, workDir, api.SessionManager)
    const releaseLease = await acquireSessionLease(path)
    let child: ChildSession | undefined
    let loader: InstanceType<PiSdk['DefaultResourceLoader']> | undefined
    try {
      const settings = api.SettingsManager.inMemory(
        {
          ...parentRuntime?.settings,
          packages: [],
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
          cacheWarming: 'off',
          enableAnalytics: false,
          enableInstallTelemetry: false
        },
        { projectTrusted }
      )
      let current: ChildRun | undefined
      const steering = createChildSteering(() => current)
      const messages = createChildMessageWindow<ChildRun>(manager)
      const configuredTools = [...(shared?.tools ?? []), ...(customTools ?? [])].filter((tool) =>
        roleAllowsTool(profile.name, tool.name)
      )
      const extraTools = new Set(
        configuredTools.filter((tool) => !shared?.native.has(tool.name)).map((tool) => tool.name)
      )
      if (shared) {
        resources.extensionSnapshot = shared.extensionSnapshot
      }
      const fileObservation = createToolFileObservation({
        cwd: workDir,
        stateDirectories: [configDir, dirname(path)],
        current: () =>
          current ? { id: current.id, signal: current.controller.signal } : undefined,
        isBuiltin: (name) => {
          const source = session.getAllTools?.().find((tool) => tool.name === name)?.sourceInfo
          return (
            shared?.native.has(name) === true ||
            (!extraTools.has(name) && (!source || source.source === 'builtin'))
          )
        },
        isProgramTool: (name) => ['codemode', 'bash_task'].includes(name) && !extraTools.has(name),
        shellCommandPrefix: () => settings.getShellCommandPrefix()
      })
      const commands = canManageCommands
        ? await createChildCommands({
            manager,
            sessionPath: path,
            current: () =>
              current
                ? { id: current.id, signal: current.controller.signal, last: current.last }
                : undefined,
            isNativeBash: () =>
              shared?.native.has('bash') === true ||
              (!extraTools.has('bash') &&
                session.getAllTools?.().find((tool) => tool.name === 'bash')?.sourceInfo.source ===
                  'builtin'),
            onStarted: onOwnedCommandStarted
          })
        : undefined
      let serverFor: (name: string) => string | undefined = shared?.serverFor ?? (() => undefined)
      let policy = childToolPolicy(profile, tools, extraTools, (name) => serverFor(name))
      const sharedNames = shared && new Set(shared.tools.map((tool) => tool.name))
      const allow = (name: string): boolean =>
        policy(name) &&
        (!sharedNames ||
          sharedNames.has(name) ||
          ['codemode', 'tool_search'].includes(name) ||
          (name === 'bash_task' && canManageCommands)) &&
        (normalizedSelectorName(name) !== 'codemode' || isCodemodeEnabled?.() === true)
      const guard: ExtensionFactory = (pi) => {
        pi.on('tool_call', (event) => {
          if (!allow(event.toolName)) {
            return { block: true, reason: 'Tool is outside the child allowlist' }
          }
        })
      }
      const factories: InlineExtension[] = [
        guard,
        fileObservation.extension,
        ...(commands ? [commands.extension] : [])
      ]
      const mcpEnabled =
        profile.mcp !== false &&
        profile.mcpServers?.length !== 0 &&
        (!parentRuntime || !!shared || parentRuntime.mcp !== null)
      const mcpFactoryNeeded = !shared && (mcpEnabled || parentRuntime?.mcp != null)
      const discovery: string[] = []
      let initialDiscovery: string[] = []
      if (allow('codemode') && api.createCodemodeExtension) {
        factories.push(api.createCodemodeExtension({ mode: 'on', models: false }))
        discovery.push('codemode')
      }
      if (shared && allow('tool_search') && api.createToolSearchExtension) {
        factories.push(api.createToolSearchExtension())
        discovery.push('tool_search')
      }
      if (mcpFactoryNeeded) {
        const mcp = await childMcpFactory(
          api,
          {
            ...profile,
            extensions: resources.extensions,
            extensionSnapshot: resources.extensionSnapshot
          },
          configDir,
          workDir,
          projectTrusted,
          path,
          profile.timeoutMs > 0 ? Math.min(profile.timeoutMs, 10000) : 10000,
          parentRuntime?.mcp ?? undefined
        )
        serverFor = mcp.serverFor
        initialDiscovery = mcp.indirect
        if (allow('tool_search') && api.createToolSearchExtension) {
          factories.push(api.createToolSearchExtension())
          discovery.push('tool_search')
        }
        factories.push(mcp.extension)
      }
      // Last input handler, followed by a synchronous guard at the actual SDK steering sink.
      factories.push({ name: 'task-agents-steering-guard', factory: steering.extension })
      loader = new api.DefaultResourceLoader({
        cwd: workDir,
        agentDir: configDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalExtensionPaths: resources.extensions,
        additionalSkillPaths: resources.skillPaths,
        extensionFactories: [...resources.inlineExtensions, ...factories],
        disabledBuiltinExtensions: ['mcp'],
        extensionsOverride: (base) =>
          filterConfiguredToolDefinitions(base, resources.extensionSources, profile.name),
        promptsOverride: (base) => ({ ...base, prompts: [] }),
        themesOverride: (base) => ({ ...base, themes: [] }),
        systemPromptOverride: () => undefined,
        appendSystemPromptOverride: () =>
          [
            '## Delegated Task Contract',
            'You are a leaf Agent reporting to the parent, not the end user. Complete only the assigned task and return a concise handoff.',
            'You do not inherit the parent conversation. Use the supplied briefing and your own child-session history only.',
            'Do not delegate or create/control Agent tasks, manage parent todos or goals, or schedule independent future work.',
            'Do not ask the end user questions. Return the exact blocker and the smallest question the parent must resolve.',
            'Read authorized Memory sources when needed. Write only to an explicitly available child-owned Memory store; never modify User, shared project, or another Agent Memory. Otherwise return durable findings to the parent.',
            'Use only provided tools. When codemode is enabled, batch independent calls and filter bulky results when useful; prefer direct tools for a single simple call.',
            'Return a concise handoff with results, relevant paths, validation and blockers/risks. Do not repeat the briefing or raw logs unless needed as evidence.',
            'Report evidence and validation honestly; never claim checks you did not run.',
            profile.instructions ?? ''
          ].filter(Boolean),
        skillsOverride: (base) => {
          const skills = [
            ...resources.inheritedSkills,
            ...(!resourceHost
              ? base.skills.filter(
                  (skill) =>
                    resources.inheritSkills ||
                    resources.skillNames.includes(normalizedSelectorName(skill.name)) ||
                    resources.selectedPaths.some((entry) => within(entry, resolve(skill.filePath)))
                )
              : [])
          ]
          return {
            ...base,
            skills: [
              ...new Map(
                skills
                  .filter(
                    (skill) => !skillCeiling || skillCeiling.has(normalizedSelectorName(skill.name))
                  )
                  .map((skill) => [skill.name, skill])
              ).values()
            ]
          }
        }
      })
      await loader.reload()
      const plugins = [
        ...pluginToolNames(loader, resources.extensionSources),
        ...configuredTools.map((tool) => tool.name)
      ]
      if (commands && plugins.includes('bash_task')) {
        throw new Error('Configured tool conflicts with the owned bash_task control')
      }
      for (const name of plugins) {
        if (!shared?.native.has(name)) {
          extraTools.add(name)
        }
      }
      const excludeTools = [...new Set([...recursiveTools, ...taskChildBlockedTools])]
      if (!allow('codemode')) {
        excludeTools.push('codemode')
      }
      if (!mcpEnabled) {
        excludeTools.push(
          'mcp__*',
          'list_mcp_resources',
          'list_mcp_resource_templates',
          'read_mcp_resource'
        )
      }
      const { session } = await api.createAgentSession({
        cwd: workDir,
        agentDir: configDir,
        modelRuntime: steering.scopeRuntime(runtime),
        model,
        thinkingLevel,
        tools: sdkToolSelection(tools, plugins, allow, discovery, mcpEnabled),
        excludeTools,
        customTools: configuredTools.length
          ? configuredTools.filter((tool) => allow(tool.name))
          : undefined,
        settingsManager: settings,
        resourceLoader: loader,
        sessionManager: manager
      })
      if (session.setActiveToolsByName && session.getActiveToolNames) {
        session.setActiveToolsByName(
          session
            .getActiveToolNames()
            .filter(
              (name) =>
                !discovery.includes(name) ||
                (name === 'codemode' && allow(name)) ||
                tools.includes(name) ||
                initialDiscovery.includes(name)
            )
        )
      }
      let profileReady = false
      const sessionPrompt = session.prompt.bind(session)
      session.prompt = (text, options) =>
        profileReady
          ? sessionPrompt(text, options)
          : Promise.reject(new Error('Child profile must be persisted before prompting'))
      steering.attach(session)
      let closed = false,
        shutdownComplete = false
      let closing: Promise<void> | undefined, extensionError: Error | undefined
      const unsubscribe = session.subscribe((event) => {
        const run = current
        if (!run) {
          return
        }
        run.eventCount++
        switch (event.type) {
          case 'message_end': {
            messages.observe(run, event.message)
            if (event.message.role !== 'assistant' && event.message.role !== 'toolResult') {
              break
            }
            if (event.message.role === 'assistant') {
              run.last = event.message
            }
            const usage = event.message.usage
            if (usage) {
              for (const key of [
                'input',
                'output',
                'cacheRead',
                'cacheWrite',
                'totalTokens'
              ] as const) {
                run.usage[key] += Number(usage[key] ?? 0)
              }
              run.usage.cost += Number(usage.cost?.total ?? 0)
            }
            break
          }
          case 'tool_execution_start':
          case 'tool_execution_end': {
            const name = /^[A-Za-z0-9_.-]+$/.test(event.toolName) ? event.toolName : 'tool'
            // Pi permits duplicate IDs. Keep each start; identical ID/name calls are only countable.
            if (event.type === 'tool_execution_start') {
              if (!run.aborted && !run.controller.signal.aborted && !run.settled) {
                const calls = run.activeTools.get(event.toolCallId) ?? []
                calls.push({ toolName: event.toolName, name })
                run.activeTools.set(event.toolCallId, calls)
                notify(onActivity, `${name}: running`)
              }
            } else {
              const calls = run.activeTools.get(event.toolCallId)
              const index = calls?.findLastIndex((call) => call.toolName === event.toolName) ?? -1
              if (calls && index >= 0) {
                calls.splice(index, 1)
                if (!calls.length) {
                  run.activeTools.delete(event.toolCallId)
                }
              }
              const active = [...run.activeTools.values()].at(-1)?.at(-1)?.name
              notify(
                onActivity,
                active && !run.aborted && !run.controller.signal.aborted && !run.settled
                  ? `${active}: running`
                  : `${name}: ${event.isError ? 'failed' : 'done'}`
              )
            }
            break
          }
          case 'auto_retry_start':
            notify(onActivity, 'Retrying model request')
            break
          case 'compaction_start':
            notify(onActivity, 'Compacting context')
            break
          case 'agent_settled':
            run.settled = true
            run.aborted ||= event.aborted
            run.resolve()
            break
        }
      })
      async function shutdown(): Promise<void> {
        if (!shutdownComplete) {
          await commands?.close()
          const priorError = extensionError
          if (session.extensionRunner.hasHandlers('session_shutdown')) {
            await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
          }
          if (extensionError !== priorError) {
            throw extensionError
          }
          shutdownComplete = true
        }
        // Do not release the lease or forget subscriptions until disposal succeeds.
        await Promise.resolve(session.dispose())
        unsubscribe()
        current = undefined
        releaseLease()
      }
      child = {
        sessionPath: path,
        prompt(text: string, options: ChildPromptOptions = {}): Promise<ChildResult> {
          if (closed) {
            return Promise.reject(new Error('Child session is disposed'))
          }
          if (current) {
            return Promise.reject(new Error('Child session is already running'))
          }
          if (typeof text !== 'string') {
            return Promise.reject(new Error('Prompt must be a string'))
          }
          if (
            options.turnId !== undefined &&
            (typeof options.turnId !== 'string' || !options.turnId.trim())
          ) {
            return Promise.reject(new Error('Turn ID must be a nonempty string'))
          }
          const run: ChildRun = {
            id: options.turnId ?? randomUUID(),
            controller: new AbortController(),
            resolve: () => {},
            eventCount: 0,
            activeTools: new Map(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }
          }
          const settled = new Promise<void>((settle) => {
            run.resolve = settle
          })
          current = run
          messages.begin(run)
          fileObservation.begin(run.id)
          let timer: ReturnType<typeof setTimeout> | undefined
          run.done = (async (): Promise<ChildResult> => {
            let returnedStatus: 'succeeded' | 'failed' | 'aborted' | undefined
            let failure: unknown,
              cleanupSucceeded = true
            try {
              if (profile.timeoutMs > 0) {
                timer = setTimeout(() => {
                  run.failure = Object.assign(new Error('Child session timed out'), {
                    name: 'TimeoutError'
                  })
                  child!.abort().catch(() => {})
                }, profile.timeoutMs)
              }
              if (profile.name === 'verifier') {
                notify(onActivity, 'Inspecting workspace metadata')
                fileObservation.baseline(
                  run.id,
                  await captureWorkspace(workDir, [configDir, dirname(path)], run.controller.signal)
                )
              }
              notify(onActivity, 'Running')
              await steering.prompt(session, run, text, {
                expandPromptTemplates: false,
                source: 'extension',
                preflightResult: (result) => {
                  if (result === 'handled') {
                    run.resolve()
                  }
                }
              })
              if (run.aborted && !run.settled) {
                await session.abort()
              }
              await settled
              if (
                (!run.settled && !run.aborted) ||
                (!run.last && !run.aborted && !run.controller.signal.aborted)
              ) {
                throw new Error('Child prompt completed without a settled assistant response')
              }
              failure =
                run.failure ??
                (run.aborted || run.last?.stopReason === 'aborted'
                  ? abortError()
                  : (extensionError ??
                    (run.last?.stopReason === 'error'
                      ? new Error(redact(run.last.errorMessage ?? 'Child model request failed'))
                      : undefined)))
              returnedStatus = run.failure
                ? 'failed'
                : run.aborted || run.last?.stopReason === 'aborted'
                  ? 'aborted'
                  : failure
                    ? 'failed'
                    : 'succeeded'
            } catch (error) {
              failure = run.failure ?? error
              run.controller.abort(error)
              try {
                await session.abort()
              } catch (abortFailure) {
                cleanupSucceeded = false
                failure = cleanupFailure(
                  new AggregateError([failure, abortFailure], 'Child abort cleanup failed')
                )
              }
            } finally {
              clearTimeout(timer)
            }
            try {
              await steering.close(run, session)
              await chmod(path, 0o600)
            } catch (error) {
              cleanupSucceeded = false
              returnedStatus = undefined
              failure = cleanupFailure(error)
            }
            try {
              await commands?.finish(run.id, returnedStatus !== 'succeeded' || !!failure)
            } catch (error) {
              cleanupSucceeded = false
              returnedStatus = undefined
              failure = cleanupFailure(error)
            }
            const committed = messages.read(run)
            if (!committed.available && returnedStatus) {
              returnedStatus = undefined
              failure = new Error('Child committed messages are unavailable')
            }
            const observation = await fileObservation.finish(run.id)
            const modelVerdict =
              profile.name === 'verifier' && returnedStatus === 'succeeded'
                ? parseModelVerdict(committed.text)
                : undefined
            const verification = { ...observation, ...(modelVerdict ? { modelVerdict } : {}) }
            const result: ChildResult = {
              text: redact(committed.text),
              usage: run.usage,
              eventCount: run.eventCount,
              ...(verification ? { verification } : {}),
              ...(commands && cleanupSucceeded ? { commandCleanupConfirmed: true as const } : {}),
              outcome: returnedStatus
                ? { kind: 'returned', status: returnedStatus }
                : { kind: 'exception' },
              subTurnId: run.id,
              resolvedAgentName: profile.name
            }
            if (cleanupSucceeded) {
              current = undefined
            }
            if (failure) {
              throw Object.assign(safeError(failure), { partialResult: result })
            }
            notify(onActivity, 'Completed')
            return result
          })()
          return run.done
        },
        async steer(text: string): Promise<unknown> {
          if (typeof text !== 'string') {
            throw Object.assign(new Error('Steering input must be a string'), {
              steerAccepted: false
            })
          }
          if (closed || !current || current.settled || !session.isStreaming) {
            throw Object.assign(new Error('Child session is not running'), { steerAccepted: false })
          }
          if (current.aborted || current.controller.signal.aborted) {
            throw Object.assign(abortError(), { steerAccepted: false })
          }
          const result = await steering.steer(session, text)
          commands?.steered()
          return result
        },
        async abort(): Promise<void> {
          if (current) {
            current.aborted = true
            current.controller.abort(abortError())
          }
          if (commands) {
            await commands.abortWith(() => session.abort())
          } else {
            await session.abort()
          }
        },
        dispose(): Promise<void> {
          if (!closing) {
            closed = true
            const attempt = (async () => {
              const done = current?.done
              // Failed abort/dispose keeps the lease and can be retried by the owner.
              await child!.abort()
              await done?.catch(() => {})
              await shutdown()
            })().catch((error) => {
              throw cleanupFailure(error)
            })
            closing = attempt
            void attempt.catch(() => {
              if (closing === attempt) {
                closing = undefined
              }
            })
          }
          return closing
        }
      }
      try {
        if (thinkingLevel !== undefined && session.thinkingLevel !== thinkingLevel) {
          throw new Error(
            `Requested child thinking level ${thinkingLevel} is unsupported for ${profile.model ?? model.id}; Pi selected ${session.thinkingLevel}`
          )
        }
        // Pi shares its headless UI singleton; do not share extension-owned session caches.
        const runner = session.extensionRunner
        const uiContext = runner
          ? (Object.fromEntries(Object.entries(runner.getUIContext())) as ExtensionUIContext)
          : undefined
        if (runner) {
          runner.hasUI = () => false
        }
        await session.bindExtensions({
          ...(uiContext ? { uiContext } : {}),
          mode: 'json',
          abortHandler: () => {
            child!.abort().catch(() => {})
          },
          shutdownHandler: () => {
            child!.abort().catch(() => {})
          },
          onError: (error) => {
            if (!steering.staleInput()) {
              extensionError = new Error(`Child extension failed: ${redact(error.error)}`)
            }
          }
        })
        // Factories already ran during reload. Reject diagnostics only once native shutdown is owned and observable.
        if (
          loader.getExtensions().errors.length ||
          loader.getSkills().diagnostics.some((item) => item.type === 'error')
        ) {
          throw new Error('Could not load the explicitly configured child resources')
        }
        if (extensionError) {
          throw extensionError
        }
        await commands?.ready()
        for (const name of pluginToolNames(loader, resources.extensionSources)) {
          extraTools.add(name)
        }
        if (session.getCallableToolNames().some((name) => !allow(name))) {
          throw new Error('Pi exposed tools outside the child allowlist')
        }
        const names = [...new Set(loader.getSkills().skills.map((skill) => skill.name))]
        skillCeiling = normalizeSelector(names)
        const facts = observedToolFacts(session, allow, extraTools)
        policy = childToolPolicy(
          { ...profile, nativeToolSnapshot: facts.nativeToolSnapshot },
          tools,
          extraTools,
          (name) => serverFor(name)
        )
        const actualModel = session.model ?? model
        const resolved = {
          ...profile,
          tools: requested,
          ...facts,
          model: `${actualModel.provider}/${actualModel.id}`,
          thinking: session.thinkingLevel,
          skills: names,
          skillSnapshot: names,
          extensionSnapshot: resources.extensionSnapshot
        }
        const frozen = Object.freeze(
          Object.fromEntries(
            Object.entries(resolved).map(([key, value]) => [
              key,
              Array.isArray(value) ? Object.freeze([...value]) : value
            ])
          )
        ) as unknown as AgentProfile
        await onProfileResolved?.(frozen)
        if (extensionError) {
          throw extensionError
        }
        profileReady = true
      } catch (error) {
        try {
          await child.dispose()
        } catch (cleanupError) {
          throw Object.assign(
            cleanupFailure(
              new AggregateError([error, cleanupError], 'Child initialization and cleanup failed')
            ),
            { cleanupChild: child }
          )
        }
        throw safeError(error)
      }
      return child
    } catch (caughtError) {
      let error = caughtError
      const loaded = !child ? loader?.getExtensions() : undefined
      if (loaded?.extensions.length) {
        // A constructor may bind the shared runtime before throwing, without returning its session.
        // Restore native uninitialized actions; keep the original invalidator for event-bus cleanup.
        let runner: InstanceType<PiSdk['ExtensionRunner']> | undefined,
          closing: Promise<void> | undefined
        child = {
          sessionPath: path,
          prompt: async () => {
            // oxlint-disable-next-line preserve-caught-error -- Keep initialization failures private; this child only exposes a fixed status message.
            throw new Error('Child session is not initialized')
          },
          steer: async () => {
            throw Object.assign(new Error('Child session is not initialized'), {
              steerAccepted: false
            })
          },
          abort: async () => {},
          dispose() {
            if (!closing) {
              const attempt = (async () => {
                if (!runner) {
                  const inactive = api.createExtensionRuntime()
                  for (const key of Object.keys(inactive) as (keyof typeof inactive)[]) {
                    if (
                      typeof inactive[key] === 'function' &&
                      !['assertActive', 'invalidate', 'trackEventBusSubscription'].includes(key)
                    ) {
                      Object.defineProperty(loaded.runtime, key, {
                        value: inactive[key],
                        configurable: true,
                        writable: true
                      })
                    }
                  }
                  const cleanupRunner = new api.ExtensionRunner(
                    loaded.extensions,
                    loaded.runtime,
                    workDir,
                    manager,
                    new api.ModelRegistry(runtime)
                  )
                  const createContext = cleanupRunner.createContext.bind(cleanupRunner)
                  cleanupRunner.createContext = () => {
                    const context = createContext()
                    return Object.defineProperties(context, {
                      model: {
                        get: () => {
                          void context.cwd
                          return model
                        }
                      },
                      thinkingLevel: {
                        get: () => {
                          void context.cwd
                          return manager.buildSessionContext().thinkingLevel
                        }
                      },
                      isProjectTrusted: {
                        value: () => {
                          void context.cwd
                          return projectTrusted
                        }
                      }
                    })
                  }
                  runner = cleanupRunner
                }
                let shutdownError: Error | undefined
                const unsubscribe = runner.onError((failure) => {
                  shutdownError = new Error(`Child extension failed: ${redact(failure.error)}`)
                })
                try {
                  await runner.emit({ type: 'session_shutdown', reason: 'quit' })
                  if (shutdownError) {
                    throw shutdownError
                  }
                  runner.invalidate()
                  releaseLease()
                } finally {
                  unsubscribe()
                }
              })().catch((failure) => {
                throw cleanupFailure(failure)
              })
              closing = attempt
              void attempt.catch(() => {
                if (closing === attempt) {
                  closing = undefined
                }
              })
            }
            return closing
          }
        }
        try {
          await child.dispose()
        } catch (cleanupError) {
          error = Object.assign(
            cleanupFailure(
              new AggregateError([error, cleanupError], 'Child initialization and cleanup failed')
            ),
            { cleanupChild: child }
          )
        }
      }
      if (!child) {
        releaseLease()
      }
      const failure = safeError(error)
      if (child && isRecord(error) && error.cleanupChild === child) {
        failure.cleanupChild = child
      }
      throw failure
    }
  }
}
