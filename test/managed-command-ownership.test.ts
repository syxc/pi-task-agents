import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import { chmod, mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { TaskEngine } from '../src/engine.ts'
import type { AgentProfile } from '../src/types.ts'
import { answer, fixture, tool } from './pi-backend-test-helpers.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const profile: AgentProfile = {
  name: 'worker',
  instructions: 'Own the assigned native command only.',
  tools: ['bash'],
  extensions: [],
  skills: [],
  mcp: false,
  timeoutMs: 0
}

test(
  'Engine persists native-command ownership before spawn, retains it across crash recovery, and clears it only after abort cleanup',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      rootDir = join(f.root, 'engine'),
      pidFile = join(f.root, 'owned-command.pid')
    const engine = new TaskEngine({
      parentId: 'command-parent',
      cwd: f.cwd,
      rootDir,
      maxConcurrency: 1,
      resolveProfile: () => profile,
      createChild: f.create
    })
    await engine.init()
    const entered = deferred(),
      release = deferred(),
      pidReady = deferred()
    const watcher = watch(f.root, (_event, filename) => {
      if (String(filename) === 'owned-command.pid') {
        readFile(pidFile, 'utf8')
          .then((value) => {
            if (/^[1-9][0-9]*$/.test(value)) {
              pidReady.resolve()
            }
          })
          .catch(() => {})
      }
    })
    t.after(() => watcher.close())
    const persist = engine.persist.bind(engine)
    let held = false
    engine.persist = async () => {
      if (
        !held &&
        engine
          .getState()
          .tasks.some(
            (task) =>
              task.ownedCommandCleanupPending &&
              engine.runtimes.get(task.task_id)?.initializing === false
          )
      ) {
        held = true
        entered.resolve()
        await release.promise
      }
      await persist()
    }
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('OWNED_READY');setInterval(()=>{},1000)`)}`
    f.script((step) =>
      step === 1 ? tool('bash_task', { action: 'start', command }) : answer('MUST_WAIT_FOR_COMMAND')
    )
    let recovered: TaskEngine | undefined
    try {
      const task = await engine.start(
        {
          agent_name: 'worker',
          description: 'owned command',
          prompt: 'Run the assigned command and await its result.',
          run_in_background: true
        },
        profile
      )
      await entered.promise
      await assert.rejects(stat(pidFile), { code: 'ENOENT' })
      const before = JSON.parse(await readFile(engine.store.file, 'utf8'))
      assert.equal(
        before.tasks.find(
          (row: { task_id: string; ownedCommandCleanupPending?: boolean }) =>
            row.task_id === task.task_id
        ).ownedCommandCleanupPending,
        undefined
      )
      release.resolve()
      await pidReady.promise
      const pid = Number(await readFile(pidFile, 'utf8'))
      assert.notEqual(pid, process.pid)
      process.kill(pid, 0)
      const state = JSON.parse(await readFile(engine.store.file, 'utf8'))
      const row = state.tasks.find(
        (row: { task_id: string; ownedCommandCleanupPending?: boolean }) =>
          row.task_id === task.task_id
      )
      assert.equal(row.ownedCommandCleanupPending, true)
      const live = await engine.query({ task_id: task.task_id })
      assert.equal(live.status, 'running')
      assert.equal('ownedCommandCleanupPending' in live, false)

      // A copied crash image has no live process handle; recovery must not replay or infer cleanup.
      const recoveredRoot = join(f.root, 'recovery'),
        recoveredFile = join(recoveredRoot, relative(rootDir, engine.store.file))
      await mkdir(dirname(recoveredFile), { recursive: true })
      await writeFile(recoveredFile, JSON.stringify(state))
      let replayed = 0
      recovered = new TaskEngine({
        parentId: 'command-parent',
        cwd: f.cwd,
        rootDir: recoveredRoot,
        resolveProfile: () => profile,
        createChild: async () => {
          replayed++
          throw new Error('Must not replay')
        }
      })
      await recovered.init()
      const unknown = await recovered.query({ task_id: task.task_id })
      assert.equal(unknown.status, 'lost')
      assert.equal(unknown.cleanup_pending, true)
      assert.equal(unknown.stopError?.code, 'CHILD_CLEANUP_FAILED')
      await assert.rejects(recovered.close(), /cleanup/i)
      assert.equal(replayed, 0)

      const stopped = await engine.stop(task.task_id)
      assert.equal(stopped.status, 'canceled')
      assert.equal(stopped.cleanup_pending, undefined)
      const committed = JSON.parse(await readFile(engine.store.file, 'utf8'))
      assert.equal(
        committed.tasks.find(
          (row: { task_id: string; ownedCommandCleanupPending?: boolean }) =>
            row.task_id === task.task_id
        ).ownedCommandCleanupPending,
        undefined
      )
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      const session = engine.sessions.get(task.session_id)!
      assert.ok(session.child)
      // Even a handle injected from another owner cannot certify this copied orphan image.
      recovered.sessions.set(task.session_id, session)
      await assert.rejects(recovered.close(), { code: 'CHILD_CLEANUP_FAILED' })
      assert.equal((await recovered.query({ task_id: task.task_id })).cleanup_pending, true)
      assert.equal(replayed, 0)

      const shutdownPid = join(f.root, 'shutdown-command.pid'),
        shutdownReady = deferred()
      const shutdownWatcher = watch(f.root, (_event, filename) => {
        if (String(filename) === 'shutdown-command.pid') {
          readFile(shutdownPid, 'utf8')
            .then((value) => {
              if (/^[1-9][0-9]*$/.test(value)) {
                shutdownReady.resolve()
              }
            })
            .catch(() => {})
        }
      })
      t.after(() => shutdownWatcher.close())
      const shutdownCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(shutdownPid)},String(process.pid));setInterval(()=>{},1000)`)}`
      f.script((step) =>
        step === 1
          ? tool('bash_task', { action: 'start', command: shutdownCommand })
          : answer('SHUTDOWN_MUST_DRAIN_COMMAND')
      )
      const closingTask = await engine.start(
        {
          agent_name: 'worker',
          description: 'shutdown ownership',
          prompt: 'Retain the owned command until shutdown.',
          run_in_background: true
        },
        profile
      )
      await shutdownReady.promise
      const shutdownProcess = Number(await readFile(shutdownPid, 'utf8'))
      await engine.close()
      assert.throws(() => process.kill(shutdownProcess, 0), { code: 'ESRCH' })
      assert.equal(
        engine.getState().tasks.find((row) => row.task_id === closingTask.task_id)
          ?.ownedCommandCleanupPending,
        undefined
      )
      assert.equal(engine.runtimes.size, 0)
    } finally {
      release.resolve()
      await engine.close()
      // Release only the fixture's store lock; the copied orphan must remain quarantined.
      await recovered?.store.close()
    }
  }
)

