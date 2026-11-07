import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskEngine } from '../src/engine.ts'
import type { AgentProfile, ChildSession, CreateChildOptions } from '../src/types.ts'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

const profile: AgentProfile = {
  name: 'worker',
  instructions: 'Offline initialization test',
  tools: [],
  skills: [],
  extensions: [],
  mcp: false,
  timeoutMs: 0
}
const input = {
  description: 'Initialization ownership',
  prompt: 'offline',
  run_in_background: true
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation exceeded test bound')), 2500)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(predicate: () => boolean) {
  const end = Date.now() + 2500
  while (!predicate()) {
    assert.ok(Date.now() < end, 'condition exceeded test bound')
    // oxlint-disable-next-line no-await-in-loop -- Poll the owned transition with a fixed deadline.
    await delay(5)
  }
}

async function fixture(t: TestContext) {
  const rootDir = await mkdtemp(join(tmpdir(), 'engine-initialization-'))
  const entered = deferred(),
    release = deferred(),
    disposing = deferred(),
    cleanup = deferred()
  let args!: CreateChildOptions
  let calls = 0,
    prompts = 0,
    aborts = 0,
    disposes = 0
  let failure: unknown
  let cleanupFailure = false
  let cleanupWait = cleanup.promise
  const child: ChildSession = {
    get sessionPath() {
      return args.sessionPath
    },
    async prompt() {
      prompts++
      return { text: 'normal' }
    },
    async steer() {},
    async abort() {
      aborts++
    },
    async dispose() {
      disposes++
      disposing.resolve()
      if (cleanupFailure) {
        throw Object.assign(new Error('late cleanup failed'), { code: 'CHILD_CLEANUP_FAILED' })
      }
      await cleanupWait
    }
  }
  const createChild = async (options: CreateChildOptions) => {
    calls++
    args = options
    entered.resolve()
    await release.promise
    if (failure) {
      throw failure
    }
    return child
  }
  const engine = await new TaskEngine({
    rootDir,
    parentId: 'parent',
    cwd: rootDir,
    maxConcurrency: 1,
    createChild
  }).init()
  t.after(async () => {
    release.resolve()
    cleanup.resolve()
    cleanupFailure = false
    try {
      await bounded(Promise.all([...engine.runtimes.values()].map((runtime) => runtime.done)))
      await bounded(engine.close())
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
  return {
    engine,
    entered,
    release,
    disposing,
    cleanup,
    child,
    args: () => args,
    counts: () => ({ calls, prompts, aborts, disposes }),
    fail(error: unknown) {
      failure = error
    },
    cleanupFails(value: boolean) {
      cleanupFailure = value
    },
    holdCleanup(promise: Promise<void>) {
      cleanupWait = promise
    },
    async assertLocked() {
      const other = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
      await assert.rejects(other.init(), /active task owner/)
    },
    async assertReleased() {
      const other = await new TaskEngine({
        rootDir,
        parentId: 'parent',
        cwd: rootDir,
        createChild
      }).init()
      await other.close()
    }
  }
}

test('initialization timeout retains the factory, capacity and lock until late disposal is confirmed', async (t) => {
  const f = await fixture(t)
  // Real running-row fsync is also inside the timeout. Allow startup I/O before holding the factory.
  const a = await f.engine.start(input, { ...profile, timeoutMs: 1000 })
  await bounded(f.entered.promise)
  const queued = await f.engine.start(input, profile)
  const runtime = f.engine.runtimes.get(a.task_id)!
  await until(() => f.engine.task(a.task_id).status === 'failed')
  const timed = await f.engine.query({ task_id: a.task_id })
  assert.equal(timed.cancel_reason, 'Task timed out')
  assert.equal(timed.cleanup_pending, true)
  assert.equal(timed.stopError?.code, 'CHILD_CLEANUP_FAILED')
  assert.equal(f.args().signal?.aborted, true)
  assert.equal(f.engine.runtimes.get(a.task_id), runtime)
  assert.equal(f.engine.task(queued.task_id).status, 'queued')
  assert.equal(f.counts().calls, 1)
  await f.assertLocked()
  await assert.rejects(f.engine.start(input, profile), { code: 'CHILD_CLEANUP_FAILED' })
  assert.deepEqual(await bounded(f.engine.stop(a.task_id)), timed)
  assert.deepEqual(await bounded(f.engine.stop(a.task_id)), timed)
  const saved = JSON.parse(await readFile(f.engine.store.file, 'utf8'))
  assert.equal(
    saved.tasks.find((task: { task_id: string }) => task.task_id === a.task_id).stopError.code,
    'CHILD_CLEANUP_FAILED'
  )
  await assert.rejects(bounded(f.engine.close()), { code: 'CHILD_CLEANUP_FAILED' })
  f.release.resolve()
  await f.disposing.promise
  assert.equal(f.engine.runtimes.size, 1)
  assert.equal(f.counts().prompts, 0)
  await assert.rejects(bounded(f.engine.close()), { code: 'CHILD_CLEANUP_FAILED' })
  await f.assertLocked()
  f.cleanup.resolve()
  await bounded(runtime.done!)
  assert.equal(f.engine.runtimes.size, 0)
  assert.deepEqual(f.counts(), { calls: 1, prompts: 0, aborts: 1, disposes: 1 })
  await f.engine.close()
  await f.assertReleased()
})

test('manual initialization stop is bounded and concurrent stops keep the original reason', async (t) => {
  const f = await fixture(t)
  const a = await f.engine.start(input, profile)
  await f.entered.promise
  const runtime = f.engine.runtimes.get(a.task_id)!
  const [first, second] = await bounded(
    Promise.all([
      f.engine.stop(a.task_id, 'first reason'),
      f.engine.stop(a.task_id, 'second reason')
    ])
  )
  for (const stopped of [first, second]) {
    assert.equal(stopped.status, 'canceled')
    assert.equal(stopped.cancel_reason, 'first reason')
    assert.equal(stopped.stopError?.code, 'TASK_STOP_FAILED')
    assert.equal(stopped.cleanup_pending, true)
  }
  assert.equal(f.engine.runtimes.size, 1)
  assert.equal(f.args().signal?.aborted, true)
  f.cleanup.resolve()
  f.release.resolve()
  await bounded(runtime.done!)
  assert.equal(f.counts().prompts, 0)
  assert.equal(f.engine.runtimes.size, 0)
})

test('close rejects with unconfirmed cleanup, retains its lock and drains a late child without prompting', async (t) => {
  const f = await fixture(t)
  const a = await f.engine.start(input, profile)
  await f.entered.promise
  const queued = await f.engine.start(input, profile)
  const runtime = f.engine.runtimes.get(a.task_id)!
  await bounded(
    Promise.all([
      assert.rejects(f.engine.close(), { code: 'CHILD_CLEANUP_FAILED' }),
      assert.rejects(f.engine.close(), { code: 'CHILD_CLEANUP_FAILED' })
    ])
  )
  assert.equal(f.engine.task(queued.task_id).status, 'canceled')
  assert.equal((await f.engine.query({ task_id: a.task_id })).cleanup_pending, true)
  await f.assertLocked()
  f.cleanup.resolve()
  f.release.resolve()
  await bounded(runtime.done!)
  assert.deepEqual(f.counts(), { calls: 1, prompts: 0, aborts: 1, disposes: 1 })
  await bounded(f.engine.close())
  await f.assertReleased()
})

for (const cleanupChild of [false, true]) {
  test(`late initialization rejection remains owned (cleanup child: ${cleanupChild})`, async (t) => {
    const f = await fixture(t)
    const a = await f.engine.start(input, profile)
    await f.entered.promise
    const runtime = f.engine.runtimes.get(a.task_id)!
    const stopped = await bounded(f.engine.stop(a.task_id))
    assert.equal(stopped.cleanup_pending, true)
    f.fail(
      cleanupChild
        ? Object.assign(new Error('factory and cleanup failed'), {
            code: 'CHILD_CLEANUP_FAILED',
            cleanupChild: f.child
          })
        : new Error('factory rejected after cleaning its resources')
    )
    f.cleanup.resolve()
    f.cleanupFails(cleanupChild)
    f.release.resolve()
    await bounded(runtime.done!)
    assert.equal(f.counts().prompts, 0)
    assert.equal(f.engine.runtimes.size, cleanupChild ? 1 : 0)
    if (cleanupChild) {
      assert.equal((await f.engine.query({ task_id: a.task_id })).cleanup_pending, true)
      await assert.rejects(f.engine.close(), { code: 'CHILD_CLEANUP_FAILED' })
      await f.assertLocked()
      f.cleanupFails(false)
    }
    await f.engine.close()
    await f.assertReleased()
  })
}

test('a hanging initialization cleanup retry remains owned across bounded close retries', async (t) => {
  const f = await fixture(t),
    retry = deferred()
  try {
    const task = await f.engine.start(input, profile)
    await f.entered.promise
    const runtime = f.engine.runtimes.get(task.task_id)!
    await bounded(f.engine.stop(task.task_id))
    f.fail(
      Object.assign(new Error('factory cleanup failed'), {
        code: 'CHILD_CLEANUP_FAILED',
        cleanupChild: f.child
      })
    )
    f.cleanupFails(true)
    f.release.resolve()
    await bounded(runtime.done!)
    f.cleanupFails(false)
    f.holdCleanup(retry.promise)
    await assert.rejects(bounded(f.engine.close()), { code: 'CHILD_CLEANUP_FAILED' })
    assert.equal(f.counts().disposes, 2)
    await assert.rejects(bounded(f.engine.close()), { code: 'CHILD_CLEANUP_FAILED' })
    assert.equal(f.counts().disposes, 2, 'close retries must share the still-owned disposal')
    await f.assertLocked()
    assert.equal(f.engine.runtimes.size, 1)
    retry.resolve()
    await bounded(f.engine.close())
    assert.equal(f.engine.runtimes.size, 0)
    await f.assertReleased()
  } finally {
    retry.resolve()
  }
})

test('foreground user cancellation returns the unconfirmed cleanup report without dropping its owner', async (t) => {
  const f = await fixture(t),
    signal = new AbortController()
  const starting = f.engine.start({ ...input, run_in_background: false }, profile, {
    signal: signal.signal
  })
  await f.entered.promise
  const task = f.engine.state!.tasks[0],
    runtime = f.engine.runtimes.get(task.task_id)!
  signal.abort()
  const stopped = await bounded(starting)
  assert.equal(stopped.status, 'canceled')
  assert.equal(stopped.stopError?.code, 'TASK_STOP_FAILED')
  assert.equal(stopped.cleanup_pending, true)
  assert.equal(f.engine.runtimes.size, 1)
  f.cleanup.resolve()
  f.release.resolve()
  await bounded(runtime.done!)
  assert.equal(f.counts().prompts, 0)
})

for (const operation of ['stop', 'close']) {
  test(`initialization ${operation} wakes an append admission waiting for prompt dispatch`, async (t) => {
    const f = await fixture(t)
    const task = await f.engine.start(input, profile)
    await f.entered.promise
    const appending = f.engine.append(task.task_id, 'must never be steered')
    const rejected = assert.rejects(appending)
    await until(() => Boolean(f.engine.runtimes.get(task.task_id)?.delivery))
    if (operation === 'stop') {
      const stopped = await bounded(f.engine.stop(task.task_id))
      assert.equal(stopped.cleanup_pending, true)
    } else {
      await assert.rejects(bounded(f.engine.close()), { code: 'CHILD_CLEANUP_FAILED' })
    }
    await bounded(rejected)
    assert.equal(f.engine.runtimes.size, 1)
    assert.equal(f.counts().prompts, 0)
  })
}

test('a failed cleanup-marker write rejects foreground cancellation without abandoning initialization', async (t) => {
  const f = await fixture(t),
    controller = new AbortController()
  const starting = f.engine.start({ ...input, run_in_background: false }, profile, {
    signal: controller.signal
  })
  await f.entered.promise
  const runtime = [...f.engine.runtimes.values()][0]!
  const save = f.engine.store.save.bind(f.engine.store)
  const failure = new Error('cleanup marker write failed')
  f.engine.store.save = async (state) => {
    if (state.tasks.some((task) => task.stopError?.code === 'CHILD_CLEANUP_FAILED')) {
      throw failure
    }
    await save(state)
  }
  try {
    controller.abort()
    await assert.rejects(bounded(starting), failure)
    assert.equal(f.engine.runtimes.size, 1)
    assert.equal(f.counts().prompts, 0)
    await f.assertLocked()
  } finally {
    f.engine.store.save = save
    f.cleanup.resolve()
    f.release.resolve()
    await bounded(runtime.done!)
  }
})

for (const write of ['reject', 'pending', 'marker-pending', 'terminal-pending']) {
  for (const operation of write.includes('-') ? ['signal'] : ['signal', 'stop', 'close']) {
    test(`first stopping write ${write}: ${operation} stays bounded and retains its original owner`, async (t) => {
      const f = await fixture(t),
        controller = new AbortController(),
        blockedWrite = deferred()
      const starting = f.engine.start(
        { ...input, run_in_background: operation !== 'signal' },
        profile,
        { signal: controller.signal }
      )
      await f.entered.promise
      const task = f.engine.state!.tasks[0],
        runtime = f.engine.runtimes.get(task.task_id)!
      const save = f.engine.store.save.bind(f.engine.store)
      const failure = new Error('first stopping persistence failure')
      const later = new Error('later cleanup-marker persistence failure')
      let first = true
      f.engine.store.save = async (state) => {
        const target = state.tasks.some((item) =>
          write === 'marker-pending'
            ? item.stopError?.code === 'CHILD_CLEANUP_FAILED'
            : write === 'terminal-pending'
              ? item.status === 'canceled' && !item.stopError
              : item.status === 'stopping'
        )
        if (first && target) {
          first = false
          if (write === 'reject') {
            throw failure
          }
          await blockedWrite.promise
        } else if (
          write === 'reject' &&
          state.tasks.some((item) => item.stopError?.code === 'CHILD_CLEANUP_FAILED')
        ) {
          throw later
        }
        await save(state)
      }
      try {
        let expected =
          write === 'reject'
            ? (error: unknown) => error === failure
            : { code: 'CHILD_CLEANUP_FAILED' }
        if (operation === 'signal') {
          controller.abort()
          if (write === 'terminal-pending') {
            f.cleanup.resolve()
            f.release.resolve()
          }
          await assert.rejects(bounded(starting), expected)
        } else {
          await starting
          await assert.rejects(
            bounded(operation === 'stop' ? f.engine.stop(task.task_id) : f.engine.close()),
            expected
          )
        }
        if (write === 'pending') {
          blockedWrite.reject(failure)
          await assert.rejects(runtime.stoppingWrite!, (error) => error === failure)
          expected = (error: unknown) => error === failure
        }
        assert.ok(
          runtime.stopWait,
          'the cleanup fallback is installed before the first write can fail'
        )
        assert.equal(f.engine.runtimes.get(task.task_id), runtime)
        assert.equal(f.counts().prompts, 0)
        await f.assertLocked()
        await assert.rejects(bounded(f.engine.stop(task.task_id)), expected)
        await assert.rejects(bounded(f.engine.close()), expected)
        if (write === 'reject') {
          await assert.rejects(f.engine.start(input, profile), (error) => error === failure)
        }
      } finally {
        f.engine.store.save = save
        blockedWrite.resolve()
        f.cleanup.resolve()
        f.release.resolve()
        await bounded(runtime.done!)
      }
      await f.engine.close()
      await f.assertReleased()
    })
  }
}

test('normal initialization and pre-admission cancellation preserve prompt and admission behavior', async (t) => {
  const f = await fixture(t),
    signal = AbortSignal.abort()
  await assert.rejects(f.engine.start(input, profile, { signal }), { name: 'AbortError' })
  assert.equal(f.counts().calls, 0)
  f.release.resolve()
  f.cleanup.resolve()
  const result = await bounded(
    f.engine.start({ ...input, run_in_background: false }, { ...profile, timeoutMs: 2000 })
  )
  assert.equal(result.status, 'succeeded')
  assert.equal(result.cleanup_pending, undefined)
  assert.equal(f.counts().prompts, 1)
})
