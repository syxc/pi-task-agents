import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type Skill,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { ParentRuntimeSnapshot } from './parent-runtime.ts'
import { taskChildBlockedTools } from './resource-selection.ts'
import { taskExecutionBinding, type ParentToolBinding } from './task-execution-context.ts'

export type ParentTool = ToolDefinition & {
  sourceInfo: ReturnType<ExtensionAPI['getAllTools']>[number]['sourceInfo']
  mcpRegistrationSource?: string
  mcpRegistrationSources?: readonly { name: string; source: string }[]
  delegate?: (
    args: unknown,
    signal: AbortSignal | undefined,
    update: Parameters<ToolDefinition['execute']>[3],
    permits: ToolPermission
  ) => ReturnType<ToolDefinition['execute']>
}
export type ToolPermission = (name: string, args: unknown) => boolean
type Dispatch = (ctx: ExtensionToolContext) => ReturnType<ToolDefinition['execute']>
const abortError = () =>
  Object.assign(new Error('Parent tool admission canceled'), { name: 'AbortError' })
const nativeLeaves = new Set(['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls'])
const mcpLeaves = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource'
])

/** The trusted host's provenance, not a tool's name or reachability hints, identifies audited code. */
function verifiedLeaf(tool: ReturnType<ExtensionAPI['getAllTools']>[number]): boolean {
  // These implementations never call executeTool or retain a delegated context.
  // Re-audit before accepting another SDK version or built-in implementation.
  if (VERSION !== '1.5.0' || tool.sourceInfo.source !== 'builtin') {
    return false
  }
  if (tool.sourceInfo.path === 'builtin:' + tool.name) {
    return nativeLeaves.has(tool.name)
  }
  return (
    tool.sourceInfo.path === 'builtin:mcp' &&
    (mcpLeaves.has(tool.name) ||
      (tool.name.startsWith('mcp__') && tool.namespace?.name.startsWith('mcp__') === true))
  )
}

