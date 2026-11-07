import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as PiSdkModule from '@earendil-works/pi-coding-agent'
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  LoadedMcpConfig
} from '@earendil-works/pi-coding-agent'
import type { AgentProfile } from './types.ts'
import {
  childToolPolicy,
  isResourceName,
  isSelectorMcp,
  localPaths,
  normalizeSelector,
  normalizedSelectorName,
  sameFile
} from './resource-selection.ts'

type Sdk = Pick<typeof PiSdkModule, 'createMcpExtension'> &
  Partial<Pick<typeof PiSdkModule, 'getPackageDir'>> & {
    loadMcpConfig?: (options: {
      agentDir: string
      cwd: string
      projectTrusted: boolean
    }) => LoadedMcpConfig
  }
type Registration = ReturnType<ExtensionAPI['getMcpServers']>[number]
const namespace = (name: string) => normalizedSelectorName(`mcp__${name.replace(/-/g, '_')}`)

/** Only selection, trust and provenance live here. Connections and shutdown belong to Pi. */
export async function childMcpFactory(
  sdk: Sdk,
  profile: AgentProfile,
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
  sessionPath: string,
  startupWaitMs: number,
  inherited?: LoadedMcpConfig
): Promise<{
  extension: InlineExtension
  indirect: string[]
  serverFor(tool: string): string | undefined
}> {
  let config = inherited
  if (!config) {
    let load = sdk.loadMcpConfig
    if (!load) {
      // Direct SDK embeddings may lack a parent snapshot; resolve their loader from the supplied host SDK.
      try {
        const root = sdk.getPackageDir?.()
        if (!root) {
          throw new Error('Missing host SDK package directory')
        }
        load = (await import(pathToFileURL(resolve(root, 'dist/extensions/mcp/config.js')).href))
          .loadMcpConfig
      } catch {
        throw new Error(
          'Pi native MCP configuration API is unavailable. Update Pi and pi-task-agents to compatible versions.'
        )
      }
    }
    if (!load) {
      throw new Error('Pi MCP config loader is unavailable')
    }
    config =
      !projectTrusted &&
      (await sameFile(resolve(agentDir, 'mcp.json'), resolve(cwd, '.pi/mcp.json')))
        ? ({ servers: [], errors: [] } as LoadedMcpConfig)
        : load({ agentDir, cwd, projectTrusted })
  }
  const servers = normalizeSelector(profile.mcpServers)
  const tools = normalizeSelector(profile.tools ?? [])!
  const explicitMcp = (profile.tools ?? []).some(isSelectorMcp)
  const extensionFiles = await localPaths(
    (profile.extensions ?? []).filter((entry) => !isResourceName(entry)),
    cwd,
    true
  )
  const serverAllowed = (name: string) =>
    profile.mcp !== false && (!servers || servers.has(normalizedSelectorName(name)))
  const constrain = (name: string, value: Registration['config']): Registration['config'] => ({
    ...value,
    ...(explicitMcp && ![...tools].some((tool) => tool.startsWith(`${namespace(name)}__`))
      ? { enabled: false }
      : {})
  })
  const accepted = []
  for (const entry of config.servers) {
    if (!serverAllowed(entry.name)) {
      continue
    }
    // oxlint-disable no-await-in-loop -- Preserve ordered provenance checks and first-match selection.
    if (
      inherited &&
      entry.scope === 'extension' &&
      !profile.extensionSnapshot?.some(
        (identity) =>
          identity === entry.source ||
          (/^<inline:\d+>$/.test(entry.source) && identity.startsWith(entry.source + '#factory:'))
      ) &&
      !(
        await Promise.all(extensionFiles.map((file) => sameFile(file, resolve(cwd, entry.source))))
      ).some(Boolean)
    ) {
      continue
    }
    // oxlint-enable no-await-in-loop
    accepted.push(entry)
  }
  const files = accepted.map((entry) => ({ ...entry, config: constrain(entry.name, entry.config) }))
  const shadowed = new Set(config.servers.map((entry) => namespace(entry.name)))
  let visible: Registration[] = []
  const owners = new Map<string, string>()
  const serverFor = (tool: string) => owners.get(normalizedSelectorName(tool))
  const allowed = childToolPolicy(profile, profile.tools ?? [], undefined, serverFor)
  async function snapshot(pi: ExtensionAPI): Promise<void> {
    visible = []
    if (inherited) {
      return
    }
    for (const entry of pi.getMcpServers()) {
      if (!serverAllowed(entry.name) || shadowed.has(namespace(entry.name))) {
        continue
      }
      for (const file of extensionFiles) {
        // oxlint-disable-next-line no-await-in-loop -- Preserve ordered provenance checks and first-match selection.
        if (await sameFile(file, resolve(cwd, entry.extensionPath))) {
          visible.push({ ...entry, config: constrain(entry.name, entry.config) })
          break
        }
      }
    }
  }
  const factory = sdk.createMcpExtension({
    startupWaitMs,
    loadConfig: () => ({ ...config, servers: files }),
    logPath: resolve(dirname(sessionPath), 'mcp.log'),
    openUrl: () => {
      throw new Error('Child MCP sign-in requires the parent host')
    },
    updateConfig: () => {
      throw new Error('Child sessions cannot change MCP settings')
    }
  })
  const extension: InlineExtension = {
    name: 'task-agents-mcp',
    factory: async (pi) => {
      await snapshot(pi)
      return factory(
        new Proxy(pi, {
          get(target, property, receiver) {
            if (property === 'getMcpServers') {
              return () => visible
            }
            if (property === 'registerCommand') {
              return () => {}
            }
            if (property === 'on') {
              return ((
                event: string,
                handler: (event: unknown, ctx: ExtensionContext) => unknown
              ) => {
                if (!['session_start', 'mcp_servers_change'].includes(event)) {
                  return target.on(event as never, handler as never)
                }
                return target.on(
                  event as never,
                  (async (value: unknown, ctx: ExtensionContext) => {
                    await snapshot(target)
                    return handler(value, ctx)
                  }) as never
                )
              }) as ExtensionAPI['on']
            }
            if (property === 'registerTool') {
              return ((definition) => {
                const owner = [...files, ...visible].find(
                  (entry) =>
                    entry.config.enabled !== false &&
                    namespace(entry.name) ===
                      normalizedSelectorName(definition.namespace?.name ?? '')
                )
                const name = normalizedSelectorName(definition.name)
                if (owner) {
                  owners.set(name, owner.name)
                } else {
                  owners.delete(name)
                }
                const keep =
                  (!isSelectorMcp(definition.name) || !!owner) && allowed(definition.name)
                target.registerTool({
                  ...definition,
                  ...(keep ? {} : { exposure: 'hidden' as const })
                })
                if (keep && definition.exposure !== 'hidden' && explicitMcp && tools.has(name)) {
                  target.setActiveTools([...target.getActiveTools(), definition.name])
                }
              }) as ExtensionAPI['registerTool']
            }
            return Reflect.get(target, property, receiver)
          }
        })
      )
    }
  }
  const exposures = new Set(
    files.flatMap((entry) =>
      entry.config.enabled === false
        ? []
        : [entry.config.exposure ?? 'codemode', ...Object.values(entry.config.toolExposure ?? {})]
    )
  )
  return {
    extension,
    serverFor,
    indirect: [
      ...(config.autoEnableCodemode !== false && exposures.has('codemode') ? ['codemode'] : []),
      ...(exposures.has('deferred') ? ['tool_search'] : [])
    ].filter(allowed)
  }
}
