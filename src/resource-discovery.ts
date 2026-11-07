import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { sameFile } from './resource-selection.ts'

type DiscoverySdk = {
  DefaultPackageManager?: typeof DefaultPackageManager
  SettingsManager: Pick<typeof SettingsManager, 'fromStorage'>
}

/** Resolve trusted, already installed resources without installation, configuration writes or code evaluation. */
export async function discoverResourcePaths(
  sdk: DiscoverySdk,
  cwd: string,
  agentDir: string,
  projectTrusted: boolean
): Promise<{
  extensions: string[]
  skills: string[]
}> {
  if (
    !sdk.DefaultPackageManager ||
    !sdk.SettingsManager.fromStorage ||
    (!projectTrusted && (await sameFile(agentDir, resolve(cwd, '.pi'))))
  ) {
    return { extensions: [], skills: [] }
  }
  const globalFile = resolve(agentDir, 'settings.json')
  const projectFile = resolve(cwd, '.pi/settings.json')
  const aliased = !projectTrusted && (await sameFile(globalFile, projectFile))
  const settings = sdk.SettingsManager.fromStorage(
    {
      withLock(scope, callback) {
        let text: string | undefined
        if (!(scope === 'global' && aliased) && (scope === 'global' || projectTrusted)) {
          try {
            text = readFileSync(scope === 'global' ? globalFile : projectFile, 'utf8')
          } catch (error) {
            if (
              !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
            ) {
              throw error
            }
          }
        }
        if (callback(text) !== undefined) {
          throw new Error('Child resource discovery cannot change host settings')
        }
      }
    },
    { projectTrusted }
  )
  const paths = await new sdk.DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: settings
  }).resolve(async () => 'skip')
  const enabled = (entries: typeof paths.extensions): string[] =>
    entries
      .filter(
        (entry) =>
          entry.enabled &&
          (projectTrusted || entry.metadata.scope !== 'project') &&
          !entry.path.startsWith('builtin:')
      )
      .map((entry) => entry.path)
  return { extensions: enabled(paths.extensions), skills: enabled(paths.skills) }
}