/** Share the parent's execution pipeline, not extension factories or MCP credentials. */
export function createParentTools(pi: ExtensionAPI) {
  const pending = new Map<string, Dispatch>()
  const dispatchers = new WeakMap<object, ParentToolBinding>()
  const permissionIds = new WeakMap<ToolPermission, string>()
  type Scope = { active: boolean; caller: string; check: ToolPermission; cancel: AbortController }
  const authority = new AsyncLocalStorage<Scope>()
  const scopes = new Set<Scope>()
  const prefix = 'task-agent-' + randomUUID() + '/'
  let options: { skills: Skill[] } | undefined
  let skills: Skill[] = []
  let owner: object | undefined
  let sessionId: string | undefined
  let generation = 0
  let toolEpoch = 0
  const revoke = () => {
    for (const scope of scopes) {
      scope.active = false
      scope.cancel.abort()
    }
  }
  // Pi clears nested-call IDs at agent_end; each child policy otherwise shares a bounded recorder.
  pi.on('agent_end', () => {
    toolEpoch++
  })
  pi.on('tool_call', (event) => {
    const parent = event.parentToolCallId
    if (!parent) {
      return
    }
    const scope = authority.getStore()
    if (!scope && !parent.startsWith(prefix)) {
      return
    }
    if (!scope?.active || scope.caller !== parent || !scope.check(event.toolName, event.input)) {
      return {
        block: true,
        reason: 'Tool is outside the delegated child scope or its authority has expired'
      }
    }
    // Only the root-to-leaf hop is admitted. Unknown implementations are
    // excluded before dispatch: a nested serial call queues before this hook.
  })
  pi.on('before_agent_start', (event) => {
    options = event.systemPromptOptions
  })
  pi.on('agent_start', (_event, ctx) => {
    skills = structuredClone(options?.skills ?? [])
    options = undefined
    owner = ctx.sessionManager
    sessionId = ctx.sessionManager.getSessionId()
  })
  pi.on('session_start', (_event, ctx) => {
    generation++
    skills = []
    options = undefined
    owner = ctx.sessionManager
    sessionId = ctx.sessionManager.getSessionId()
  })

  return {
    bind(name: string, id: string, ctx: ExtensionContext, inline: boolean) {
      const wrapper = (ctx as ExtensionToolContext).tools?.find((tool) => tool.name === name)
      const binding = wrapper && {
        owner: pi,
        ctx: ctx as ExtensionToolContext,
        tool: wrapper,
        id,
        inline
      }
      if (binding) {
        dispatchers.set(ctx, binding)
      }
      return {
        run: <T>(execute: () => T): T => taskExecutionBinding.run(binding, execute),
        release() {
          if (binding) {
            binding.inline = false
          }
        }
      }
    },
    // This private path only constructs a fresh native context. The target always goes through executeTool.
    dispatch(id: string, ctx: ExtensionContext): ReturnType<ToolDefinition['execute']> | undefined {
      const call = pending.get(id)
      if (!call) {
        return
      }
      pending.delete(id)
      return call(ctx as ExtensionToolContext)
    },
    invalidate() {
      generation++
      revoke()
      pending.clear()
      skills = []
      options = undefined
    },
    async capture(ctx: ExtensionContext, signal?: AbortSignal): Promise<ParentRuntimeSnapshot> {
      if (signal?.aborted) {
        throw abortError()
      }
      const toolCtx = ctx as ExtensionToolContext
      const binding = dispatchers.get(ctx)
      const dispatcher = binding?.tool ?? toolCtx.tools?.find((tool) => tool.name === 'task')
      if (!dispatcher || typeof toolCtx.executeTool !== 'function') {
        throw new Error('Task admission requires Pi tool execution context')
      }
      const admitted = generation,
        manager = ctx.sessionManager,
        id = manager.getSessionId()
      const assertOwner = () => {
        if (generation !== admitted || manager !== owner || id !== sessionId) {
          throw new Error('Parent tool owner is no longer active')
        }
        // Reading a native context getter rejects a disposed or reloaded runner.
        if (ctx.sessionManager !== manager) {
          throw new Error('Parent tool context changed')
        }
      }
      assertOwner()
      const callable = new Set(toolCtx.tools.map((tool) => tool.name))
      const definitions = pi
        .getAllTools()
        .filter(
          (tool) =>
            verifiedLeaf(tool) &&
            callable.has(tool.name) &&
            tool.exposure !== 'hidden' &&
            !taskChildBlockedTools.includes(tool.name.trim().normalize('NFKC').toLowerCase()) &&
            !['codemode', 'tool_search', 'bash_task'].includes(tool.name)
        )
      const fingerprints = new Map(
        definitions.map((definition) => [definition.name, JSON.stringify(definition)])
      )
      const registrations = pi.getMcpServers()
      const tools: ParentTool[] = definitions.map((definition) => {
        const delegate: NonNullable<ParentTool['delegate']> = async (
          args,
          callSignal,
          onUpdate,
          permits
        ) => {
          assertOwner()
          if (callSignal?.aborted) {
            throw abortError()
          }
          const current = pi.getAllTools().find((tool) => tool.name === definition.name)
          if (
            !current ||
            !verifiedLeaf(current) ||
            JSON.stringify(current) !== fingerprints.get(definition.name)
          ) {
            throw new Error('Parent tool definition changed; start a new task')
          }
          let policyId = permissionIds.get(permits)
          if (!policyId) {
            policyId = randomUUID()
            permissionIds.set(permits, policyId)
          }
          const invocation = `${prefix}${policyId}-${toolEpoch}`
          // A retained child keeps its original inventory, but each execution
          // uses the binding captured for that task's own admission.
          const executing = taskExecutionBinding.getStore()
          const activeBinding = executing?.owner === pi ? executing : binding
          const inline = activeBinding?.inline === true
          const caller = inline ? activeBinding.id : invocation
          const cancel = new AbortController()
          const combined = callSignal ? AbortSignal.any([callSignal, cancel.signal]) : cancel.signal
          const scope: Scope = {
            active: true,
            caller,
            cancel,
            check: (name, input) => {
              try {
                assertOwner()
                const live = pi.getAllTools().find((tool) => tool.name === name)
                return (
                  !combined.aborted &&
                  permits(name, input) &&
                  !!live &&
                  verifiedLeaf(live) &&
                  JSON.stringify(live) === fingerprints.get(name)
                )
              } catch {
                return false
              }
            }
          }
          const invoke: Dispatch = async (fresh) => {
            const outcome = await fresh.executeTool(definition.name, args, {
              signal: combined,
              onUpdate
            })
            if (!scope.active || combined.aborted) {
              throw abortError()
            }
            return { ...outcome.result, ...(outcome.isError ? { isError: true } : {}) }
          }
          scopes.add(scope)
          // A waiting foreground admission must keep the SDK's real ancestry:
          // inventing a caller ID loses holdsQueue and waits on its own Task.
          if (!inline) {
            pending.set(invocation, invoke)
          }
          try {
            return await authority.run(scope, () =>
              inline
                ? invoke(activeBinding.ctx)
                : (activeBinding?.tool ?? dispatcher).execute(invocation, {}, combined, onUpdate)
            )
          } finally {
            scope.active = false
            pending.delete(invocation)
            scopes.delete(scope)
          }
        }
        return {
          ...definition,
          label: definition.name,
          delegate,
          mcpRegistrationSource: registrations.find(
            (entry) => definition.namespace?.name === 'mcp__' + entry.name.replace(/-/g, '_')
          )?.extensionPath,
          mcpRegistrationSources: registrations.map((entry) => ({
            name: entry.name,
            source: entry.extensionPath
          })),
          execute: (_id, args, callSignal, onUpdate, childCtx) =>
            delegate(args, callSignal, onUpdate, (name) =>
              childCtx.tools.some((tool) => tool.name === name)
            )
        }
      })
      const settings = pi.getSettings()
      const native: ParentRuntimeSnapshot['settings'] = {}
      for (const key of ['shellPath', 'shellCommandPrefix'] as const) {
        if (settings[key] !== undefined) {
          if (typeof settings[key] !== 'string') {
            // oxlint-disable-next-line unicorn/prefer-type-error -- Preserve the existing public Error type during this lint-only change.
            throw new Error('Invalid inherited native shell setting: ' + key)
          }
          native[key] = settings[key]
        }
      }
      return {
        tools,
        resources: {
          getExtensions: () => ({ extensions: [] }),
          getSkills: () => ({ skills: structuredClone(skills) })
        },
        mcp: null,
        settings: native
      }
    }
  }
}
