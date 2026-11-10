import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true })
// Use npm pack: it preserves package.json as checked in, while pnpm rewrites the packed manifest.
const packed = spawnSync(
  'npm',
  ['pack', '--ignore-scripts', '--json', '--pack-destination', 'artifacts'],
  { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }
)
if (packed.error) {
  throw packed.error
}
if (packed.status !== 0) {
  process.stderr.write(packed.stderr ?? '')
  process.exitCode = packed.status ?? 1
} else {
  const [archive] = JSON.parse(packed.stdout)
  const file = join(root, 'artifacts', archive.filename)
  const dir = await mkdtemp(join(tmpdir(), 'pi-task-agents-pack-'))
  try {
    const extracted = spawnSync('tar', ['-xzf', file, '-C', dir], { encoding: 'utf8' })
    if (extracted.error) {
      throw extracted.error
    }
    if (extracted.status !== 0) {
      throw new Error(`tar failed to extract ${archive.filename}: ${extracted.stderr}`)
    }
    const manifest = JSON.parse(await readFile(join(dir, 'package/package.json'), 'utf8'))
    const entries = new Set([manifest.exports?.['.'], ...(manifest.pi?.extensions ?? [])])
    for (const entry of entries) {
      if (typeof entry !== 'string') {
        throw new TypeError('Packed manifest has no string entry point')
      }
      // oxlint-disable-next-line no-await-in-loop -- Fail on the first missing entry point.
      await stat(join(dir, 'package', entry))
    }
    console.log(`packed ${archive.filename}: ${entries.size} entry point(s) survived extraction`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