test('a latched parent-store failure blocks managed-command admission in an already running child', async (t) => {
  const f = await fixture(t),
    dispatch = deferred()
  let admitted = false
  const engine = new TaskEngine({
    parentId: 'poisoned-store-parent',
    cwd: f.cwd,
    rootDir: join(f.root, 'engine'),
    createChild: async (options) => ({
      sessionPath: options.sessionPath,
      async prompt() {
        await dispatch.promise
        engine.storageError = new Error('PARENT_STORE_UNAVAILABLE')
        assert.ok(options.onOwnedCommandStarted)
        await options.onOwnedCommandStarted('poisoned-turn')
        admitted = true
        return {
          text: 'UNSAFE_ADMISSION',
          commandCleanupConfirmed: true,
          outcome: { kind: 'returned', status: 'succeeded' }
        }
      },
      abort: async () => {},
      dispose: async () => {}
    })
  })
  await engine.init()
  try {
    const task = await engine.start(
      {
        agent_name: 'worker',
        description: 'storage fence',
        prompt: 'Exercise the host admission callback.',
        run_in_background: true
      },
      profile
    )
    const done = engine.runtimes.get(task.task_id)!.done
    dispatch.resolve()
    await done
    assert.equal(admitted, false)
    const row = engine.getState().tasks.find((row) => row.task_id === task.task_id)!
    assert.equal(row.status, 'failed')
    assert.equal(row.ownedCommandCleanupPending, undefined)
    assert.match(row.error!, /PARENT_STORE_UNAVAILABLE/)
  } finally {
    dispatch.resolve()
    await engine.close()
  }
})

