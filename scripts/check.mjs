import { readFile, readdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(manifest.type, 'module')
assert.deepEqual(manifest.pi.extensions, ['./src/extension.ts'])
for (const name of Object.keys({
  ...manifest.peerDependencies,
  ...manifest.devDependencies,
  ...manifest.dependencies
})) {
  if (!name.startsWith('@earendil-works/pi-')) {
    continue
  }
  assert.equal(manifest.peerDependencies[name], '^1.5.0', name)
  assert.equal(manifest.devDependencies[name], '^1.5.0', name)
  assert.equal(manifest.dependencies?.[name], undefined, name)
}
assert.equal(manifest.peerDependencies.typebox, '^1.3.27')
assert.equal(manifest.devDependencies.typebox, '^1.3.27')
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
const patternRules = [
  {
    files: /^src\/.+\.ts$/,
    exclude: /^src\/(?:vendor\/|engine-helpers\.ts$)/,
    pattern: /JSON\.parse\(JSON\.stringify\(/,
    message: 'use cloneJson from engine-helpers instead of ad-hoc JSON cloning'
  },
  {
    files: /^(?:src|test)\/.+\.ts$/,
    exclude: /^src\/vendor\//,
    pattern: /\bas\s+NodeJS\.ErrnoException\b/,
    message: 'use hasCode from guards instead of asserting NodeJS.ErrnoException'
  },
  {
    files: /^test\/.+\.(?:ts|mjs|js)$/,
    exclude: /^$/,
    pattern: /['"`]\.\.\/artifacts\//,
    message: 'write test artifacts under mkdtemp instead of the repository artifacts directory'
  }
]
const patternFiles = (
  await Promise.all(
    ['src', 'test'].map(async (dir) => {
      const entries = (await readdir(join(root, dir), { recursive: true })).filter((entry) =>
        /\.(?:ts|mjs|js)$/.test(entry)
      )
      return Promise.all(
        entries.map(async (entry) => ({
          file: `${dir}/${entry.replaceAll('\\', '/')}`,
          text: await readFile(join(root, dir, entry), 'utf8')
        }))
      )
    })
  )
).flat()
const failures = []
for (const { file, text } of patternFiles) {
  const lines = text.split('\n')
  for (const rule of patternRules) {
    if (!rule.files.test(file) || rule.exclude.test(file)) {
      continue
    }
    for (const [index, line] of lines.entries()) {
      if (rule.pattern.test(line)) {
        failures.push(`${file}:${index + 1}: ${rule.message}`)
      }
    }
  }
}
assert.equal(failures.length, 0, failures.join('\n'))
console.log(
  'Syntax, package manifest, declared resources, example JSON and source patterns passed.'
)
