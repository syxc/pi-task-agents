import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { TaskController } from '../src/controller.ts'
import { getOwner } from '../src/controller-owners.ts'
import { TaskEngine } from '../src/engine.ts'
import { answer, deferred, fixture, profile } from './pi-backend-test-helpers.ts'

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('native owner operation exceeded test bound')),
          2500
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('native startup cancellation retains the controller owner and real leases until shutdown is confirmed', async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    startup = deferred(),
    shuttingDown = deferred(),
    cleanup = deferred()
  const key = `native-startup-owner-${randomUUID()}`
  const state = {
    entered,
    startup,
    shuttingDown,
    cleanup,
    models: 0,
    shutdowns: 0,
    profiles: 0,
    interval: undefined as ReturnType<typeof setInterval> | undefined
  }
  ;(globalThis as unknown as Record<string, unknown>)[key] = state
  const extension = join(f.root, 'native-owned-startup.mjs')
  await writeFile(
    extension,
    `export default pi => {
    const state = globalThis[${JSON.stringify(key)}];
    pi.on('session_start', async () => {
      state.interval = setInterval(() => {}, 1000);
      state.entered.resolve(); await state.startup.promise;
    });
    pi.on('session_shutdown', async () => {
      state.shutdowns++; state.shuttingDown.resolve(); await state.cleanup.promise;
      clearInterval(state.interval);
    });
  };`
  )
  f.script(() => {
    state.models++
    return answer()
  })
  const pi = {
    getAllTools: () => [],
    getSettings: () => ({}),
    captureResources: async () => ({ extensions: [], skills: [], mcp: null }),
    sendMessage() {},
    appendEntry() {},
    getThinkingLevel: () => 'off'
  } as unknown as ConstructorParameters<typeof TaskController>[0]
  const ctx = {
    cwd: f.cwd,
    mode: 'json',
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => 'native-parent', getEntries: () => [] }
  } as unknown as Parameters<TaskController['ensure']>[0]
  const controller = new TaskController(pi, {
    agentDir: f.agentDir,
    configLoader: async () => ({ maxConcurrency: 1, roles: {}, diagnostics: [] }),
    childFactory: () => (options) =>
      f.create({
        ...options,
        onProfileResolved: async (resolved) => {
          state.profiles++
          await options.onProfileResolved?.(resolved)
        }
      })
  })
  let engine: TaskEngine | undefined
  try {
    engine = (await controller.ensure(ctx)) as TaskEngine
    const task = await engine.start(
      { description: 'Owned native startup', prompt: 'never dispatch', run_in_background: true },
      { ...profile, extensions: [extension] }
    )
    await bounded(entered.promise)
    const runtime = engine.runtimes.get(task.task_id)!
    const [stopped] = await bounded(controller.stopAll('native parent canceled'))
    assert.equal(stopped.status, 'canceled')
    assert.equal(stopped.cleanup_pending, true)
    assert.equal(stopped.stopError?.code, 'TASK_STOP_FAILED')
    const rootDir = join(f.agentDir, 'task-agents', 'sessions')
    assert.equal(getOwner(rootDir, 'native-parent')?.engine, engine)
    await assert.rejects(bounded(controller.shutdown()), { code: 'CHILD_CLEANUP_FAILED' })
    assert.equal(controller.engine, engine)
    const other = new TaskEngine({
      rootDir,
      parentId: 'native-parent',
      cwd: f.cwd,
      createChild: f.create
    })
    await assert.rejects(other.init(), /active task owner/)
    await assert.rejects(f.child({}, task.childSessionPath), /leased/)
    startup.resolve()
    await bounded(shuttingDown.promise)
    assert.equal(engine.runtimes.size, 1)
    assert.equal(state.models, 0)
    assert.equal(state.profiles, 0)
    await assert.rejects(bounded(controller.shutdown()), { code: 'CHILD_CLEANUP_FAILED' })
    await assert.rejects(f.child({}, task.childSessionPath), /leased/)
    cleanup.resolve()
    await bounded(runtime.done!)
    assert.equal(state.shutdowns, 1)
    assert.equal(engine.runtimes.size, 0)
    assert.equal(state.models, 0)
    await bounded(controller.shutdown())
    assert.equal(controller.engine, undefined)
    assert.equal(getOwner(rootDir, 'native-parent'), undefined)
    await other.init()
    await other.close()
    await (await f.child({}, task.childSessionPath)).dispose()
  } finally {
    startup.resolve()
    cleanup.resolve()
    if (engine) {
      await bounded(Promise.all([...engine.runtimes.values()].map((runtime) => runtime.done)))
    }
    await bounded(controller.shutdown())
    clearInterval(state.interval)
    delete (globalThis as unknown as Record<string, unknown>)[key]
  }
})
