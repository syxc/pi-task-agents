import { access } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { ResourceLoader, Skill } from '@earendil-works/pi-coding-agent';
import type { AgentProfile } from './types.ts';
import { isResourceName, localPaths, sameFile, within, normalizedSelectorName } from './resource-selection.ts';
import { discoverResourcePaths } from './resource-discovery.ts';
import { loadConfig } from './config.ts';

/** A snapshot of resources already accepted by the host. Never reload the host loader. */
export type HostResources = Pick<ResourceLoader, 'getExtensions' | 'getSkills'>;

export async function childResources(profile: AgentProfile, cwd: string, agentDir: string,
  projectTrusted: boolean, host?: HostResources, sdk?: Parameters<typeof discoverResourcePaths>[0]): Promise<{
    extensions: string[]; skillPaths: string[]; selectedPaths: string[]; inheritedSkills: Skill[]; skillNames: string[]; inheritSkills: boolean;
  }> {
  const allowedSource = (source: { scope: string }): boolean => projectTrusted || source.scope !== 'project';
  const inheritedSkills = (host?.getSkills().skills ?? []).filter((skill) => allowedSource(skill.sourceInfo));
  const discovered = !host && sdk && (profile.extensions?.length !== 0 || profile.skills?.length !== 0)
    ? await discoverResourcePaths(sdk, cwd, agentDir, projectTrusted) : { extensions: [], skills: [] };
  const extensionCandidates = [
    ...(host?.getExtensions().extensions ?? []).filter((entry) => allowedSource(entry.sourceInfo) &&
      !entry.path.startsWith('builtin:')),
    ...discovered.extensions.map((path) => ({ path, resolvedPath: path })),
  ];
  const extensions: string[] = [];
  const requested = profile.extensions;
  for (const entry of extensionCandidates) {
    if (requested && !requested.some((selector) => isResourceName(selector) &&
      [basename(entry.resolvedPath).replace(/\.[^.]+$/, ''), basename(dirname(entry.resolvedPath))].map(normalizedSelectorName).includes(normalizedSelectorName(selector)))) continue;
    try { extensions.push(...await localPaths([entry.resolvedPath], cwd, true)); }
    catch (error) {
      // Exclude our own host entry before evaluating its factory, including symlink aliases.
      if (!(error instanceof Error) || !error.message.includes('cannot load itself')) throw error;
    }
  }
  for (const selector of requested ?? []) {
    if (!isResourceName(selector)) extensions.push(...await localPaths([selector], cwd, true));
  }
  // Snapshot names are not path authority: explicit directories must still appear in
  // the current role configuration loaded under the current project trust decision.
  const currentRole = profile.skillSnapshot === undefined ? undefined :
    (await loadConfig({ cwd, agentDir, projectTrusted })).roles[profile.name];
  const currentSelectors = profile.skillSnapshot === undefined ? profile.skills : currentRole ? currentRole.skills : [];
  const inheritSkills = currentSelectors === undefined;
  const skillNames = (currentSelectors ?? []).filter(isResourceName).map(normalizedSelectorName);
  const skillPaths = await localPaths((currentSelectors ?? []).filter((entry) => !isResourceName(entry)), cwd, false);
  const selectedPaths = [...skillPaths];
  skillPaths.push(...discovered.skills);
  if (!host && profile.skills?.length !== 0) {
    // Without a host snapshot, discover only standard local directories. Package resources
    // and resources_discover contributions require the host's accepted snapshot.
    const globalSkills = resolve(agentDir, 'skills');
    const aliasedProject = !projectTrusted && await sameFile(globalSkills, resolve(cwd, '.pi/skills'));
    for (const candidate of [...(aliasedProject ? [] : [globalSkills]), ...(projectTrusted ? [resolve(cwd, '.pi/skills'), resolve(cwd, '.agents/skills')] : [])]) {
      try { await access(candidate); skillPaths.push(candidate); } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }
  const selectedSkills = inheritedSkills.filter((skill) => inheritSkills || skillNames.includes(normalizedSelectorName(skill.name)) ||
    selectedPaths.some((path) => within(path, resolve(skill.filePath))));
  return { extensions: [...new Set(extensions)], skillPaths, selectedPaths, inheritedSkills: selectedSkills, skillNames, inheritSkills };
}
