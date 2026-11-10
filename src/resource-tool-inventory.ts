import type { AgentSession, ResourceLoader } from '@earendil-works/pi-coding-agent'
import type { AgentProfile } from './types.ts'
import {
  isSelectorMcp,
  mcpResources,
  normalizedSelectorName,
  roleAllowsTool
} from './resource-selection.ts'

/** Remove forbidden configured definitions, not their extension or permission hooks. */
export function filterConfiguredToolDefinitions(
  base: ReturnType<ResourceLoader['getExtensions']>,
  paths: readonly string[],
  role: string
): typeof base {
  for (const extension of base.extensions) {
    if (!paths.includes(extension.resolvedPath)) {
      continue
    }
    for (const name of extension.tools.keys()) {
      if (!roleAllowsTool(role, name)) {
        extension.tools.delete(name)
      }
    }
  }
  return base
}

/** Only accepted extension sources may add tools beyond the native selection. */
export function pluginToolNames(loader: ResourceLoader, paths: readonly string[]): string[] {
  return loader
    .getExtensions()
    .extensions.filter((entry) => paths.includes(entry.resolvedPath))
    .flatMap((entry) => [...entry.tools.keys()])
}

export function sdkToolSelection(
  requested: readonly string[],
  pluginTools: readonly string[],
  allow: (name: string) => boolean,
  discovery: readonly string[],
  mcp: boolean
): string[] {
  // Keep user selectors exact; the MCP registration slot remains guarded per tool.
  return [
    ...new Set(
      [...requested.map(normalizedSelectorName), ...pluginTools, ...discovery]
        .filter((name) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) && allow(name))
        .concat(
          mcp ? ['mcp__*', ...mcpResources].filter((name) => name === 'mcp__*' || allow(name)) : []
        )
    )
  ]
}

export function observedToolFacts(
  session: AgentSession,
  allow: (name: string) => boolean,
  pluginTools: ReadonlySet<string>
): Pick<AgentProfile, 'nativeToolSnapshot' | 'toolInventory'> {
  const reachable = new Set([
    ...session.getCallableToolNames(),
    ...(session.getActiveToolNames?.() ?? [])
  ])
  const inventory = session
    .getAllTools?.()
    .filter((tool) => tool.exposure !== 'hidden' && reachable.has(tool.name))
    .map((tool) => tool.name) ?? [...reachable]
  const toolInventory = [...new Set(inventory.filter(allow))]
  const nativeToolSnapshot = toolInventory.filter(
    (name) => !isSelectorMcp(name) && !pluginTools.has(name)
  )
  return { toolInventory, nativeToolSnapshot }
}
