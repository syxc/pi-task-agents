import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  Skill,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import { inheritedShellSettings, type ParentRuntimeSnapshot } from './parent-runtime.ts'
import { isRecord } from './guards.ts'
import { mcpResources, taskChildBlockedTools } from './resource-selection.ts'
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
export type ToolPermission = (
  name: string,
  args: unknown,
  registrations?: ParentTool['mcpRegistrationSources']
) => boolean
type Dispatch = (ctx: ExtensionToolContext) => ReturnType<ToolDefinition['execute']>
const abortError = () =>
  Object.assign(new Error('Parent tool admission canceled'), { name: 'AbortError' })
const nativeLeaves = new Set(['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls'])

/** The trusted host's provenance, not a tool's name or reachability hints, identifies audited code. */
function verifiedLeaf(tool: ReturnType<ExtensionAPI['getAllTools']>[number]): boolean {
  // These implementations never call executeTool or retain a delegated context.
  // Re-audit before accepting another built-in implementation.
  if (tool.sourceInfo.source !== 'builtin') {
    return false
  }
  if (tool.sourceInfo.path === 'builtin:' + tool.name) {
    return nativeLeaves.has(tool.name)
  }
  return (
    tool.sourceInfo.path === 'builtin:mcp' &&
    (mcpResources.includes(tool.name) ||
      (tool.name.startsWith('mcp__') && tool.namespace?.name.startsWith('mcp__') === true))
  )
}

/** Tool execution contexts are SDK boundary data; nested calls require both members. */
const isToolContext = (value: unknown): value is ExtensionToolContext =>
  isRecord(value) && Array.isArray(value.tools) && typeof value.executeTool === 'function'

/** Share the parent's execution pipeline, not extension factories or MCP credentials. */
export function createParentTools(pi: ExtensionAPI) {
  const pending = new Map<string, Dispatch>()
  const dispatchers = new WeakMap<object, ParentToolBinding>()
  const permissionIds = new WeakMap<ToolPermission, string>()
  type Scope = {
    active: boolean
    caller: string
    toolName: string
    args: unknown
    check: ToolPermission
    cancel: AbortController
  }
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
  const registrationSources = () =>
    pi.getMcpServers().map((entry) => ({ name: entry.name, source: entry.extensionPath }))
  // A later permission hook may still be waiting when a registration changes.
  pi.on('mcp_servers_change', () => {
    for (const scope of scopes) {
      if (!scope.check(scope.toolName, scope.args)) {
        scope.cancel.abort()
      }
    }
  })
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
      const toolCtx = isToolContext(ctx) ? ctx : undefined
      const wrapper = toolCtx?.tools.find((tool) => tool.name === name)
      const binding = toolCtx &&
        wrapper && {
          owner: pi,
          ctx: toolCtx,
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
      if (!isToolContext(ctx)) {
        throw new Error('Nested tool calls require a Pi tool execution context')
      }
      return call(ctx)
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
      if (!isToolContext(ctx)) {
        throw new Error('Task admission requires Pi tool execution context')
      }
      const binding = dispatchers.get(ctx)
      const dispatcher = binding?.tool ?? ctx.tools.find((tool) => tool.name === 'task')
      if (!dispatcher) {
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
      const callable = new Set(ctx.tools.map((tool) => tool.name))
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
      const registrations = registrationSources()
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
          if (
            !permits(
              definition.name,
              args,
              definition.sourceInfo.path === 'builtin:mcp' ? registrationSources() : undefined
            )
          ) {
            throw new Error('Parent tool call is outside the delegated child scope')
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
            toolName: definition.name,
            args,
            cancel,
            check: (name, input) => {
              try {
                assertOwner()
                const live = pi.getAllTools().find((tool) => tool.name === name)
                return (
                  !combined.aborted &&
                  permits(
                    name,
                    input,
                    live?.sourceInfo.path === 'builtin:mcp' ? registrationSources() : undefined
                  ) &&
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
          )?.source,
          mcpRegistrationSources: registrations,
          execute: (_id, args, callSignal, onUpdate, childCtx) =>
            delegate(args, callSignal, onUpdate, (name) =>
              childCtx.tools.some((tool) => tool.name === name)
            )
        }
      })
      return {
        tools,
        resources: {
          getExtensions: () => ({ extensions: [] }),
          getSkills: () => ({ skills: structuredClone(skills) })
        },
        mcp: null,
        settings: inheritedShellSettings(pi.getSettings())
      }
    }
  }
}
