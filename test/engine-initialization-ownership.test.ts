import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskEngine } from '../src/engine.ts'
import type { AgentProfile, CreateChild, ChildSession } from '../src/types.ts'

const profile: AgentProfile = {
  name: 'worker',
  instructions: 'Owned offline initialization.',
  tools: [],
  skills: [],
  extensions: [],
  mcp: false,
  timeoutMs: 0
}
const input = { description: 'ownership', prompt: 'offline', run_in_background: true }
async function until(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check()) {
    assert.ok(Date.now() < end, 'owned operation deadline')
    // oxlint-disable-next-line no-await-in-loop -- Bound this fixture's initialization handoff.
    await delay(5)
  }
}
async function fixture(t: TestContext) {
  const rootDir = await mkdtemp(join(tmpdir(), 'engine-init-ownership-'))
  let calls = 0,
    prompts = 0,
    disposals = 0,
    failCleanup = false
  const createChild: CreateChild = async ({ sessionPath, profile: actual }) => {
    calls++
    const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
    assert.equal(saved.tasks.at(-1).ownedCommandCleanupPending, true)
    assert.deepEqual(actual.tools, [])
    assert.deepEqual(actual.extensions, [])
    return {
      sessionPath,
      async prompt() {
        prompts++
        const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
        assert.equal(saved.tasks.at(-1).ownedCommandCleanupPending, undefined)
        return { text: 'offline evidence' }
      },
      async steer() {},
      async abort() {},
      async dispose() {
        disposals++
        if (failCleanup) {
          throw Object.assign(new Error('owned disposal failure'), { code: 'CHILD_CLEANUP_FAILED' })
        }
      }
    }
  }
  const options = { rootDir, parentId: 'owner', cwd: rootDir, createChild }
  const engine = await new TaskEngine(options).init()
  t.after(async () => {
    failCleanup = false
    await engine.close()
    await rm(rootDir, { recursive: true, force: true })
  })
  return {
    engine,
    options,
    createChild,
    counts: () => ({ calls, prompts, disposals }),
    failCleanup(value: boolean) {
      failCleanup = value
    }
  }
}

for (const committed of [false, true]) {
  test(`initialization ownership save failure (committed: ${committed}) never invokes the factory`, async (t) => {
    const f = await fixture(t),
      save = f.engine.store.save.bind(f.engine.store)
    const fault = new Error('initialization ownership save failed')
    let fail = true
    f.engine.store.save = async (state) => {
      if (fail && state.tasks.some((row) => row.ownedCommandCleanupPending)) {
        fail = false
        if (committed) {
          await save(state)
        }
        throw fault
      }
      await save(state)
    }
    const task = await f.engine.start(input, profile)
    await until(() => f.engine.runtimes.size === 0)
    assert.deepEqual(f.counts(), { calls: 0, prompts: 0, disposals: 0 })
    await assert.rejects(f.engine.start(input, profile), (error) => error === fault)
    const disk = JSON.parse(await readFile(f.engine.store.file, 'utf8'))
    assert.equal(disk.tasks[0].status, 'failed')
    assert.equal(disk.tasks[0].error, fault.message)
    assert.equal(disk.tasks[0].ownedCommandCleanupPending, undefined)
    assert.equal(disk.cleanupConfirmed, undefined)
    await f.engine.close()
    const restored = await new TaskEngine(f.options).init()
    try {
      assert.equal((await restored.query({ task_id: task.task_id })).cleanup_pending, undefined)
    } finally {
      await restored.close()
    }
  })
}

test('normal initialization clears its durable lease before prompting and permits close/restart continuation', async (t) => {
  const f = await fixture(t)
  const first = await f.engine.start({ ...input, run_in_background: false }, profile)
  assert.equal(first.status, 'succeeded')
  assert.equal('ownedCommandCleanupPending' in first, false)
  assert.equal(first.cleanup_pending, undefined)
  await f.engine.close()
  assert.equal((await readdir(join(f.engine.store.dir, 'owners'))).length, 0)
  const restored = await new TaskEngine(f.options).init()
  try {
    assert.equal((await restored.output(first.task_id, { offset: 0 })).output, 'offline evidence')
    const continued = await restored.append(first.task_id, 'offline continuation')
    await until(() => restored.runtimes.size === 0)
    assert.equal((await restored.query({ task_id: continued.task_id })).status, 'succeeded')
    assert.equal(continued.session_id, first.session_id)
    assert.deepEqual(f.counts(), { calls: 2, prompts: 2, disposals: 1 })
  } finally {
    await restored.close()
  }
})

