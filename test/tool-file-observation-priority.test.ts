import assert from 'node:assert/strict'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { answer, fixture, tool } from './pi-backend-test-helpers.ts'

const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, '0')}.txt`)

test('confirmed native targets survive more than 200 earlier concurrent workspace changes', async (t) => {
  const f = await fixture(t),
    target = 'z-owned.txt',
    unrelated = numbered('a-external-', 205)
  await writeFile(join(f.cwd, target), 'original')
  f.script(async (step) => {
    if (step === 1) {
      return tool('bash', { command: 'name=unused; :' })
    }
    if (step === 2) {
      return tool('write', { path: target, content: 'modified' })
    }
    await Promise.all([
      mkdir(join(f.cwd, 'a-directory')),
      ...unrelated.map((path) => writeFile(join(f.cwd, path), 'external actor'))
    ])
    return answer('done')
  })
  const child = await f.child({ tools: ['bash', 'write'] })
  const result = await child.prompt('Modify only the owned target.')
  assert.equal(await readFile(join(f.cwd, target), 'utf8'), 'modified')
  const report = result.verification
  assert.equal(report?.fileChange, 'uncertain')
  assert.ok(report.observationNotes.includes('changed_files_truncated'))
  assert.ok(report.observationNotes.some((note) => note.includes('not attributed to this child')))
  assert.equal(report.changedFiles?.length, 200)
  assert.ok(report.changedFiles.includes('a-directory'))
  assert.ok(
    report.changedFiles.includes(target),
    'confirmed target was displaced by workspace changes'
  )
  assert.deepEqual(report.changedFiles, ['a-directory', ...unrelated.slice(0, 198), target])
})

test('overlapping direct and workspace paths are deduplicated before filling remaining capacity', async (t) => {
  const f = await fixture(t),
    targets = ['a-owned.txt', 'z-owned.txt'],
    unrelated = numbered('b-external-', 199)
  f.script(async (step) => {
    if (step === 1) {
      return tool('bash', { command: 'name=unused; :' })
    }
    if (step <= targets.length + 1) {
      return tool('write', { path: targets[step - 2], content: 'owned evidence' })
    }
    await Promise.all(unrelated.map((path) => writeFile(join(f.cwd, path), 'external actor')))
    return answer('done')
  })
  const child = await f.child({ tools: ['bash', 'write'] })
  const result = await child.prompt('Write only the two owned targets.')
  const report = result.verification
  assert.equal(report?.fileChange, 'uncertain')
  assert.ok(report.observationNotes.includes('changed_files_truncated'))
  assert.equal(new Set(report.changedFiles).size, 200)
  assert.deepEqual(report.changedFiles, [targets[0], ...unrelated.slice(0, 198), targets[1]])
})

for (const workspace of [false, true]) {
  test(`more than 200 confirmed native targets ${workspace ? 'with' : 'without'} workspace changes are bounded in stable path order`, async (t) => {
    const f = await fixture(t),
      targets = numbered('z-owned-', 205)
    f.script(async (step) => {
      if (workspace && step === 1) {
        return tool('bash', { command: 'name=unused; :' })
      }
      if (step === (workspace ? 2 : 1)) {
        return answer('', {
          stopReason: 'toolUse',
          content: targets.toReversed().map((path, index) => ({
            type: 'toolCall',
            id: `owned-write-${index}`,
            name: 'write',
            arguments: { path, content: 'owned evidence' }
          }))
        })
      }
      await writeFile(join(f.cwd, 'a-external.txt'), 'external actor')
      return answer('done')
    })
    const child = await f.child({ tools: ['bash', 'write'] })
    const result = await child.prompt('Write only the owned targets.')
    assert.equal(await readFile(join(f.cwd, targets[204]), 'utf8'), 'owned evidence')
    const report = result.verification
    assert.equal(report?.fileChange, workspace ? 'uncertain' : 'change_observed')
    assert.ok(report.observationNotes.includes('changed_files_truncated'))
    assert.deepEqual(report.changedFiles, targets.slice(0, 200))
  })
}

test('workspace-only truncation remains visible with uncertain shell effects and directory changes', async (t) => {
  const f = await fixture(t),
    unrelated = numbered('external-', 205)
  f.script(async (step) => {
    if (step === 1) {
      return tool('bash', { command: 'name=unused; :' })
    }
    await Promise.all([
      mkdir(join(f.cwd, 'a-directory')),
      ...unrelated.map((path) => writeFile(join(f.cwd, path), 'external actor'))
    ])
    return answer('done')
  })
  const child = await f.child({ tools: ['bash'] })
  const result = await child.prompt('Run only the assigned no-write shell command.')
  const report = result.verification
  assert.equal(report?.fileChange, 'uncertain')
  assert.ok(report.observationNotes.includes('ambiguous_shell_control_flow'))
  assert.ok(report.observationNotes.includes('changed_files_truncated'))
  assert.deepEqual(report.changedFiles, ['a-directory', ...unrelated.slice(0, 199)])
})

for (const confirmed of [false, true]) {
  test(`workspace snapshot failure ${confirmed ? 'retains confirmed targets' : 'does not invent an empty confirmed list'}`, async (t) => {
    const f = await fixture(t),
      target = 'owned.txt'
    f.script(async (step) => {
      if (step === 1) {
        return tool('bash', { command: 'name=unused; :' })
      }
      if (confirmed && step === 2) {
        return tool('write', { path: target, content: 'owned evidence' })
      }
      await rename(f.cwd, join(f.root, 'moved-workspace'))
      return answer('done')
    })
    const child = await f.child({ tools: ['bash', 'write'] })
    const result = await child.prompt('Write only the assigned owned fixture, if requested.')
    const report = result.verification
    assert.equal(result.outcome?.status, 'succeeded')
    assert.equal(report?.fileChange, 'recording_failed')
    assert.ok(report.observationNotes.includes('workspace_recording_failed'))
    assert.ok(report.observationNotes.includes('observation_failed:ENOENT'))
    assert.deepEqual(report.changedFiles, confirmed ? [target] : undefined)
  })
}
