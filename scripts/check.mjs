import { readFile, readdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(manifest.type, 'module')
assert.deepEqual(manifest.pi.extensions, ['./src/extension.ts'])
for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', 'typebox']) {
  assert.equal(manifest.peerDependencies[name], '*')
  assert.ok(manifest.devDependencies[name])
  assert.equal(manifest.dependencies?.[name], undefined)
}
for (const entry of manifest.files) {
  // eslint-disable-next-line no-await-in-loop -- Keep resource checks ordered and stop at the first invalid manifest entry.
  assert.ok(await stat(resolve(root, entry)))
}
for (const dir of ['src', 'scripts', 'test']) {
  // eslint-disable-next-line no-await-in-loop -- Finish each directory's syntax checks before reading the next directory.
  for (const name of await readdir(join(root, dir))) {
    if (!/\.(?:js|mjs)$/.test(name)) {
      continue
    }
    const file = join(root, dir, name)
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
}
JSON.parse(await readFile(join(root, 'examples/task-agents.json'), 'utf8'))
console.log('Syntax, package manifest, declared resources and example JSON passed.')