test('a factory clean rejection clears initialization ownership without inventing a cleanup receipt', async (t) => {
  const f = await fixture(t)
  const failure = new Error('factory rejected after cleaning its resources')
  f.engine.createChild = async () => {
    const disk = JSON.parse(await readFile(f.engine.store.file, 'utf8'))
    assert.equal(disk.tasks[0].ownedCommandCleanupPending, true)
    throw failure
  }
  const result = await f.engine.start({ ...input, run_in_background: false }, profile)
  assert.equal(result.status, 'failed')
  assert.equal(result.error, failure.message)
  assert.equal(result.cleanup_pending, undefined)
  const disk = JSON.parse(await readFile(f.engine.store.file, 'utf8'))
  assert.equal(disk.tasks[0].ownedCommandCleanupPending, undefined)
  assert.equal(disk.cleanupConfirmed, undefined)
})

for (const committed of [false, true]) {
  test(`initialization handoff save failure (committed: ${committed}) retains its storage fault and lock`, async (t) => {
    const f = await fixture(t),
      save = f.engine.store.save.bind(f.engine.store)
    const fault = new Error('handoff save failed')
    let armed = false,
      poisoned = false
    f.engine.store.save = async (state) => {
      const row = state.tasks[0]
      if (row?.ownedCommandCleanupPending) {
        armed = true
      }
      if (poisoned) {
        throw fault
      }
      if (armed && row?.status === 'running' && !row.ownedCommandCleanupPending) {
        poisoned = true
        if (committed) {
          await save(state)
        }
        throw fault
      }
      await save(state)
    }
    try {
      await f.engine.start(input, profile)
      await until(() => f.engine.runtimes.size === 0)
      assert.equal(f.counts().calls, 1)
      assert.equal(f.counts().prompts, 0)
      await assert.rejects(f.engine.close(), (error) => error === fault)
      await assert.rejects(new TaskEngine(f.options).init(), /active task owner/)
      assert.equal(
        f.counts().disposals,
        0,
        'terminal persistence must succeed before close releases its child'
      )
    } finally {
      f.engine.store.save = save
    }
    await f.engine.close()
    assert.equal(f.counts().disposals, 1)
    const disk = JSON.parse(await readFile(f.engine.store.file, 'utf8'))
    assert.equal(disk.tasks[0].ownedCommandCleanupPending, undefined)
    assert.equal(disk.tasks[0].error, fault.message)
    assert.equal((await readdir(join(f.engine.store.dir, 'owners'))).length, 0)
  })
}

test('an initialization cleanup failure survives a late real disposal and a failed receipt write', async (t) => {
  const f = await fixture(t),
    save = f.engine.store.save.bind(f.engine.store)
  const failure = Object.assign(new Error('specific initialization cleanup failure'), {
    code: 'CHILD_CLEANUP_FAILED'
  })
  let owned: ChildSession | undefined
  f.failCleanup(true)
  f.engine.createChild = async (args) => {
    owned = await f.createChild(args)
    throw Object.assign(failure, { cleanupChild: owned })
  }
  const result = await f.engine.start({ ...input, run_in_background: false }, profile)
  assert.equal(result.stopError?.message, failure.message)
  assert.equal(result.cleanup_pending, true)
  await assert.rejects(f.engine.close(), { code: 'CHILD_CLEANUP_FAILED' })
  const receiptFailure = new Error('confirmed cleanup receipt save failed')
  f.failCleanup(false)
  f.engine.store.save = async (state) => {
    if (!state.tasks[0].ownedCommandCleanupPending) {
      throw receiptFailure
    }
    await save(state)
  }
  try {
    await assert.rejects(f.engine.close(), (error) => error === receiptFailure)
    assert.equal(f.counts().disposals, 2)
    await assert.rejects(new TaskEngine(f.options).init(), /active task owner/)
    const disk = JSON.parse(await readFile(f.engine.store.file, 'utf8'))
    assert.equal(disk.tasks[0].ownedCommandCleanupPending, true)
    assert.equal(disk.tasks[0].stopError.message, 'owned disposal failure')
    assert.equal(disk.cleanupConfirmed, undefined)
  } finally {
    f.engine.store.save = save
  }
  await f.engine.close()
  const disk = JSON.parse(await readFile(f.engine.store.file, 'utf8'))
  assert.equal(disk.tasks[0].ownedCommandCleanupPending, undefined)
  assert.deepEqual(disk.cleanupConfirmed, [result.task_id])
  const restored = await new TaskEngine(f.options).init()
  try {
    const old = await restored.query({ task_id: result.task_id })
    assert.equal(old.cleanup_pending, undefined)
    assert.equal(old.stopError?.message, 'owned disposal failure')
  } finally {
    await restored.close()
  }
})