test(
  'native journal path failure keeps the Engine slot and child lease until an explicit successful cleanup retry',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      ready = deferred(),
      releaseFile = join(f.root, 'release-native-command')
    const pidFile = join(f.root, 'journal-command.pid')
    let created = 0,
      sessionPath: string | undefined,
      heldSessionPath: string | undefined
    const restore = async () => {
      if (!heldSessionPath) {
        return
      }
      await chmod(sessionPath!, 0o700)
      await rmdir(sessionPath!)
      await rename(heldSessionPath, sessionPath!)
      heldSessionPath = undefined
    }
    const engine = new TaskEngine({
      parentId: 'journal-parent',
      cwd: f.cwd,
      rootDir: join(f.root, 'engine'),
      maxConcurrency: 1,
      resolveProfile: () => profile,
      createChild: async (options) => {
        created++
        return f.create(options)
      }
    })
    await engine.init()
    const watcher = watch(f.root, (_event, filename) => {
      if (String(filename) === 'journal-command.pid') {
        readFile(pidFile, 'utf8')
          .then((value) => {
            if (/^[1-9][0-9]*$/.test(value)) {
              ready.resolve()
            }
          })
          .catch(() => {})
      }
    })
    t.after(() => watcher.close())
    const code = `const fs=require('node:fs');const w=fs.watch(${JSON.stringify(f.root)},(_e,f)=>{if(String(f)==='release-native-command'){w.close();process.exit(0)}});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('JOURNAL_COMMAND_READY');`
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`
    f.script((step) =>
      step === 1
        ? tool('bash_task', { action: 'start', command })
        : answer('MUST_NOT_CLAIM_DURABLE_SUCCESS')
    )
    try {
      const task = await engine.start(
        {
          agent_name: 'worker',
          description: 'journal fault',
          prompt: 'Await the owned command.',
          run_in_background: true
        },
        profile
      )
      await ready.promise
      const pid = Number(await readFile(pidFile, 'utf8'))
      sessionPath = engine
        .getState()
        .tasks.find((row) => row.task_id === task.task_id)!.childSessionPath
      heldSessionPath = sessionPath + '.held'
      await rename(sessionPath, heldSessionPath)
      await mkdir(sessionPath)
      await writeFile(releaseFile, 'release')
      await engine.runtimes.get(task.task_id)!.done
      const failed = await engine.query({ task_id: task.task_id })
      assert.equal(failed.status, 'failed')
      assert.equal(failed.cleanup_pending, true)
      assert.equal(failed.stopError?.code, 'CHILD_CLEANUP_FAILED')
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      assert.equal(
        engine.getState().tasks.find((row) => row.task_id === task.task_id)
          ?.ownedCommandCleanupPending,
        true
      )
      assert.equal(engine.runtimes.has(task.task_id), true)
      await assert.rejects(
        engine.start(
          {
            agent_name: 'worker',
            description: 'next task',
            prompt: 'Must not dispatch.',
            run_in_background: true
          },
          profile
        ),
        { code: 'CHILD_CLEANUP_FAILED' }
      )
      assert.equal(created, 1)
      await assert.rejects(engine.close(), /cleanup/i)
      assert.equal(created, 1)
      await restore()
      await engine.close()
      assert.equal(
        engine.getState().tasks.find((row) => row.task_id === task.task_id)
          ?.ownedCommandCleanupPending,
        undefined
      )
      const reopened = new TaskEngine({
        parentId: 'journal-parent',
        cwd: f.cwd,
        rootDir: join(f.root, 'engine'),
        resolveProfile: () => profile,
        createChild: async () => {
          created++
          throw new Error('Must not replay')
        }
      })
      await reopened.init()
      try {
        assert.equal((await reopened.query({ task_id: task.task_id })).cleanup_pending, undefined)
      } finally {
        await reopened.close()
      }
      assert.equal(created, 1)
    } finally {
      await writeFile(releaseFile, 'release')
      await restore()
      await engine.close()
    }
  }
)
