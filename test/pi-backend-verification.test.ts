import assert from 'node:assert/strict'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { TaskEngine } from '../src/engine.ts'
import { taskResult } from '../src/tool-result-task.ts'
import { OutputProjector, outputWait, queryResult } from '../src/tool-result-control.ts'
import { until } from './bounded.ts'
import { answer, fixture, profile, tool } from './pi-backend-test-helpers.ts'
import type { ChildFailure, VerificationReport } from '../src/types.ts'

test('real verifier results reach persistence and every result surface without redefining task success', async (t) => {
  const f = await fixture(t)
  f.script((step) => {
    if (step === 1) {
      return tool('bash', { command: "printf 'owned changed bytes' > owned.txt" })
    }
    return answer('Observed defect.\nVERDICT: FAIL')
  })
  const engine = await new TaskEngine({
    rootDir: join(f.root, 'tasks'),
    parentId: 'verification',
    cwd: f.cwd,
    createChild: f.create
  }).init()
  t.after(() => engine.close())
  const result = await engine.start(
    {
      agent_name: 'verifier',
      description: 'Owned verifier fixture',
      prompt: 'Inspect the fixture'
    },
    { ...profile, name: 'verifier', tools: ['bash'] }
  )
  assert.equal(result.status, 'succeeded')
  assert.equal(result.verification?.modelVerdict, 'fail')
  assert.equal(result.verification?.fileChange, 'change_observed')
  assert.deepEqual(result.verification?.changedFiles, ['owned.txt'])
  assert.equal(await readFile(join(f.cwd, 'owned.txt'), 'utf8'), 'owned changed bytes')
  const foreground = taskResult(result, { agent_name: 'verifier' })
  assert.equal(
    (foreground.details as { verification: VerificationReport }).verification.modelVerdict,
    'fail'
  )
  assert.match(foreground.text, /model_verdict: fail/)
  assert.equal(foreground.isError, undefined)
  const query = queryResult(await engine.query({ task_id: result.task_id }))
  assert.deepEqual(
    (query.details as { task: { verification?: unknown } }).task.verification,
    result.verification
  )
  const output = await engine.output(result.task_id, { offset: 0 })
  assert.deepEqual(
    new OutputProjector().result(output, outputWait(), 'verification').details.verification,
    result.verification
  )
  const disk = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.deepEqual(disk.tasks[0].verification, result.verification)
  await engine.close()
  const reopened = await new TaskEngine({
    rootDir: join(f.root, 'tasks'),
    parentId: 'verification',
    cwd: f.cwd,
    createChild: async () => {
      throw new Error('History reads must not replay model calls')
    }
  }).init()
  t.after(() => reopened.close())
  assert.deepEqual(
    (await reopened.query({ task_id: result.task_id })).verification,
    result.verification
  )
})

test('background task plus native foreground Bash supports long work and owned cancellation', async (t) => {
  const f = await fixture(t),
    marker = join(f.cwd, 'ready.pid'),
    script = join(f.cwd, 'long-run.mjs')
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetTimeout(() => process.exit(0), 10000);\n`
  )
  f.script((step) =>
    step === 1
      ? tool('bash', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` })
      : answer('done')
  )
  const engine = await new TaskEngine({
    rootDir: join(f.root, 'tasks'),
    parentId: 'long-work',
    cwd: f.cwd,
    createChild: f.create
  }).init()
  try {
    const task = await engine.start(
      {
        agent_name: 'worker',
        description: 'Owned long command',
        prompt: 'Run the fixture',
        run_in_background: true
      },
      { ...profile, tools: ['bash'] }
    )
    const pid = await until(async () => {
      try {
        const value = Number(await readFile(marker, 'utf8'))
        return Number.isSafeInteger(value) && value > 0 ? value : undefined
      } catch {
        return undefined
      }
    }, 'Fresh owned process must become ready')
    process.kill(pid, 0)
    const running = await engine.query({ task_id: task.task_id })
    assert.equal(running.status, 'running')
    assert.equal(running.activity, 'bash: running')
    assert.equal(
      (await engine.output(task.task_id, { offset: 0 })).output,
      '',
      'Activity is not persisted task output'
    )
    assert.equal(
      JSON.stringify(JSON.parse(await readFile(engine.store.file, 'utf8'))).includes(
        'bash: running'
      ),
      false
    )
    assert.equal((await engine.stop(task.task_id)).status, 'canceled')
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ESRCH') {
          return true
        }
        throw error
      }
    }, 'Stopping the task must stop its still-running native Bash process')
    assert.equal((await engine.query({ task_id: task.task_id })).activity, undefined)
  } finally {
    await engine.close()
  }
})

test('incompatible SDK fails clearly before session creation or model dispatch', async (t) => {
  const f = await fixture(t, { sdk: { createAgentSession: undefined } })
  let calls = 0
  f.script(() => {
    calls++
    return answer()
  })
  await assert.rejects(
    f.child(),
    /Pi SDK is missing required child-session APIs: createAgentSession/
  )
  assert.equal(calls, 0)
})

test('observation failure is reported without inventing clean workspace facts or failing the model run', async (t) => {
  const f = await fixture(t)
  const child = await f.child({ name: 'verifier' })
  await rename(f.cwd, join(f.root, 'moved-workspace'))
  f.script(() => answer('VERDICT: PASS'))
  const result = await child.prompt('Review without workspace access')
  assert.equal(result.outcome?.kind, 'returned')
  assert.equal(result.verification?.modelVerdict, 'pass')
  assert.equal(result.verification?.fileChange, 'recording_failed')
  assert.equal(result.verification?.changedFiles, undefined)
})

test('per-turn verdicts do not leak into continuation, aborted or failed responses', async (t) => {
  const f = await fixture(t)
  f.script(() => answer('VERDICT: PASS'))
  const child = await f.child({ name: 'verifier' })
  assert.equal((await child.prompt('First review')).verification?.modelVerdict, 'pass')
  f.script(() => answer('VERDICT: PASS\nVERDICT: FAIL'))
  assert.equal((await child.prompt('Conflicting review')).verification?.modelVerdict, undefined)
  f.script(() => answer('VERDICT: PASS', { stopReason: 'error', errorMessage: 'SCRIPTED_FAILURE' }))
  f.script(() => answer('VERDICT: PASS', { stopReason: 'aborted' }))
  await assert.rejects(child.prompt('Aborted review'), (error: ChildFailure) => {
    assert.equal(error.partialResult?.verification?.modelVerdict, undefined)
    return true
  })
  f.script(() => answer('VERDICT: PASS', { stopReason: 'error', errorMessage: 'SCRIPTED_FAILURE' }))
  await assert.rejects(child.prompt('Failed review'), (error: ChildFailure) => {
    assert.equal(error.partialResult?.verification?.modelVerdict, undefined)
    assert.equal(error.partialResult?.verification?.fileChange, 'no_observed_change')
    return true
  })
})
