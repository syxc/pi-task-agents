import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverResourcePaths } from '../src/resource-discovery.ts'

test('a non-directory project state path cannot fail resource discovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-resource-discovery-')),
    cwd = join(root, 'workspace'),
    agentDir = join(root, 'agent')
  t.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all([mkdir(cwd), mkdir(agentDir)])
  await writeFile(join(cwd, '.pi'), 'not a directory')
  const scopes: string[] = []
  const sdk = {
    DefaultPackageManager: class {
      async resolve() {
        return { extensions: [], skills: [] }
      }
    },
    SettingsManager: {
      fromStorage(
        storage: { withLock(scope: string, callback: (text?: string) => unknown): void },
        options: { projectTrusted?: boolean }
      ) {
        for (const scope of ['global', 'project'] as const) {
          if (scope === 'project' && !options.projectTrusted) {
            continue
          }
          scopes.push(scope)
          storage.withLock(scope, () => undefined)
        }
        return {}
      }
    }
  }
  assert.deepEqual(await discoverResourcePaths(sdk as never, cwd, agentDir, true), {
    extensions: [],
    skills: []
  })
  assert.deepEqual(scopes, ['global', 'project'])
})
