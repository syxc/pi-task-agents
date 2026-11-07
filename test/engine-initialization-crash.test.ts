import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { TaskEngine } from '../src/engine.ts'
import type { TaskSummary } from '../src/types.ts'

interface OwnerMessage {
  event: string
  task?: TaskSummary
  file?: string
  error?: string
}

const guard = fileURLToPath(new URL('./fixtures/resource-mcp/offline-guard.mjs', import.meta.url))
const owner = fileURLToPath(new URL('./fixtures/initialization-crash/owner.mjs', import.meta.url))
const profile = {
  name: 'worker',
  instructions: 'Owned offline recovery.',
  tools: [],
  skills: [],
  extensions: [],
  mcp: false,
  timeoutMs: 0
}
const input = { description: 'blocked', prompt: 'offline', run_in_background: true }
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false
    }
    throw error
  }
}
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 10000
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Observe each owned transition before polling again.
    const result = await read()
    if (result) {
      return result
    }
    assert.ok(Date.now() < end, label)
    // oxlint-disable-next-line no-await-in-loop -- Bound each owned subprocess handshake.
    await delay(5)
  }
}
async function json(path: string) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}

for (const phase of [
  'initializing',
  'stopping',
  'marker',
  'cleanup-before-save',
  'cleanup-after-save'
]) {
  test(`real SDK crash at ${phase} retains initialization cleanup quarantine`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'engine-sdk-crash-')),
      token = randomUUID()
    const audit = join(root, 'network.jsonl'),
      home = join(root, 'home')
    await Promise.all([mkdir(home), mkdir(join(root, 'agent'))])
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      TMPDIR: root,
      PI_CODING_AGENT_DIR: join(root, 'agent'),
      RESOURCE_MCP_NETWORK_AUDIT: audit
    }
    const child = spawn(process.execPath, ['--import', guard, owner, 'owner', root, token, phase], {
      cwd: root,
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    const messages: OwnerMessage[] = []
    let stderr = '',
      exited = false,
      restored: TaskEngine | undefined = undefined
    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    child.on('message', (message) => {
      messages.push(message as OwnerMessage)
    })
    child.once('exit', () => {
      exited = true
    })
    t.after(async () => {
      // Only our child handle is signaled. The detached fixture stops by its owned token.
      await writeFile(join(root, 'resource-stop'), token)
      if (!exited) {
        child.kill('SIGKILL')
      }
      await until(() => exited, 'owner exit')
      const resource = await json(join(root, 'resource.json'))
      if (resource) {
        assert.equal(resource.token, token)
        await until(() => !alive(resource.pid), 'resource exit')
      }
      // Test-only lock release models this observer process exiting; it is not a cleanup receipt.
      await restored?.store.close()
      const records = (await readFile(audit, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.ok(records.every((row) => row.event === 'guard-installed'))
      await rm(root, { recursive: true, force: true })
    })
    const wait = (event: string) =>
      until(() => {
        assert.equal(
          messages.find((m) => m.event === 'failure'),
          undefined,
          stderr
        )
        const message = messages.find((m) => m.event === event)
        assert.ok(message || !exited, `owner exited before ${event}: ${stderr}`)
        return message
      }, event)
    const admitted = await wait('task')
    assert.ok(admitted.file)
    assert.ok(admitted.task)
    await wait('startup')
    const resource = await until(() => json(join(root, 'resource.json')), 'resource readiness')
    assert.equal(resource.token, token)
    if (phase !== 'initializing') {
      child.send({ action: 'stop' })
      if (phase.startsWith('cleanup-')) {
        child.send({ action: 'release' })
      }
      await wait('gate')
    }
    const before = await json(admitted.file)
    const confirmed = phase === 'cleanup-after-save'
    assert.equal(before.tasks[0].ownedCommandCleanupPending, confirmed ? undefined : true)
    if (phase === 'stopping') {
      assert.equal(before.tasks[0].status, 'stopping')
      assert.equal(
        before.tasks[0].stopError,
        undefined,
        'the later fallback marker was not written'
      )
    }
    const atCrash = await json(join(root, 'resource.json'))
    child.kill('SIGKILL')
    await until(() => exited, 'crash exit')
    if (phase.startsWith('cleanup-')) {
      const receipt = await until(
        () => json(join(root, 'resource-stopped.json')),
        'actual disposal receipt'
      )
      assert.equal(receipt.token, token)
      await until(() => !alive(resource.pid), 'disposed resource exit')
    } else {
      const afterDeath = await until(async () => {
        const row = await json(join(root, 'resource.json'))
        return row?.tick > atCrash.tick ? row : undefined
      }, 'resource must remain alive after its owner dies')
      assert.equal(afterDeath.pid, resource.pid)
      assert.ok(alive(resource.pid))
    }
    if (!confirmed) {
      for (let restart = 0; restart < 2; restart++) {
        const restarted = spawnSync(
          process.execPath,
          ['--import', guard, owner, 'restore', root, token],
          {
            cwd: root,
            env,
            encoding: 'utf8',
            timeout: 10000
          }
        )
        assert.equal(restarted.status, 0, restarted.stderr)
        assert.equal(alive(restarted.pid), false)
        const receipt = JSON.parse(restarted.stdout)
        assert.equal(receipt.rows[0].cleanup_pending, true)
        assert.equal(receipt.closeError, 'CHILD_CLEANUP_FAILED')
      }
    }
    let factoryCalls = 0
    const options = {
      rootDir: join(root, 'store'),
      parentId: 'owner',
      cwd: root,
      maxConcurrency: 1,
      createChild: async ({ sessionPath }: { sessionPath: string }) => {
        factoryCalls++
        return {
          sessionPath,
          prompt: async () => ({ text: 'offline' }),
          steer: async () => {},
          abort: async () => {},
          dispose: async () => {}
        }
      }
    }
    restored = await new TaskEngine(options).init()
    const row = await restored.query({ task_id: admitted.task.task_id })
    assert.equal(row.status, before.tasks[0].status === 'canceled' ? 'canceled' : 'lost')
    if (confirmed) {
      assert.equal(row.cleanup_pending, undefined)
      const next = await restored.append(row.task_id, 'confirmed retry')
      await until(
        async () => (await restored!.query({ task_id: next.task_id })).status === 'succeeded',
        'confirmed continuation'
      )
      await restored.close()
      assert.equal(factoryCalls, 1)
      return
    }
    assert.equal(row.cleanup_pending, true)
    assert.equal(
      row.stopError?.code,
      row.status === 'canceled' ? 'TASK_STOP_FAILED' : 'CHILD_CLEANUP_FAILED'
    )
    await assert.rejects(restored.start(input, profile), { code: 'CHILD_CLEANUP_FAILED' })
    await assert.rejects(restored.append(row.task_id, 'retry'), { code: 'CHILD_CLEANUP_FAILED' })
    await assert.rejects(restored.send(row.session_id, 'retry'), { code: 'CHILD_CLEANUP_FAILED' })
    await assert.rejects(restored.close(), { code: 'CHILD_CLEANUP_FAILED' })
    assert.equal(factoryCalls, 0)
    const competing = new TaskEngine(options)
    await assert.rejects(competing.init(), /active task owner/)
    assert.equal((await readdir(join(restored.store.dir, 'owners'))).length, 1)
    assert.equal((await restored.output(row.task_id, { offset: 0 })).cleanup_pending, true)
    let falseDisposals = 0
    restored.sessions.set(row.session_id, {
      child: {
        sessionPath: row.childSessionPath,
        prompt: async () => ({ text: 'must not run' }),
        steer: async () => {},
        abort: async () => {},
        dispose: async () => {
          falseDisposals++
        }
      }
    })
    await assert.rejects(restored.close(), { code: 'CHILD_CLEANUP_FAILED' })
    assert.equal(falseDisposals, 0, 'a replacement child cannot certify an orphan')
    const other = await new TaskEngine({ ...options, parentId: 'different-owner' }).init()
    try {
      const otherTask = await other.start(input, profile)
      await until(
        async () => (await other.query({ task_id: otherTask.task_id })).status === 'succeeded',
        'independent owner completion'
      )
      await other.close()
    } finally {
      await other.store.close()
    }
    const stillOwned = await json(restored.store.file)
    assert.equal(stillOwned.tasks[0].ownedCommandCleanupPending, true)
    assert.equal(stillOwned.cleanupConfirmed, undefined)
    assert.equal((await restored.query({ task_id: row.task_id })).cleanup_pending, true)
  })
}
