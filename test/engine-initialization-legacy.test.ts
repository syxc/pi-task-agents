import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TaskEngine } from '../src/engine.ts'
import { SessionSafety } from '../src/engine-session-safety.ts'
import type { TaskRecord, TaskState, AgentProfile } from '../src/types.ts'

const profile: AgentProfile = {
  name: 'worker',
  instructions: 'Owned offline legacy snapshot.',
  tools: [],
  skills: [],
  extensions: [],
  mcp: false,
  timeoutMs: 0
}
function record(): TaskRecord {
  return {
    task_id: randomUUID(),
    session_id: randomUUID(),
    parent_id: 'owner',
    childSessionPath: '/unused/owned.jsonl',
    profile,
    input: { prompt: 'offline' },
    status: 'running',
    description: 'historical task',
    agent_name: 'worker',
    created_at: new Date().toISOString(),
    output: 'saved historical result',
    cursor: 0,
    notification_pending: false,
    notify_completion: false
  }
}

for (const status of ['running', 'stopping', 'lost'] as const) {
  test(`unmarked historical ${status} snapshots retain their existing recovery contract`, async (t) => {
    const rootDir = await mkdtemp(join(tmpdir(), 'engine-init-legacy-'))
    t.after(() => rm(rootDir, { recursive: true, force: true }))
    const row = { ...record(), status },
      state: TaskState = { version: 1, parentId: 'owner', tasks: [row], requests: {} }
    let calls = 0
    const engine = new TaskEngine({
      rootDir,
      parentId: 'owner',
      cwd: rootDir,
      createChild: async ({ sessionPath, profile: actual }) => {
        calls++
        assert.deepEqual(actual.tools, [])
        assert.deepEqual(actual.extensions, [])
        return {
          sessionPath,
          prompt: async () => ({ text: 'explicit continuation' }),
          steer: async () => {},
          abort: async () => {},
          dispose: async () => {}
        }
      }
    })
    row.childSessionPath = join(engine.store.dir, 'owned.jsonl')
    await mkdir(engine.store.dir, { recursive: true })
    await writeFile(engine.store.file, JSON.stringify(state))
    await engine.init()
    try {
      const recovered = await engine.query({ task_id: row.task_id })
      assert.equal(recovered.status, 'lost')
      assert.equal(recovered.cleanup_pending, undefined)
      assert.equal((await engine.output(row.task_id, { offset: 0 })).output, row.output)
      assert.equal(calls, 0, 'absence of an old marker cannot reconstruct historical effects')
      const next = await engine.send(row.session_id, 'explicit continuation')
      assert.equal(next.status, 'succeeded')
      assert.equal(calls, 1)
    } finally {
      await engine.close()
    }
  })
}

test('a new pending lease invalidates an old receipt and cannot be certified by a replacement child', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'engine-init-receipt-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  const row = record()
  row.ownedCommandCleanupPending = true
  row.stopError = { code: 'CHILD_CLEANUP_FAILED', message: 'old cleanup failure' }
  const state = {
    version: 1,
    parentId: 'owner',
    tasks: [row],
    requests: {},
    cleanupConfirmed: [row.task_id]
  }
  const engine = new TaskEngine({
    rootDir,
    parentId: 'owner',
    cwd: rootDir,
    createChild: async () => {
      throw new Error('An orphan must not recreate a child')
    }
  })
  row.childSessionPath = join(engine.store.dir, 'owned.jsonl')
  await mkdir(engine.store.dir, { recursive: true })
  await writeFile(engine.store.file, JSON.stringify(state))
  await engine.init()
  try {
    assert.equal((await engine.query({ task_id: row.task_id })).cleanup_pending, true)
    const restored = JSON.parse(await readFile(engine.store.file, 'utf8'))
    assert.deepEqual(restored.cleanupConfirmed, [])
    const safety = new SessionSafety()
    safety.restore(restored)
    assert.equal(safety.confirmDisposed(new Set([row.session_id]), restored.tasks), false)
    assert.equal(restored.tasks[0].ownedCommandCleanupPending, true)
    assert.deepEqual(restored.cleanupConfirmed, [])
    assert.throws(() => safety.assertDispatch(), { code: 'CHILD_CLEANUP_FAILED' })
    await assert.rejects(engine.close(), { code: 'CHILD_CLEANUP_FAILED' })
  } finally {
    // Only release this observer fixture's lock, not its persisted orphan quarantine.
    await engine.store.close()
  }
})
