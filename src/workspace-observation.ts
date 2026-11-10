import { lstat, opendir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { hasCode } from './guards.ts'
import { within } from './resource-selection.ts'

export interface WorkspaceSnapshot {
  entries: Map<string, string>
  error?: string
}

const ignoredDirectories = new Set(['.git', 'node_modules'])
export const WORKSPACE_OBSERVATION_SCOPE =
  'Workspace metadata only; excludes .git, node_modules and agent state. File contents are not read and symlink entries are not traversed. Concurrent path replacements are not a security boundary; changes are not attributed to this child.'

/** Bounded evidence, not a sandbox or a proof that no transient write occurred. */
export async function captureWorkspace(
  cwd: string,
  stateDirectories: readonly string[],
  signal?: AbortSignal,
  limit = 20000
): Promise<WorkspaceSnapshot> {
  const entries = new Map<string, string>()
  const deadline = performance.now() + 1000
  try {
    const root = await realpath(cwd)
    const excluded: string[] = []
    for (const directory of stateDirectories) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Keep traversal bounded and preserve cancellation and early exits.
        excluded.push(await realpath(directory))
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) {
          throw error
        }
        excluded.push(resolve(directory))
      }
    }
    if (excluded.some((path) => within(path, root))) {
      return { entries, error: 'workspace_overlaps_agent_state' }
    }
    const rootInfo = await lstat(root, { bigint: true })
    entries.set('.', `${rootInfo.dev}:${rootInfo.ino}:${rootInfo.mode}`)
    const directories = [root]
    let visited = 0
    while (directories.length) {
      if (signal?.aborted) {
        return { entries, error: 'observation_aborted' }
      }
      if (performance.now() > deadline) {
        return { entries, error: 'observation_time_limit' }
      }
      const directory = directories.pop()
      if (directory === undefined) {
        break
      }
      // Refuse ordinary directory-to-symlink replacements; observation is still best effort under races.
      // oxlint-disable-next-line no-await-in-loop -- Keep traversal bounded and preserve cancellation and early exits.
      if ((await realpath(directory)) !== directory || !within(root, directory)) {
        return { entries, error: 'observation_path_changed' }
      }
      // oxlint-disable-next-line no-await-in-loop -- Keep traversal bounded and preserve cancellation and early exits.
      const handle = await opendir(directory)
      // oxlint-disable-next-line no-await-in-loop -- Keep traversal bounded and preserve cancellation and early exits.
      for await (const entry of handle) {
        if (signal?.aborted) {
          return { entries, error: 'observation_aborted' }
        }
        if (performance.now() > deadline) {
          return { entries, error: 'observation_time_limit' }
        }
        if (++visited > limit) {
          return { entries, error: 'observation_entry_limit' }
        }
        const path = join(directory, entry.name)
        if (
          excluded.some((excludedDirectory) => within(excludedDirectory, path)) ||
          ignoredDirectories.has(entry.name)
        ) {
          continue
        }
        const info = await lstat(path, { bigint: true })
        const identity = `${info.dev}:${info.ino}:${info.mode}`
        entries.set(
          relative(root, path),
          info.isDirectory() ? identity : `${identity}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
        )
        if (info.isDirectory()) {
          directories.push(path)
        }
      }
    }
    return { entries }
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unavailable'
    return { entries, error: `observation_failed:${code}` }
  }
}
