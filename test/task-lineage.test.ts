import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import ts from 'typescript-fixture'
import { TaskEngine } from '../src/engine.ts'
import { TaskStore } from '../src/store.ts'
import { queryResult } from '../src/tool-result-control.ts'
import { isActiveTaskStatus } from '../src/vendor/mcode-background-task/status.ts'
import type { AgentProfile, TaskSummary } from '../src/types.ts'

const profile: AgentProfile = {
  name: 'worker',
  instructions: 'Only the owned fixture.',
  tools: [],
  skills: [],
  extensions: [],
  mcp: false,
  timeoutMs: 0
}
const input = { agent_name: 'worker', description: 'Owned task', prompt: 'First turn' }

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-task-lineage-'))
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Each fixture owns a distinct child factory across its reopen operations.
  const createChild = async ({ sessionPath }) => ({
    sessionPath,
    prompt: async () => ({
      text: 'done',
      outcome: { kind: 'returned' as const, status: 'succeeded' as const }
    }),
    steer: async () => {},
    abort: async () => {},
    dispose: async () => {}
  })
  const open = async () =>
    new TaskEngine({
      rootDir: root,
      parentId: 'owner',
      cwd: root,
      createChild,
      maxConcurrency: 1
    }).init()
  const engines: TaskEngine[] = []
  t.after(async () => {
    /* oxlint-disable no-await-in-loop -- Release owned resources in order before removing the shared fixture. */
    for (const engine of engines) {
      await engine.close()
    }
    /* oxlint-enable no-await-in-loop */
    await rm(root, { recursive: true, force: true })
  })
  const engine = await open()
  engines.push(engine)
  return {
    root,
    engine,
    async reopen() {
      const next = await open()
      engines.push(next)
      return next
    }
  }
}

async function settled(engine: TaskEngine, task: TaskSummary) {
  await engine.runtimes.get(task.task_id)?.done
  return (await engine.query({ task_id: task.task_id })) as TaskSummary
}

test('activated append lineage and execution mode survive replay, synchronous send and restart', async (t) => {
  const { engine, reopen } = await fixture(t)
  const first = await engine.start(input, profile)
  const appended = await settled(
    engine,
    await engine.append(first.task_id, 'Second turn', { requestId: 'append-once' })
  )
  const summary = queryResult(appended).details.task
  assert.equal(summary.parent_task_id, first.task_id)
  assert.equal(summary.execution_mode, 'append')
  assert.match(queryResult(appended).text, new RegExp('parent_task_id=' + first.task_id))
  assert.equal(appended.session_id, first.session_id)
  const replay = await engine.append(first.task_id, 'Second turn', { requestId: 'append-once' })
  assert.equal(replay.task_id, appended.task_id)
  assert.equal((await engine.query()).length, 2)
  const sent = await engine.send(first.session_id, 'Synchronous continuation')
  assert.equal(queryResult(sent).details.task.parent_task_id, appended.task_id)
  assert.equal(queryResult(sent).details.task.execution_mode, 'foreground')
  await engine.close()
  const restored = await reopen()
  const stored = (await restored.query({ task_id: appended.task_id })) as TaskSummary
  assert.deepEqual(queryResult(stored), queryResult(appended))
  const continued = await settled(restored, await restored.append(sent.task_id, 'After restart'))
  assert.equal(queryResult(continued).details.task.parent_task_id, sent.task_id)
  assert.equal(queryResult(continued).details.task.execution_mode, 'append')
})

test('steered and queued appends keep the admitted task lineage instead of inventing another task', async (t) => {
  const { engine } = await fixture(t)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  engine.createChild = async ({ sessionPath }) => ({
    sessionPath,
    async prompt() {
      await held
      return {
        text: 'merged',
        outcome: { kind: 'returned', status: 'succeeded' }
      }
    },
    async steer() {},
    async abort() {
      release()
    },
    async dispose() {}
  })
  const first = await engine.start({ ...input, run_in_background: true }, profile)
  try {
    const appended = await engine.append(first.task_id, 'Join running turn')
    assert.equal(appended.task_id, first.task_id)
    assert.equal(queryResult(appended).details.task.parent_task_id, null)
    assert.equal(queryResult(appended).details.task.execution_mode, 'background')
    assert.equal((await engine.query()).length, 1)
    const queued = await engine.start({ ...input, run_in_background: true }, profile)
    const joined = await engine.append(queued.task_id, 'Join queued turn')
    assert.equal(joined.task_id, queued.task_id)
    assert.equal(joined.status, 'queued')
    assert.equal(queryResult(joined).details.task.parent_task_id, null)
    assert.equal(queryResult(joined).details.task.execution_mode, 'background')
    assert.equal((await engine.query()).length, 2)
  } finally {
    release()
  }
  await settled(engine, first)
})

