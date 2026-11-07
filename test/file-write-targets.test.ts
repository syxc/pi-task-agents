import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { extractToolWritePaths } from '../src/vendor/mcode-adapters/file-write-targets.ts'

const sourcePath = 'packages/local-runtime/src/turns/file-changes.ts'
const fixture = new URL('./fixtures/file-observation/upstream-file-changes.ts.txt', import.meta.url)

test('target extraction retains pinned upstream helpers with narrow Pi path ports', async () => {
  const source = await readFile(fixture, 'utf8')
  const lock = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8'))
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    lock.watch.find((entry) => entry.source === sourcePath)?.sha256
  )
  const section = (start: string, end?: string) => {
    const first = source.indexOf(start),
      last = end ? source.indexOf(end, first) : source.length
    assert.ok(first >= 0 && last > first)
    return source.slice(first, last)
  }
  const expected =
    section('const STRUCTURED_WRITE_TOOLS', 'export interface BeginLocalTurnFileChangeResult') +
    section('type ExtractToolPathsResult', 'function safeCapturedPath').replace(
      'function extractToolWritePaths(',
      'export function extractToolWritePaths('
    ) +
    section('function hasDynamicShellPathToken')
  const implementation = await readFile(
    new URL('../src/vendor/mcode-adapters/file-write-targets.ts', import.meta.url),
    'utf8'
  )
  assert.equal(
    implementation.slice(implementation.indexOf('const STRUCTURED_WRITE_TOOLS')),
    expected
      .replace('let trimmed = filePath.trim();', 'let trimmed = filePath;')
      .replace(
        "token.startsWith('~')",
        "token.startsWith('~') || token.replaceAll(path.win32.sep, '/').split('/').includes('..')"
      )
  )
  assert.match(implementation, /const BRAND = \{ APP_DIR: '\.pi' \}/)
})

test('upstream targets cover native writers, shell redirections, dynamic paths and rename endpoints', () => {
  const root = resolve('/owned-workspace')
  assert.deepEqual(extractToolWritePaths(root, 'write', { path: 'owned.txt' }), {
    kind: 'paths',
    paths: ['owned.txt']
  })
  assert.deepEqual(extractToolWritePaths(root, 'edit', { path: resolve(root, 'owned.txt') }), {
    kind: 'paths',
    paths: ['owned.txt']
  })
  assert.deepEqual(extractToolWritePaths(root, 'bash', { command: 'printf evidence > out.txt' }), {
    kind: 'paths',
    paths: ['out.txt']
  })
  assert.deepEqual(extractToolWritePaths(root, 'bash', { command: 'printf evidence > "$DEST"' }), {
    kind: 'ambiguous',
    reason: 'shell_target_ambiguous'
  })
  assert.deepEqual(extractToolWritePaths(root, 'bash', { command: 'mv before.txt after.txt' }), {
    kind: 'paths',
    paths: ['after.txt', 'before.txt']
  })
  assert.deepEqual(
    extractToolWritePaths(root, 'bash', { command: "printf evidence > ' edge.txt '" }),
    { kind: 'paths', paths: [' edge.txt '] }
  )
  assert.deepEqual(
    extractToolWritePaths(root, 'bash', { command: 'printf evidence > alias/../owned.txt' }),
    { kind: 'ambiguous', reason: 'shell_target_ambiguous' }
  )
  assert.deepEqual(extractToolWritePaths(root, 'read', { path: 'owned.txt' }), { kind: 'ignore' })
})
