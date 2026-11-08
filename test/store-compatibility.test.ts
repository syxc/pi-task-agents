import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { TaskStore } from '../src/store.ts'
import { TaskEngine } from '../src/engine.ts'

const legacy = { agentSettled: true, stopReason: 'stop', toolErrors: 2 }
const report = {
  modelVerdict: 'fail',
  fileChange: 'recording_failed',
  observationNotes: ['Fixture observation unavailable']
}

async function fixture(
  t: TestContext,
  verification: unknown = legacy,
  extra: Record<string, unknown> = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'pi-task-store-compat-'))
  const store = new TaskStore(root, 'parent')
  const task = {
    task_id: 'legacy',
    session_id: 'child',
    parent_id: 'parent',
    childSessionPath: join(store.dir, 'child.jsonl'),
    profile: {
      name: 'worker',
      instructions: 'Work',
      tools: [],
      extensions: [],
      skills: [],
      mcp: false,
      timeoutMs: 0
    },
    input: { prompt: 'Preserve this input' },
    status: 'failed',
    description: 'Historical task',
    agent_name: 'worker',
    created_at: '2026-01-01T00:00:00Z',
    output: 'Historical output',
    final_text: 'Historical final text',
    cursor: 4,
    notification_pending: true,
    notify_completion: true,
    stopError: { code: 'CHILD_CLEANUP_FAILED', message: 'Unconfirmed cleanup' },
    verification,
    ...extra
  }
  const state = {
    version: 1,
    parentId: 'parent',
    tasks: [task, { ...task, task_id: 'current', verification: report }],
    requests: { 'dedup-receipt': 'legacy' },
    cleanupConfirmed: []
  }
  await mkdir(store.dir, { recursive: true })
  await writeFile(store.file, JSON.stringify(state))
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  return { store, state }
}

test('legacy execution verification loads without being treated as a review or losing historical facts', async (t) => {
  const { store, state } = await fixture(t)
  const originalBytes = await readFile(store.file, 'utf8')
  const loaded = await store.init()
  const expected = structuredClone(state) as typeof state & {
    tasks: { verification?: unknown; legacyVerification?: unknown }[]
  }
  expected.tasks[0].legacyVerification = expected.tasks[0].verification
  delete expected.tasks[0].verification
  assert.deepEqual(
    loaded,
    expected,
    'Only the known legacy field moves; permission, cleanup, receipt and output facts stay unchanged'
  )
  assert.equal(
    loaded.tasks[0].verification,
    undefined,
    'Runtime settlement facts are not a model verdict or clean-workspace claim'
  )
  assert.deepEqual(loaded.tasks[1].verification, report)
  assert.equal(
    await readFile(store.file, 'utf8'),
    originalBytes,
    'Reading does not rewrite the store'
  )
  await store.save(loaded)
  await store.close()
  const reopened = new TaskStore(store.rootDir, 'parent')
  try {
    assert.deepEqual(
      await reopened.init(),
      loaded,
      'Migration is stable after persistence and restart'
    )
  } finally {
    await reopened.close()
  }
})

test('normal owner initialization and history queries recover legacy records without starting children', async (t) => {
  const { store } = await fixture(t, legacy, { status: 'succeeded', stopError: undefined })
  let calls = 0
  const engine = new TaskEngine({
    rootDir: store.rootDir,
    parentId: 'parent',
    cwd: store.rootDir,
    createChild: async () => {
      calls++
      throw new Error('No model calls during recovery')
    }
  })
  try {
    await engine.init()
    const rows = await engine.query()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].status, 'succeeded')
    assert.equal(rows[0].verification, undefined)
    assert.equal('legacyVerification' in rows[0], false)
    assert.deepEqual(engine.task('legacy').legacyVerification, legacy)
    assert.equal(calls, 0)
  } finally {
    await engine.close()
  }
})

test('profile boundary rejects non-enum thinking and unsafe timeout values', async (t) => {
  const base = {
    name: 'worker',
    instructions: 'Work',
    tools: [],
    timeoutMs: 0
  }
  /* oxlint-disable no-await-in-loop -- Each invalid profile is an independent closed boundary case. */
  for (const [profile, label] of [
    [{ ...base, thinking: 'HIGH' }, 'uppercase thinking'],
    [{ ...base, thinking: 'turbo' }, 'unknown thinking'],
    [{ ...base, timeoutMs: Number.NaN }, 'NaN timeout'],
    [{ ...base, timeoutMs: -1 }, 'negative timeout'],
    [{ ...base, timeoutMs: Number.POSITIVE_INFINITY }, 'infinite timeout'],
    [{ ...base, timeoutMs: 2_147_483_648 }, 'overflow timeout']
  ] as const) {
    const { store } = await fixture(t, legacy, { profile })
    await assert.rejects(store.init(), /Invalid task store state/, label)
  }
  /* oxlint-enable no-await-in-loop */
})

test('unknown or ambiguous verification payloads still fail closed without changing stored bytes', async (t) => {
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const verification of [
    null,
    [],
    { agentSettled: true },
    { ...legacy, toolErrors: -1 },
    { ...legacy, agentSettled: 'true' },
    { ...legacy, modelVerdict: 'pass' },
    { ...report, extra: true }
  ]) {
    const { store } = await fixture(t, verification)
    const original = await readFile(store.file, 'utf8')
    await assert.rejects(store.init(), /Invalid task store state/)
    assert.equal(await readFile(store.file, 'utf8'), original)
  }
  /* oxlint-enable no-await-in-loop */
  const { store } = await fixture(t, legacy, { legacyVerification: { ...legacy, toolErrors: 0 } })
  await assert.rejects(
    store.init(),
    /Invalid task store state/,
    'Conflicting archives must not be overwritten'
  )
})