test('new lineage metadata is optional for legacy stores and malformed fields still fail closed', async (t) => {
  const { root, engine } = await fixture(t)
  await engine.start(input, profile)
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  await engine.close()
  const legacy = structuredClone(saved)
  delete legacy.tasks[0].parent_task_id
  delete legacy.tasks[0].execution_mode
  const store = new TaskStore(root, 'owner')
  await store.init()
  try {
    await store.save(legacy)
  } finally {
    await store.close()
  }
  const old = new TaskStore(root, 'owner')
  const loaded = await old.init()
  assert.equal(loaded.tasks[0].parent_task_id, undefined)
  assert.equal(loaded.tasks[0].execution_mode, undefined)
  assert.equal(
    queryResult({ ...loaded.tasks[0], output_bytes: 0 }).details.task.parent_task_id,
    null
  )
  await old.close()
  /* oxlint-disable no-await-in-loop -- Cases reuse one task store; finish validation and cleanup before overwriting it. */
  for (const [key, values] of [
    ['parent_task_id', ['', null, 42, saved.tasks[0].task_id]],
    ['execution_mode', ['', null, 42, 'steered']]
  ] as const) {
    for (const value of values) {
      const writer = new TaskStore(root, 'owner')
      await writer.init()
      const invalid = structuredClone(saved)
      invalid.tasks[0][key] = value
      await writer.save(invalid)
      await writer.close()
      const reader = new TaskStore(root, 'owner')
      await assert.rejects(reader.init(), /Invalid task store state/, key)
      // Reset with the already owned fixture bytes before the next negative case.
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(reader.file, JSON.stringify(saved))
      )
    }
  }
  /* oxlint-enable no-await-in-loop */
})

test('real activated append query matches the pinned upstream public lineage projection', async (t) => {
  const source = await readFile(
    new URL('./fixtures/task-lineage/local-task-control.ts.txt', import.meta.url),
    'utf8'
  )
  const lock = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8'))
  const entry = lock.watch.find((value) => value.source.endsWith('/desktop/local-task-control.ts'))
  assert.equal(createHash('sha256').update(source).digest('hex'), entry?.sha256)
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true
    }
  }).outputText
  const exports = {} as {
    LocalTaskQueryTool: new (host: unknown) => {
      execute(context: unknown, input: unknown): Promise<{ details: unknown }>
    }
  }
  const definitions = Object.fromEntries(
    ['Query', 'Output', 'Stop'].map((kind) => [
      'LocalTask' + kind + 'ToolDef',
      { name: 'task_' + kind.toLowerCase() }
    ])
  )
  const imports = {
    '@mavis/agent-core/tools': { bindTool: () => () => {} },
    '@mavis/background-task': { isActiveTaskStatus },
    './builtin-defs.js': definitions,
    './local-bash-result.js': { readBashExecutionOutcome: () => undefined },
    './ptc-result-projection.js': { withDesktopCompletenessReport: (_name, result) => result }
  }
  new Function('require', 'exports', compiled)((name) => {
    assert.ok(name in imports, name)
    return imports[name]
  }, exports)
  const { engine } = await fixture(t)
  const first = await engine.start(input, profile)
  const next = await settled(engine, await engine.append(first.task_id, 'Follow-up'))
  const oracle = new exports.LocalTaskQueryTool({
    get: async () => ({
      taskId: next.task_id,
      kind: 'subagent',
      status: next.status,
      parentTaskId: first.task_id,
      createdAt: Date.parse(next.created_at),
      endedAt: Date.parse(next.finished_at!),
      description: next.description,
      metadata: { childSessionId: next.session_id, executionMode: 'append' }
    })
  })
  const expected = await oracle.execute({ sessionId: 'owner' }, { task_id: next.task_id })
  assert.deepEqual(queryResult(next).details, expected.details)
})
