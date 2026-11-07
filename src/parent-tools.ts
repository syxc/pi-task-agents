import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ParentRuntimeSnapshot } from './parent-runtime.ts';
import { taskChildBlockedTools } from './resource-selection.ts';

export type ParentTool = ToolDefinition & {
  sourceInfo: ReturnType<ExtensionAPI['getAllTools']>[number]['sourceInfo'];
  mcpRegistrationSource?: string;
  mcpRegistrationSources?: readonly { name: string; source: string }[];
  delegate?: (args: unknown, signal: AbortSignal | undefined, update: Parameters<ToolDefinition['execute']>[3], permits: ToolPermission) => ReturnType<ToolDefinition['execute']>;
};
export type ToolPermission = (name: string, args: unknown) => boolean;
type Dispatch = (ctx: ExtensionToolContext) => ReturnType<ToolDefinition['execute']>;
const abortError = () => Object.assign(new Error('Parent tool admission canceled'), { name: 'AbortError' });

/** Share the parent's execution pipeline, not extension factories or MCP credentials. */
export function createParentTools(pi: ExtensionAPI) {
  const pending = new Map<string, Dispatch>();
  const dispatchers = new WeakMap<object, ExtensionToolContext['tools'][number]>();
  const permissionIds = new WeakMap<ToolPermission, string>();
  const scopes = new Map<string, { permits: ToolPermission; users: number }>();
  const prefix = 'task-agent-' + randomUUID() + '/';
  let options: { skills: Skill[] } | undefined;
  let skills: Skill[] = [];
  let owner: object | undefined;
  let sessionId: string | undefined;
  let generation = 0;
  let toolEpoch = 0;
  // Pi clears nested-call IDs at agent_end; each child policy otherwise shares a bounded recorder.
  pi.on('agent_end', () => { toolEpoch++; });
  pi.on('tool_call', event => {
    if (!event.parentToolCallId?.startsWith(prefix)) return;
    const scope = scopes.get(event.parentToolCallId);
    if (!scope?.permits(event.toolName, event.input)) return { block: true, reason: 'Tool is outside the delegated child scope' };
    scopes.set(event.toolCallId, scope);
  });
  pi.on('tool_execution_end', event => { scopes.delete(event.toolCallId); });
  pi.on('before_agent_start', event => { options = event.systemPromptOptions; });
  pi.on('agent_start', (_event, ctx) => {
    skills = structuredClone(options?.skills ?? []);
    options = undefined;
    owner = ctx.sessionManager;
    sessionId = ctx.sessionManager.getSessionId();
  });
  pi.on('session_start', (_event, ctx) => {
    generation++;
    skills = []; options = undefined;
    owner = ctx.sessionManager;
    sessionId = ctx.sessionManager.getSessionId();
  });

  return {
    bind(name: string, ctx: ExtensionContext) {
      const wrapper = (ctx as ExtensionToolContext).tools?.find(tool => tool.name === name);
      if (wrapper) dispatchers.set(ctx, wrapper);
    },
    // This private path only constructs a fresh native context. The target always goes through executeTool.
    dispatch(id: string, ctx: ExtensionContext): ReturnType<ToolDefinition['execute']> | undefined {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      return call(ctx as ExtensionToolContext);
    },
    invalidate() { generation++; pending.clear(); scopes.clear(); skills = []; options = undefined; },
    async capture(ctx: ExtensionContext, signal?: AbortSignal): Promise<ParentRuntimeSnapshot> {
      if (signal?.aborted) throw abortError();
      const toolCtx = ctx as ExtensionToolContext;
      const dispatcher = dispatchers.get(ctx) ?? toolCtx.tools?.find(tool => tool.name === 'task');
      if (!dispatcher || typeof toolCtx.executeTool !== 'function') {
        throw new Error('Task admission requires Pi tool execution context');
      }
      const admitted = generation, manager = ctx.sessionManager, id = manager.getSessionId();
      const assertOwner = () => {
        if (generation !== admitted || manager !== owner || id !== sessionId) throw new Error('Parent tool owner is no longer active');
        // Reading a native context getter rejects a disposed or reloaded runner.
        if (ctx.sessionManager !== manager) throw new Error('Parent tool context changed');
      };
      assertOwner();
      const callable = new Set(toolCtx.tools.map(tool => tool.name));
      const definitions = pi.getAllTools().filter(tool => callable.has(tool.name) && tool.exposure !== 'hidden'
        && !taskChildBlockedTools.includes(tool.name.trim().normalize('NFKC').toLowerCase())
        && !['codemode', 'tool_search', 'bash_task'].includes(tool.name));
      const fingerprints = new Map(definitions.map(definition => [definition.name, JSON.stringify(definition)]));
      const registrations = pi.getMcpServers();
      const tools: ParentTool[] = definitions.map(definition => {
        const delegate: NonNullable<ParentTool['delegate']> = async (args, callSignal, onUpdate, permits) => {
          assertOwner();
          if (callSignal?.aborted) throw abortError();
          const current = pi.getAllTools().find(tool => tool.name === definition.name);
          if (!current || JSON.stringify(current) !== fingerprints.get(definition.name)) throw new Error('Parent tool definition changed; start a new task');
          let policyId = permissionIds.get(permits);
          if (!policyId) { policyId = randomUUID(); permissionIds.set(permits, policyId); }
          const invocation = `${prefix}${policyId}-${toolEpoch}`;
          const scope = scopes.get(invocation) ?? { permits, users: 0 };
          scope.users++; scopes.set(invocation, scope);
          pending.set(invocation, async fresh => {
            const outcome = await fresh.executeTool(definition.name, args, { signal: callSignal, onUpdate });
            return { ...outcome.result, ...(outcome.isError ? { isError: true } : {}) };
          });
          try { return await dispatcher.execute(invocation, {}, callSignal, onUpdate); }
          finally {
            pending.delete(invocation);
            if (--scope.users === 0) scopes.delete(invocation);
          }
        };
        return { ...definition, label: definition.name, delegate,
          mcpRegistrationSource: registrations.find(entry => definition.namespace?.name === 'mcp__' + entry.name.replace(/-/g, '_'))?.extensionPath,
          mcpRegistrationSources: registrations.map(entry => ({ name: entry.name, source: entry.extensionPath })),
          execute: (_id, args, callSignal, onUpdate, childCtx) => delegate(args, callSignal, onUpdate,
            name => childCtx.tools.some(tool => tool.name === name)),
        };
      });
      const settings = pi.getSettings();
      const native: ParentRuntimeSnapshot['settings'] = {};
      for (const key of ['shellPath', 'shellCommandPrefix'] as const) {
        if (settings[key] !== undefined) {
          if (typeof settings[key] !== 'string') throw new Error('Invalid inherited native shell setting: ' + key);
          native[key] = settings[key];
        }
      }
      return { tools, resources: { getExtensions: () => ({ extensions: [] }), getSkills: () => ({ skills: structuredClone(skills) }) },
        mcp: null, settings: native };
    },
  };
}
