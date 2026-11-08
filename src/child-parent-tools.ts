import { basename, dirname, resolve } from 'node:path'
import type { AgentProfile } from './types.ts'
import type { ParentTool, ToolPermission } from './parent-tools.ts'
import { isRecord } from './guards.ts'
import {
  childToolPolicy,
  isResourceName,
  isSelectorMcp,
  mcpResources,
  normalizeSelector,
  normalizedSelectorName,
  roleAllowsTool,
  within
} from './resource-selection.ts'

/** Select within the live parent inventory; explicit paths never load executable code. */
export function selectParentTools(
  inventory: readonly ParentTool[],
  profile: AgentProfile,
  cwd: string
) {
  const native = new Set<string>(),
    plugins: string[] = [],
    sources = new Set<string>(),
    owners = new Map<string, string>()
  const ceiling = normalizeSelector(profile.toolInventory),
    extensions = profile.extensionSnapshot && new Set(profile.extensionSnapshot)
  const servers = normalizeSelector(profile.mcpServers)
  // Names alone cannot reauthorize extension code or registrations on a historical profile.
  const legacyInheritance = profile.toolInventory !== undefined && extensions === undefined
  const sourceAllowed = (source: string) =>
    !legacyInheritance &&
    (!extensions || extensions.has(source)) &&
    (!profile.extensions ||
      profile.extensions.some((selector) =>
        isResourceName(selector)
          ? [
              basename(source).replace(/\.[^.]+$/, ''),
              basename(dirname(source)),
              source.replace(/^<inline:|>$/g, '')
            ]
              .map(normalizedSelectorName)
              .includes(normalizedSelectorName(selector))
          : within(resolve(cwd, selector), resolve(cwd, source))
      ))
  const tools = inventory.filter((tool) => {
    const name = normalizedSelectorName(tool.name),
      source = tool.sourceInfo.path
    const builtin = tool.sourceInfo.source === 'builtin' && source === 'builtin:' + tool.name
    if (!roleAllowsTool(profile.name, tool.name) || (ceiling && !ceiling.has(name))) {
      return false
    }
    const mcp = isSelectorMcp(tool.name) || mcpResources.includes(name)
    if (
      mcp &&
      (profile.mcp === false ||
        servers?.size === 0 ||
        (tool.mcpRegistrationSource && !sourceAllowed(tool.mcpRegistrationSource)))
    ) {
      return false
    }
    if (isSelectorMcp(tool.name)) {
      const namespace = tool.namespace?.name
      if (!namespace?.startsWith('mcp__')) {
        return false
      }
      const server =
        tool.namespace?.aliases?.find(
          (alias) => 'mcp__' + alias.replace(/-/g, '_') === namespace
        ) ?? namespace.slice(5)
      owners.set(name, server)
      if (servers && !servers.has(normalizedSelectorName(server))) {
        return false
      }
    }
    if (!builtin && !mcp) {
      if (!sourceAllowed(source)) {
        return false
      }
      plugins.push(tool.name)
      sources.add(source)
    }
    if (mcpResources.includes(name)) {
      for (const entry of tool.mcpRegistrationSources ?? []) {
        if (sourceAllowed(entry.source)) {
          sources.add(entry.source)
        }
      }
    }
    if (tool.mcpRegistrationSource) {
      sources.add(tool.mcpRegistrationSource)
    }
    if (builtin) {
      native.add(tool.name)
    }
    return true
  })
  const serverFor = (name: string) => owners.get(normalizedSelectorName(name))
  const policy = childToolPolicy(
    profile,
    profile.tools ?? ['read', 'grep', 'find'],
    new Set(plugins),
    serverFor
  )
  const definitions = new Map(tools.map((tool) => [tool.name, tool]))
  const permits: ToolPermission = (name, args, registrations) => {
    const tool = definitions.get(name)
    if (!tool || !policy(name)) {
      return false
    }
    if (isSelectorMcp(name)) {
      const source =
        registrations === undefined
          ? tool.mcpRegistrationSource
          : registrations.find(
              (entry) => tool.namespace?.name === 'mcp__' + entry.name.replace(/-/g, '_')
            )?.source
      if (source && (!sourceAllowed(source) || !sources.has(source))) {
        return false
      }
    }
    if (mcpResources.includes(normalizedSelectorName(name))) {
      const blockedServers = new Set(
        (registrations ?? tool.mcpRegistrationSources ?? [])
          .filter((entry) => !sourceAllowed(entry.source) || !sources.has(entry.source))
          .map((entry) => normalizedSelectorName(entry.name))
      )
      if (servers || blockedServers.size) {
        const server =
          isRecord(args) && typeof args.server === 'string'
            ? normalizedSelectorName(args.server)
            : undefined
        if (!server || (servers && !servers.has(server)) || blockedServers.has(server)) {
          return false
        }
      }
    }
    return true
  }
  const selected = tools.map((tool) => ({
    ...tool,
    async execute(...args: Parameters<ParentTool['execute']>) {
      // Delegates use live provenance: a removed registration may now be file-backed.
      if (!tool.delegate && !permits(tool.name, args[1])) {
        throw new Error('Tool call requires an allowed server and child scope')
      }
      return tool.delegate
        ? tool.delegate(args[1], args[2], args[3], permits)
        : tool.execute(...args)
    }
  }))
  return { tools: selected, native, extensionSnapshot: [...sources], serverFor }
}
