import { access } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type {
  ExtensionFactory,
  InlineExtension,
  Skill,
  SourceInfo
} from '@earendil-works/pi-coding-agent'
import type { AgentProfile } from './types.ts'
import {
  isResourceName,
  isUnavailablePath,
  localPaths,
  sameFile,
  within,
  normalizedSelectorName
} from './resource-selection.ts'
import { discoverResourcePaths } from './resource-discovery.ts'
import { loadConfig } from './config.ts'

/** A snapshot of resources already accepted by the host. Never reload the host loader. */
export interface HostExtensionResource {
  path: string
  resolvedPath: string
  sourceInfo: SourceInfo
  factory?: ExtensionFactory
  factoryId?: string
  hidden?: boolean
  replaceable?: boolean
  mcpConnector?: boolean
}
export interface HostResources {
  getExtensions(): { extensions: HostExtensionResource[] }
  getSkills(): { skills: Skill[] }
}

export interface ChildResources {
  extensions: {
    paths: string[]
    inline: InlineExtension[]
    sources: string[]
  }
  skills: {
    paths: string[]
    selectedPaths: string[]
    inherited: Skill[]
    names: string[]
    inherit: boolean
  }
  snapshots: {
    extensions: string[]
  }
}

export async function childResources({
  profile,
  cwd,
  agentDir,
  projectTrusted,
  host,
  sdk
}: {
  profile: AgentProfile
  cwd: string
  agentDir: string
  projectTrusted: boolean
  host?: HostResources
  sdk?: Parameters<typeof discoverResourcePaths>[0]
}): Promise<ChildResources> {
  const allowedSource = (source: { scope: string }): boolean =>
    projectTrusted || source.scope !== 'project'
  const inheritedSkills = (host?.getSkills().skills ?? []).filter((skill) =>
    allowedSource(skill.sourceInfo)
  )
  const discovered =
    !host && sdk && (profile.extensions?.length !== 0 || profile.skills?.length !== 0)
      ? await discoverResourcePaths(sdk, cwd, agentDir, projectTrusted)
      : { extensions: [], skills: [] }
  const extensionCandidates: Array<Omit<HostExtensionResource, 'sourceInfo'>> = [
    ...(host?.getExtensions().extensions ?? []).filter((entry) => allowedSource(entry.sourceInfo)),
    ...discovered.extensions.map((path) => ({ path, resolvedPath: path }))
  ]
  const extensions: string[] = [],
    inlineExtensions: InlineExtension[] = [],
    inlineSources: string[] = [],
    inlineSnapshot: string[] = []
  const requested = profile.extensions
  const explicitExtensions = await localPaths(
    (requested ?? []).filter((selector) => !isResourceName(selector)),
    cwd,
    true
  )
  const extensionCeiling = profile.extensionSnapshot && new Set(profile.extensionSnapshot)
  if (
    host &&
    profile.toolInventory !== undefined &&
    !extensionCeiling &&
    requested === undefined &&
    extensionCandidates.length
  ) {
    throw Object.assign(
      new Error(
        'Historical extension identities were not saved; explicit resource reauthorization is required'
      ),
      { code: 'LEGACY_RESOURCE_SNAPSHOT_REQUIRED' }
    )
  }
  for (const entry of extensionCandidates) {
    if (entry.factory) {
      const anonymous = /^<inline:\d+>$/.test(entry.path)
      if (anonymous && !entry.factoryId) {
        throw new Error('Anonymous extension factory identity is unavailable')
      }
      const identity = anonymous ? entry.path + '#factory:' + entry.factoryId : entry.path
      const approved =
        !extensionCeiling ||
        extensionCeiling.has(identity) ||
        (anonymous &&
          [...extensionCeiling].some((saved) => saved.endsWith('#factory:' + entry.factoryId)))
      if (requested?.length === 0 || !approved) {
        continue
      }
      const name = entry.path.replace(/^<inline:(.*)>$/, '$1').replace(/^builtin:/, '')
      if (
        !extensionCeiling &&
        requested &&
        !requested.some(
          (selector) =>
            isResourceName(selector) &&
            normalizedSelectorName(selector) === normalizedSelectorName(name)
        )
      ) {
        continue
      }
      const childName = 'task-agents-inherited:' + name
      inlineExtensions.push({
        name: childName,
        factory: entry.factory,
        hidden: entry.hidden,
        replaceable: entry.replaceable
      })
      inlineSources.push(`<inline:${childName}>`)
      inlineSnapshot.push(identity)
      continue
    }
    if (entry.path.startsWith('builtin:')) {
      continue
    }
    const byName = requested?.some(
      (selector) =>
        isResourceName(selector) &&
        [
          basename(entry.resolvedPath).replace(/\.[^.]+$/, ''),
          basename(dirname(entry.resolvedPath))
        ]
          .map(normalizedSelectorName)
          .includes(normalizedSelectorName(selector))
    )
    if (requested && !byName && !explicitExtensions.length) {
      continue
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- Preserve resource selection order and first-failure behavior.
      const paths = await localPaths([entry.resolvedPath], cwd, true)
      extensions.push(
        ...paths.filter(
          (path) =>
            requested === undefined ||
            byName ||
            explicitExtensions.some((scope) => within(scope, path))
        )
      )
    } catch (error) {
      // Exclude our own host entry before evaluating its factory, including symlink aliases.
      if (!(error instanceof Error) || !error.message.includes('cannot load itself')) {
        throw error
      }
    }
  }
  if (!host) {
    extensions.push(...explicitExtensions)
  }
  // Snapshot names are not path authority: explicit directories must still appear in
  // the current role configuration loaded under the current project trust decision.
  // A saved role may outlive its config entry; a missing role grants no skill selectors.
  const currentRole =
    profile.skillSnapshot === undefined
      ? undefined
      : (await loadConfig({ cwd, agentDir, projectTrusted })).roles[profile.name]
  const currentSelectors =
    profile.skillSnapshot === undefined ? profile.skills : (currentRole?.skills ?? [])
  const inheritSkills = currentSelectors === undefined
  const skillNames = (currentSelectors ?? []).filter(isResourceName).map(normalizedSelectorName)
  const skillPaths = await localPaths(
    (currentSelectors ?? []).filter((entry) => !isResourceName(entry)),
    cwd,
    false
  )
  const selectedPaths = [...skillPaths]
  skillPaths.push(...discovered.skills)
  if (!host && profile.skills?.length !== 0) {
    // Without a host snapshot, discover only standard local directories. Package resources
    // and resources_discover contributions require the host's accepted snapshot.
    const globalSkills = resolve(agentDir, 'skills')
    const aliasedProject =
      !projectTrusted && (await sameFile(globalSkills, resolve(cwd, '.pi/skills')))
    for (const candidate of [
      ...(aliasedProject ? [] : [globalSkills]),
      ...(projectTrusted ? [resolve(cwd, '.pi/skills'), resolve(cwd, '.agents/skills')] : [])
    ]) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Preserve resource selection order and first-failure behavior.
        await access(candidate)
        skillPaths.push(candidate)
      } catch (error) {
        if (!isUnavailablePath(error)) {
          throw error
        }
      }
    }
  }
  const selectedSkills = inheritedSkills.filter(
    (skill) =>
      inheritSkills ||
      skillNames.includes(normalizedSelectorName(skill.name)) ||
      selectedPaths.some((path) => within(path, resolve(skill.filePath)))
  )
  const files = [...new Set(extensions)].filter(
    (path) => !extensionCeiling || extensionCeiling.has(path)
  )
  return {
    extensions: {
      paths: files,
      inline: inlineExtensions,
      sources: [...files, ...inlineSources]
    },
    skills: {
      paths: host ? [] : skillPaths,
      selectedPaths,
      inherited: selectedSkills,
      names: skillNames,
      inherit: inheritSkills
    },
    snapshots: { extensions: [...files, ...inlineSnapshot] }
  }
}
