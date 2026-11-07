import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import {
  parseModelVerdict,
  buildVerification,
  isVerificationReport
} from '../src/task-verification.ts'
import { captureWorkspace } from '../src/workspace-observation.ts'

const snapshot = (entries: [string, string][] = []) => ({ entries: new Map(entries) })

test('verdict parsing preserves MCode decoration, duplicate and malformed-candidate semantics', () => {
  for (const [text, verdict] of [
    ['VERDICT: PASS', 'pass'],
    ['> **VERDICT:** FAIL', 'fail'],
    ['### VERDICT\n\n**PARTIAL**', 'partial'],
    ['VERDICT: PASS\nVERDICT: PASS', 'pass'],
    ['VERDICT: PASS\n  VERDICT: unknown', undefined],
    ['VERDICT: PASS\nVERDICT: FAIL', undefined],
    ['VERDICT: PASS / FAIL', undefined],
    ['VERDICT: PASSING', undefined],
    ['VERDICT:', undefined],
    ['No verdict given', undefined]
  ] as const) {
    assert.equal(parseModelVerdict(text), verdict, text)
  }
})

test('adapted verdict parser matches the pinned upstream parser', async () => {
  const source = await readFile(
    new URL('./fixtures/task-verification/upstream.ts.txt', import.meta.url),
    'utf8'
  )
  const lock = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8'))
  const watched = lock.watch.find(
    (entry) => entry.source === 'packages/agent-tools/src/desktop/task-verification.ts'
  )
  assert.equal(createHash('sha256').update(source).digest('hex'), watched.sha256)
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }
  }).outputText
  const oracle = await import(
    'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
  )
  for (const decoration of ['', '> ', '- ', '### ', '**']) {
    for (const value of ['PASS', 'FAIL', 'PARTIAL', 'unknown', 'PASS / FAIL', 'PASSING']) {
      const line = `${decoration}VERDICT: ${value}`
      for (const candidate of [
        line,
        `${line}\nVERDICT: PASS`,
        `${line}\n  VERDICT: unknown`,
        `VERDICT\n\n${value}`
      ]) {
        assert.equal(parseModelVerdict(candidate), oracle.parseModelVerdict(candidate), candidate)
      }
    }
  }
})

test('execution status, model verdict and observed changes remain separate facts', () => {
  const changed = buildVerification(
    snapshot([['source.ts', 'before']]),
    snapshot([['source.ts', 'after']]),
    'VERDICT: FAIL',
    true
  )
  assert.equal(changed.modelVerdict, 'fail')
  assert.equal(changed.fileChange, 'change_observed')
  assert.deepEqual(changed.changedFiles, ['source.ts'])
  assert.ok(isVerificationReport(changed))
  assert.equal(
    buildVerification(snapshot(), snapshot(), 'VERDICT: PASS', false).modelVerdict,
    undefined
  )
  const incomplete = buildVerification(
    snapshot(),
    { ...snapshot(), error: 'observation_entry_limit' },
    'VERDICT: PASS',
    true
  )
  assert.equal(incomplete.modelVerdict, 'pass')
  assert.equal(incomplete.fileChange, 'recording_failed')
  assert.equal(incomplete.changedFiles, undefined)
  assert.ok(incomplete.observationNotes.includes('observation_entry_limit'))
  assert.equal(
    buildVerification(snapshot(), snapshot(), 'VERDICT: PASS\nVERDICT: FAIL', true).modelVerdict,
    undefined
  )
  assert.equal(isVerificationReport({ ...changed, secret: 'not accepted' }), false)
  assert.equal(isVerificationReport({ ...changed, observationNotes: [42] }), false)
})

test('workspace observations detect metadata changes, exclude state/dependencies and do not follow symlinks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-observation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace'),
    state = join(cwd, 'state'),
    outside = join(root, 'outside')
  await Promise.all([
    mkdir(state, { recursive: true }),
    mkdir(outside),
    mkdir(join(cwd, 'node_modules'), { recursive: true }),
    mkdir(join(cwd, '.git'), { recursive: true })
  ])
  await writeFile(join(cwd, 'source.ts'), 'before')
  await writeFile(join(outside, 'private.txt'), 'not in the observation scope')
  await symlink(outside, join(cwd, 'alias'))
  const before = await captureWorkspace(cwd, [state])
  assert.equal(before.error, undefined)
  assert.equal(
    [...before.entries.keys()].some((path) => path.includes('private.txt')),
    false
  )
  await writeFile(join(state, 'session.jsonl'), 'state only')
  await writeFile(join(cwd, 'node_modules', 'generated'), 'dependency only')
  await writeFile(join(cwd, '.git', 'index'), 'git state only')
  await writeFile(join(outside, 'private.txt'), 'outside change')
  const ignored = buildVerification(before, await captureWorkspace(cwd, [state]), '', true)
  assert.equal(ignored.fileChange, 'no_observed_change')
  await writeFile(join(cwd, 'source.ts'), 'after')
  await writeFile(join(cwd, 'added.ts'), 'added')
  const changed = buildVerification(before, await captureWorkspace(cwd, [state]), '', true)
  assert.equal(changed.fileChange, 'change_observed')
  assert.deepEqual(changed.changedFiles, ['added.ts', 'source.ts'])
  assert.equal(
    (await captureWorkspace(cwd, [state], undefined, 0)).error,
    'observation_entry_limit'
  )
  assert.equal(
    (await captureWorkspace(join(root, 'missing'), [state])).error,
    'observation_failed:ENOENT'
  )
  assert.equal((await captureWorkspace(cwd, [cwd])).error, 'workspace_overlaps_agent_state')
  const cancel = new AbortController()
  cancel.abort()
  assert.equal((await captureWorkspace(cwd, [state], cancel.signal)).error, 'observation_aborted')
})

test('role prompts retain deliverable gates, temporary-artifact rules and verdict output', async () => {
  /* oxlint-disable no-await-in-loop -- Keep fixture reads and their assertions in deterministic case order. */
  for (const name of ['explore', 'verifier']) {
    const prompt = await readFile(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8')
    assert.match(prompt, /ROLE_MISMATCH/)
    assert.match(prompt, /worker/)
    if (name === 'verifier') {
      assert.match(prompt, /explicitly designated\s+temporary directory/)
      assert.match(prompt, /VERDICT: PASS/)
      assert.match(prompt, /VERDICT: FAIL/)
      assert.match(prompt, /VERDICT: PARTIAL/)
    }
  }
  /* oxlint-enable no-await-in-loop */
})
