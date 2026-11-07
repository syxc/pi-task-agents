import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const [mode, root, token, phase] = process.argv.slice(2)
const heartbeat = join(root, 'resource.json')
const stopped = join(root, 'resource-stopped.json')
const stop = join(root, 'resource-stop')
const send = (event, data = {}) =>
  new Promise((resolve, reject) => {
    process.send({ event, pid: process.pid, ...data }, (error) =>
      error ? reject(error) : resolve()
    )
  })
async function gate(data) {
  await send('gate', data)
  // Freeze only this fixture after the exact save boundary, not a guessed sleep.
  process.kill(process.pid, 'SIGSTOP')
  await new Promise(() => {})
}
async function waitForFile(path) {
  const end = Date.now() + 8000
  while (!existsSync(path)) {
    assert.ok(Date.now() < end, 'owned resource handshake deadline')
    // oxlint-disable-next-line no-await-in-loop -- Poll only this fixture's token-bound files.
    await delay(5)
  }
}
if (mode === 'resource') {
  let tick = 0
  const update = () => {
    const row = { pid: process.pid, ppid: process.ppid, token, tick: ++tick }
    writeFileSync(heartbeat, JSON.stringify(row))
    if (existsSync(stop) && readFileSync(stop, 'utf8') === token) {
      writeFileSync(stopped, JSON.stringify(row))
      process.exit(0)
    }
  }
  update()
  setInterval(update, 20)
} else if (mode === 'restore') {
  const { TaskEngine } = await import('../../../src/engine.ts')
  const engine = await new TaskEngine({
    rootDir: join(root, 'store'),
    parentId: 'owner',
    cwd: root,
    createChild: async () => {
      throw new Error('An orphan must not create a child')
    }
  }).init()
  const rows = await engine.query()
  let closeError
  try {
    await engine.close()
  } catch (error) {
    closeError = error.code
  }
  process.stdout.write(JSON.stringify({ rows, closeError }))
  // This process exits with its quarantine lock, as a real restarted owner would.
  process.exit(0)
} else {
  const { TaskEngine } = await import('../../../src/engine.ts')
  const { createPiChildFactory } = await import('../../../src/pi-backend.ts')
  const sdk = await import('@earendil-works/pi-coding-agent')
  const model = {
    provider: 'offline',
    id: 'local',
    api: 'test',
    reasoning: false,
    input: ['text'],
    contextWindow: 10000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
  const runtime = {
    getModel: () => model,
    getModels: () => [],
    getProviders: () => [],
    hasConfiguredAuth: () => true,
    resolveModel: async () => ({ model, thinkingLevel: 'off' }),
    streamSimple() {
      throw new Error('Crash fixture must never call a model')
    }
  }
  let resource
  const factory = (pi) => {
    pi.on('session_start', async () => {
      resource = spawn(
        process.execPath,
        [
          '--import',
          fileURLToPath(new URL('../resource-mcp/offline-guard.mjs', import.meta.url)),
          fileURLToPath(import.meta.url),
          'resource',
          root,
          token
        ],
        { cwd: root, env: process.env, detached: true, stdio: 'ignore' }
      )
      resource.unref()
      await send('resource', { resourcePid: resource.pid, token })
      await waitForFile(heartbeat)
      await send('startup')
      await waitForFile(join(root, 'release-startup'))
    })
    pi.on('session_shutdown', async () => {
      writeFileSync(stop, token)
      await waitForFile(stopped)
      assert.equal(JSON.parse(readFileSync(stopped, 'utf8')).token, token)
    })
  }
  const createChild = createPiChildFactory({
    agentDir: join(root, 'agent'),
    sdk,
    modelRuntime: runtime,
    inheritedModel: model,
    resourceLoader: {
      getExtensions: () => ({
        extensions: [
          {
            path: '<inline:crash-resource>',
            resolvedPath: '<inline:crash-resource>',
            sourceInfo: { source: 'local', scope: 'user', origin: 'fixture' },
            factory
          }
        ]
      }),
      getSkills: () => ({ skills: [] })
    }
  })
  const engine = await new TaskEngine({
    rootDir: join(root, 'store'),
    parentId: 'owner',
    cwd: root,
    maxConcurrency: 1,
    createChild
  }).init()
  const save = engine.store.save.bind(engine.store)
  engine.store.save = async (state) => {
    const row = JSON.parse(JSON.stringify(state.tasks[0] ?? null))
    const clean = row?.status === 'canceled' && !row.ownedCommandCleanupPending
    if (phase === 'cleanup-before-save' && clean) {
      await gate({ boundary: phase })
    }
    await save(state)
    if (
      (phase === 'stopping' && row?.status === 'stopping') ||
      (phase === 'cleanup-after-save' && clean)
    ) {
      await gate({ boundary: phase, disk: JSON.parse(await readFile(engine.store.file, 'utf8')) })
    }
  }
  const task = await engine.start(
    {
      description: 'Real SDK initialization crash',
      prompt: 'Never prompt',
      run_in_background: true
    },
    {
      name: 'worker',
      instructions: 'Owned offline crash fixture.',
      thinking: 'off',
      tools: [],
      skills: [],
      extensions: ['crash-resource'],
      mcp: false,
      timeoutMs: 0
    }
  )
  await send('task', { task, file: engine.store.file })
  process.on('message', async ({ action }) => {
    try {
      if (action === 'stop') {
        const result = await engine.stop(task.task_id, 'controlled stop')
        if (phase === 'marker') {
          await gate({ boundary: phase, result })
        }
      } else if (action === 'release') {
        writeFileSync(join(root, 'release-startup'), token)
      }
    } catch (error) {
      await send('failure', { error: error.stack })
      process.exit(1)
    }
  })
}
