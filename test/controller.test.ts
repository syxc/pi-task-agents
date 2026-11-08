import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskController, RESULT_TYPE } from '../src/controller.ts'
import { taskWidget } from '../src/task-presentation.ts'
import { OutputProjector, outputWait } from '../src/tool-result-control.ts'
import {
  AgentSession,
  InteractiveMode,
  SessionManager,
  initTheme
} from '@earendil-works/pi-coding-agent'
import {
  Container,
  TuiMainScreen,
  stripTerminalSequences,
  visibleWidth
} from '@earendil-works/pi-tui'
import { bounded } from './bounded.ts'

function widgetHost(width = 80) {
  const writes = []
  const terminal = {
    columns: width,
    rows: 40,
    write: (data) => writes.push(data),
    hideCursor() {},
    showCursor() {},
    stop() {}
  }
  const tui = new TuiMainScreen(terminal)
  // Exercise the SDK widget adapter without starting an authenticated agent session.
  initTheme('dark', false)
  const host = Object.create(InteractiveMode.prototype)
  Object.assign(host, {
    ui: tui,
    extensionWidgetsAbove: new Map(),
    extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(),
    widgetContainerBelow: new Container()
  })
  tui.addChild(host.widgetContainerAbove)
  return { host, tui, terminal, writes }
}

function widgetLines(content, width = 200) {
  const { host, tui } = widgetHost(width)
  try {
    host.setExtensionWidget('task-agents', content)
    // The SDK adds one leading spacer, which is not part of the widget.
    return host.widgetContainerAbove
      .render(width)
      .slice(1)
      .map((line) => stripTerminalSequences(line).trim())
  } finally {
    tui.stop()
  }
}

const runtimeAPI = {
  getAllTools: () => [],
  getSettings: () => ({}),
  captureResources: async () => ({ extensions: [], skills: [], mcp: null })
}

function fixture(entries = [], roles = {}) {
  const sent = []
  const engines = []
  const factories = []
  class Engine {
    constructor(options) {
      this.options = options
      this.tasks = []
      engines.push(this)
    }
    async init() {}
    async close() {
      this.closed = true
    }
    async query() {
      return this.tasks
    }
    async pendingNotifications() {
      return this.tasks.filter((task) => task.notification_pending)
    }
    async ackNotification(id) {
      this.tasks.find((task) => task.task_id === id).notification_pending = false
    }
    async output(id) {
      return { ...this.tasks.find((task) => task.task_id === id), output: 'child report' }
    }
    async stop(id) {
      const task = this.tasks.find((task) => task.task_id === id)
      task.status = 'canceled'
      return { ...task }
    }
  }
  const pi = {
    ...runtimeAPI,
    sendMessage: (...args) => sent.push(args),
    getThinkingLevel: () => 'high',
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data })
  }
  const ctx = {
    cwd: '/project',
    mode: 'tui',
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => 'parent-a', getEntries: () => entries }
  }
  const controller = new TaskController(pi, {
    agentDir: '/agent',
    Engine,
    configLoader: async () => ({ maxConcurrency: 4, roles, diagnostics: [] }),
    childFactory: (options) => {
      factories.push(options)
      return () => {}
    }
  })
  return { controller, ctx, engines, sent, entries, pi, factories, Engine }
}
test('codemode authority follows the attached native parent and is not captured from a stale owner', async () => {
  const f = fixture()
  let active = []
  f.pi.getActiveTools = () => active
  let replacement
  try {
    await f.controller.ensure(f.ctx)
    const read = f.factories[0].isCodemodeEnabled
    assert.equal(read(), false)
    active = ['read', 'codemode']
    assert.equal(read(), true)
    active = ['read']
    assert.equal(read(), false)
    active = ['codemode']
    await f.controller.shutdown('new')
    f.pi.getActiveTools = () => {
      throw new Error('Stale parent API must not be called')
    }
    assert.equal(
      read(),
      true,
      'Detached background owner retains its last approved state, not another session'
    )
    replacement = new TaskController(
      { ...f.pi, getActiveTools: () => [] },
      {
        agentDir: '/agent',
        configLoader: async () => ({ roles: {}, diagnostics: [] }),
        childFactory() {
          throw new Error('The retained SDK factory must not be recreated')
        }
      }
    )
    await replacement.ensure(f.ctx)
    assert.equal(
      read(),
      false,
      'Reattachment installs the current parent reader without losing SDK cache'
    )
  } finally {
    await replacement?.shutdown()
    await f.controller.shutdown()
  }
})

test('a canceled snapshot cannot overwrite a reattached owners current approval', async () => {
  const f = fixture([], {
    worker: {
      name: 'worker',
      model: 'fake/model',
      instructions: '',
      tools: ['read'],
      extensions: [],
      skills: [],
      mcp: false,
      timeoutMs: 0
    }
  })
  let release, entered, replacement
  const reading = new Promise((resolve) => {
    entered = resolve
  })
  f.pi.captureResources = () => {
    entered()
    return new Promise((resolve) => {
      release = resolve
    })
  }
  try {
    await f.controller.ensure(f.ctx)
    const read = f.factories[0].getParentRuntime
    const pending = f.controller.start(
      { agent_name: 'worker', description: 'Canceled capture', prompt: '' },
      'old-capture',
      undefined,
      f.ctx
    )
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    await reading
    await f.controller.shutdown('new')
    await rejected
    replacement = new TaskController(
      {
        ...f.pi,
        ...runtimeAPI,
        getSettings: () => ({ shellCommandPrefix: 'export OWNED=REATTACHED' })
      },
      {
        agentDir: '/agent',
        configLoader: async () => ({
          roles: {
            worker: {
              name: 'worker',
              model: 'fake/model',
              instructions: '',
              tools: ['read'],
              extensions: [],
              skills: [],
              mcp: false,
              timeoutMs: 0
            }
          },
          diagnostics: []
        }),
        childFactory() {
          throw new Error('Retained owner must keep its original factory')
        }
      }
    )
    await replacement.ensure(f.ctx)
    f.engines[0].start = async () => complete()
    await replacement.start(
      { agent_name: 'worker', description: 'Current capture', prompt: '' },
      'new-capture',
      undefined,
      f.ctx
    )
    const current = read()
    assert.equal(current.settings.shellCommandPrefix, 'export OWNED=REATTACHED')
    release({ extensions: [], skills: [], mcp: null })
    await Promise.resolve()
    assert.equal(read(), current)
  } finally {
    release?.({ extensions: [], skills: [], mcp: null })
    await replacement?.shutdown()
    await f.controller.shutdown()
  }
})

const complete = (id = 't1') => ({
  task_id: id,
  agent_name: 'worker',
  description: 'bounded work',
  status: 'succeeded',
  notification_pending: true
})

function makeRetryDue(f, ...taskIds) {
  for (const taskId of taskIds) {
    f.controller.inFlight.delete(taskId)
    f.controller.retryAt.set(taskId, Date.now() - 1)
  }
}

test('completion is sent once and stays pending until the persisted message receipt', async () => {
  const f = fixture()
  await f.controller.ensure(f.ctx)
  f.engines[0].tasks.push(complete())
  await Promise.all([f.controller.flush(), f.controller.flush()])
  assert.equal(f.sent.length, 1)
  assert.equal(f.engines[0].tasks[0].notification_pending, true)
  assert.deepEqual(f.sent[0][1], { triggerTurn: true, deliverAs: 'followUp' })
  assert.equal(f.sent[0][0].display, false)
  f.controller.receipt(f.sent[0][0])
  assert.equal(f.engines[0].tasks[0].notification_pending, true)
  f.entries.push({ type: 'custom_message', ...f.sent[0][0] })
  await f.controller.reconcile()
  assert.equal(f.engines[0].tasks[0].notification_pending, false)
  await f.controller.flush()
  assert.equal(f.sent.length, 1)
  await f.controller.shutdown()
})

test('reconcile skips the receipt scan when no notification is pending', async () => {
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    f.ctx.sessionManager.getEntries = () => {
      throw new Error('Receipts must not be scanned without a pending notification')
    }
    await f.controller.reconcile()
  } finally {
    await f.controller.shutdown()
  }
})

for (const { name, mode, delivery } of [
  {
    name: 'startup delivery queues outside TUI instead of starting a turn before the host prompt',
    mode: 'print',
    delivery: { deliverAs: 'nextTurn' }
  },
  {
    name: 'startup delivery still wakes an interactive TUI session',
    mode: 'tui',
    delivery: { triggerTurn: true, deliverAs: 'followUp' }
  }
]) {
  test(name, async () => {
    const f = fixture()
    try {
      f.ctx.mode = mode
      await f.controller.ensure(f.ctx)
      f.engines[0].tasks.push(complete())
      await f.controller.flush({ startup: true })
      assert.equal(f.sent.length, 1)
      assert.deepEqual(f.sent[0][1], delivery)
      await f.controller.flush()
      assert.equal(f.sent.length, 1, 'a startup notice must not be redelivered')
    } finally {
      await f.controller.shutdown()
    }
  })
}

test('background completion delivers verifier facts without treating a failed verdict as execution failure', async () => {
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks.push({
      ...complete(),
      agent_name: 'verifier',
      final_text: 'VERDICT: FAIL',
      verification: {
        modelVerdict: 'fail',
        fileChange: 'no_observed_change',
        observationNotes: ['best effort']
      }
    })
    await f.controller.flush()
    assert.equal(f.sent.length, 1)
    assert.match(f.sent[0][0].content, /model_verdict: fail/)
    assert.match(f.sent[0][0].content, /file_change: no_observed_change/)
    assert.equal(f.sent[0][0].details.status, 'succeeded')
  } finally {
    await f.controller.shutdown()
  }
})

test('even a short result uses the same native notice and required-read contract as MCode', async () => {
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].output = async () => {
      throw new Error('A notice must not read the full result')
    }
    const handoff =
      'Updated owned.ts. Validation passed. Risk: external integration was not checked.'
    f.engines[0].tasks.push({ ...complete(), final_text: handoff })
    await f.controller.flush()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0][0].content.includes(handoff), false)
    assert.match(
      f.sent[0][0].content,
      /Use task_output\(.*before using its findings or reporting them/
    )
    assert.deepEqual(f.sent[0][1], { triggerTurn: true, deliverAs: 'followUp' })
    assert.equal(f.engines[0].tasks[0].final_text, handoff)
  } finally {
    await f.controller.shutdown()
  }
})

test('automatic completion is a bounded notice, not a full-output read or echoed report', async () => {
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].output = async () => {
      throw new Error('A notice must not read the full result')
    }
    f.engines[0].tasks.push({
      ...complete(),
      agent_name: 'verifier',
      final_text: 'LARGE_CHILD_REPORT_'.repeat(10000),
      error: 'Full diagnostics remain available with the result',
      verification: {
        modelVerdict: 'fail',
        fileChange: 'uncertain',
        changedFiles: ['owned.ts'],
        observationNotes: ['Detailed evidence']
      }
    })
    await f.controller.flush()
    assert.equal(f.sent.length, 1)
    const notice = f.sent[0][0]
    assert.ok(notice.content.length < 1200)
    assert.doesNotMatch(notice.content, /LARGE_CHILD_REPORT_|Detailed evidence/)
    assert.match(notice.content, /model_verdict: fail/)
    assert.match(notice.content, /file_change: uncertain/)
    assert.match(notice.content, /task_output/)
    assert.deepEqual(notice.details, { task_id: 't1', parent_id: 'parent-a', status: 'succeeded' })
    assert.equal(f.engines[0].tasks[0].final_text.length, 'LARGE_CHILD_REPORT_'.length * 10000)
  } finally {
    await f.controller.shutdown()
  }
})

test('recovery reconciles a durable custom message before attempting redelivery', async () => {
  const f = fixture([
    {
      type: 'custom_message',
      customType: RESULT_TYPE,
      details: { task_id: 't1', parent_id: 'parent-a' }
    }
  ])
  await f.controller.ensure(f.ctx)
  f.engines[0].tasks.push(complete())
  await f.controller.reconcile()
  await f.controller.flush()
  assert.equal(f.sent.length, 0)
  await f.controller.shutdown()
})

test('stop-all without an engine returns an empty report and still pauses notifications', async () => {
  const f = fixture()
  assert.deepEqual(await f.controller.stopAll(), [])
  assert.equal(f.entries.at(-1).data.paused, true)
})

test('stop-all preserves each stop summary and already unresolved terminal task', async () => {
  const f = fixture()
  try {
    const engine = await f.controller.ensure(f.ctx)
    const held = { task_id: 'held', status: 'canceled', cleanup_pending: true }
    const failed = {
      task_id: 'failed-before',
      status: 'failed',
      stopError: { code: 'CHILD_CLEANUP_FAILED', message: 'dispose failed' }
    }
    engine.tasks = [
      { task_id: 'queued', status: 'queued' },
      { task_id: 'running', status: 'running' },
      { task_id: 'stopping', status: 'stopping' },
      held,
      failed,
      complete()
    ]
    const results = [
      { task_id: 'queued', status: 'canceled' },
      {
        task_id: 'running',
        status: 'canceled',
        cleanup_pending: true,
        stopError: { code: 'TASK_STOP_FAILED', message: 'abort failed' }
      },
      { task_id: 'stopping', status: 'stopping' }
    ]
    const calls = []
    engine.stop = async (id, reason) => {
      calls.push({ id, reason })
      return results.find((task) => task.task_id === id)
    }
    let refreshed = false
    f.controller.updateUI = async () => {
      refreshed = true
    }
    assert.deepEqual(await f.controller.stopAll('explicit reason'), [...results, held])
    assert.deepEqual(calls, [
      { id: 'queued', reason: 'explicit reason' },
      { id: 'running', reason: 'explicit reason' },
      { id: 'stopping', reason: 'explicit reason' }
    ])
    assert.equal(refreshed, true)
    assert.equal(f.entries.at(-1).data.paused, true)
  } finally {
    await f.controller.shutdown()
  }
})

for (const stage of ['query', 'stop', 'updateUI']) {
  test(`stop-all preserves thrown ${stage} errors`, async () => {
    const f = fixture()
    try {
      const engine = await f.controller.ensure(f.ctx)
      engine.tasks = [{ task_id: 'running', status: 'running' }]
      const failure = new Error(`${stage} failed`)
      const target = stage === 'updateUI' ? f.controller : engine
      target[stage] = async () => {
        throw failure
      }
      await assert.rejects(f.controller.stopAll(), (error) => error === failure)
      assert.equal(f.entries.at(-1).data.paused, true)
    } finally {
      await f.controller.shutdown()
    }
  })
}

test('cancel pauses delivery across reload and stops running children', async () => {
  const f = fixture()
  await f.controller.ensure(f.ctx)
  f.engines[0].tasks.push(complete(), { task_id: 't2', status: 'running' })
  await f.controller.stopAll()
  assert.equal(f.engines[0].tasks[1].status, 'canceled')
  await f.controller.flush()
  assert.equal(f.sent.length, 0)
  await f.controller.shutdown()
  await f.controller.ensure(f.ctx)
  f.engines[1].tasks.push(complete())
  await f.controller.flush()
  assert.equal(f.sent.length, 0)
  f.controller.resume()
  await f.controller.flush()
  assert.equal(f.sent.length, 1)
  await f.controller.shutdown()
})

test('session replacement retains the old owner and never sends its result to the new session', async () => {
  const f = fixture()
  const notices = []
  f.ctx.hasUI = true
  f.ctx.ui = { setStatus() {}, setWidget() {}, notify: (...args) => notices.push(args) }
  await f.controller.ensure(f.ctx)
  f.engines[0].tasks.push({ ...complete(), status: 'failed' })
  const other = {
    ...f.ctx,
    sessionManager: { getSessionId: () => 'parent-b', getEntries: () => [] }
  }
  await f.controller.ensure(other)
  assert.notEqual(f.engines[0].closed, true)
  await f.engines[0].options.notify()
  await f.controller.flush()
  assert.equal(f.sent.length, 0)
  assert.equal(f.engines[1].options.parentId, 'parent-b')
  assert.equal(notices.length, 0)
  await f.controller.ensure(f.ctx)
  assert.equal(f.controller.engine, f.engines[0])
  await f.controller.flush()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0][0].details.parent_id, 'parent-a')
  assert.equal(notices.length, 1)
  await f.controller.shutdown()
  assert.equal(f.engines[0].closed, true)
  assert.equal(f.engines[1].closed, true)
})

test('dialog defers completion delivery until it closes', async () => {
  const f = fixture()
  await f.controller.ensure(f.ctx)
  f.engines[0].tasks.push(complete())
  f.controller.dialogOpen = true
  await f.controller.flush()
  assert.equal(f.sent.length, 0)
  f.controller.dialogOpen = false
  await f.controller.flush()
  assert.equal(f.sent.length, 1)
  await f.controller.shutdown()
})

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test(
  'cancel, session switch and shutdown during notification discovery prevent a late wakeup',
  { timeout: 5000 },
  async () => {
    /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
    for (const action of ['cancel', 'switch', 'shutdown']) {
      const f = fixture()
      const notices = []
      f.ctx.hasUI = true
      f.ctx.ui = { setStatus() {}, setWidget() {}, notify: (...args) => notices.push(args) }
      await f.controller.ensure(f.ctx)
      f.engines[0].tasks.push({ ...complete(), status: 'failed' })
      const entered = deferred(),
        discovery = deferred()
      f.engines[0].pendingNotifications = async () => {
        entered.resolve()
        return discovery.promise
      }
      const flush = f.controller.flush()
      await entered.promise
      let closing
      if (action === 'cancel') {
        await f.controller.stopAll()
      }
      if (action === 'switch') {
        f.ctx.sessionManager.getSessionId = () => 'parent-b'
      }
      if (action === 'shutdown') {
        closing = f.controller.shutdown()
      }
      discovery.resolve(f.engines[0].tasks)
      await flush
      await closing
      assert.equal(f.sent.length, 0, action)
      assert.equal(notices.length, 0, action)
      await f.controller.shutdown()
    }
    /* oxlint-enable no-await-in-loop */
  }
)

test('a canceled admission waiting for ensure never resumes notifications', async () => {
  const f = fixture()
  await f.controller.ensure(f.ctx)
  const gate = deferred(),
    entered = deferred()
  f.controller.ensure = async () => {
    entered.resolve()
    await gate.promise
    return f.engines[0]
  }
  const signal = new AbortController()
  const start = f.controller.start({}, 'call', signal.signal, f.ctx)
  await entered.promise
  signal.abort()
  await f.controller.stopAll()
  gate.resolve()
  await assert.rejects(start, { name: 'AbortError' })
  assert.equal(f.controller.suppressed, true)
  assert.deepEqual(
    f.entries.map((entry) => entry.data.paused),
    [true]
  )
  await f.controller.shutdown()
})

test('async send loss and cleared queues can retry without duplicating queued reports', async () => {
  const f = fixture()
  await f.controller.ensure(f.ctx)
  f.engines[0].tasks.push(complete())
  f.ctx.isIdle = () => true
  let queued = true
  f.ctx.hasPendingMessages = () => queued
  await f.controller.flush()
  f.controller.inFlight.set('t1', Date.now() - 2000)
  f.controller.retryAt.set('t1', Date.now() - 1)
  await f.controller.flush()
  assert.equal(f.sent.length, 1)
  queued = false
  await f.controller.flush()
  assert.equal(f.sent.length, 2)
  assert.equal(f.engines[0].tasks[0].notification_pending, true)
  await f.controller.shutdown()
})

test('receipt checks use disk even when Pi in-memory entries already contain the result', async (t) => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'controller-receipt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'parent.jsonl')
  await writeFile(file, '', { mode: 0o600 })
  const f = fixture([
    {
      type: 'custom_message',
      customType: RESULT_TYPE,
      details: { task_id: 't1', parent_id: 'parent-a' }
    }
  ])
  f.ctx.sessionManager.getSessionFile = () => file
  await f.controller.ensure(f.ctx)
  f.engines[0].tasks.push(complete())
  f.controller.receipt({
    customType: RESULT_TYPE,
    details: { task_id: 't1', parent_id: 'parent-a' }
  })
  await f.controller.reconcile()
  assert.equal(f.engines[0].tasks[0].notification_pending, true)
  await writeFile(file, JSON.stringify(f.entries[0]) + '\n', { mode: 0o600 })
  await f.controller.reconcile()
  assert.equal(f.engines[0].tasks[0].notification_pending, false)
  await f.controller.shutdown()
})

test('a malformed parent JSONL record does not block later durable receipts', async (t) => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'controller-receipt-torn-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'parent.jsonl')
  const result = {
    type: 'custom_message',
    customType: RESULT_TYPE,
    details: { task_id: 't1', parent_id: 'parent-a' }
  }
  await writeFile(file, '{"type":"torn"\n' + JSON.stringify(result) + '\n', { mode: 0o600 })
  const f = fixture()
  f.ctx.sessionManager.getSessionFile = () => file
  await f.controller.ensure(f.ctx)
  f.engines[0].tasks.push(complete())
  await f.controller.reconcile()
  assert.equal(
    f.engines[0].tasks[0].notification_pending,
    false,
    'a crashed append must not hide the valid receipt that follows it'
  )
  await f.controller.shutdown()
})

test('a failed owner close is retried before a replacement controller reuses the store', async () => {
  const f = fixture()
  await f.controller.ensure(f.ctx)
  const engine = f.engines[0]
  engine.tasks.push({ task_id: 'background', status: 'running' })
  const close = engine.close.bind(engine)
  let blocked = true
  engine.close = async () => {
    if (blocked) {
      throw new Error('CLOSE_UNCONFIRMED')
    }
    await close()
  }
  await assert.rejects(f.controller.shutdown(), /CLOSE_UNCONFIRMED/)
  assert.equal(f.controller.engine, undefined)
  await engine.options.notify()
  assert.equal(f.sent.length, 0, 'a failed close must still detach the old parent callbacks')
  let replacementFactories = 0
  const replacement = new TaskController(f.pi, {
    agentDir: '/agent',
    Engine: f.Engine,
    configLoader: async () => ({ maxConcurrency: 4, roles: {}, diagnostics: [] }),
    childFactory: () => {
      replacementFactories++
      return () => {}
    }
  })
  try {
    await assert.rejects(replacement.ensure(f.ctx), /CLOSE_UNCONFIRMED/)
    assert.equal(f.engines.length, 1, 'an unconfirmed close must not start a second engine')
    assert.equal(replacement.engine, undefined)
    blocked = false
    await replacement.ensure(f.ctx)
    assert.equal(engine.closed, true, 'the retained engine must be closed before replacement')
    assert.equal(f.engines.length, 2)
    assert.equal(replacement.engine, f.engines[1])
    assert.equal(replacementFactories, 1)
  } finally {
    blocked = false
    await replacement.shutdown()
  }
  assert.equal(f.engines[1].closed, true)
})

test('shutdown during initialization cannot leave a new task owner alive', async () => {
  const f = fixture()
  const entered = deferred(),
    config = deferred()
  f.controller.configLoader = async () => {
    entered.resolve()
    return config.promise
  }
  const opening = f.controller.ensure(f.ctx)
  await entered.promise
  const closing = f.controller.shutdown()
  config.resolve({ maxConcurrency: 4, roles: {}, diagnostics: [] })
  await assert.rejects(opening, { name: 'AbortError' })
  await closing
  assert.equal(f.controller.engine, undefined)
  assert.equal(f.engines.length, 0)
})

test('replacement extension instances reclaim detached engines without cross-session callbacks', async () => {
  const f = fixture()
  await f.controller.ensure(f.ctx)
  const engine = f.engines[0]
  engine.tasks.push({ task_id: 'background', status: 'running' })
  await f.controller.shutdown('new')
  assert.notEqual(engine.closed, true)
  await engine.options.notify()
  assert.equal(f.sent.length, 0)
  let replacementFactories = 0
  const replacement = new TaskController(f.pi, {
    agentDir: '/agent',
    configLoader: async () => ({ maxConcurrency: 4, roles: {}, diagnostics: [] }),
    childFactory: () => {
      replacementFactories++
      return () => {}
    }
  })
  try {
    await replacement.ensure(f.ctx)
    assert.equal(replacement.engine, engine)
    assert.equal(f.factories.length, 1)
    assert.equal(replacementFactories, 0)
    engine.tasks[0] = complete('background')
    await engine.options.notify()
    await replacement.flush()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0][0].details.parent_id, 'parent-a')
  } finally {
    await replacement.shutdown()
  }
  assert.equal(engine.closed, true)
})

test('admission snapshots the current inherited model and thinking, and reload continuation does not drift', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const agentDir = await mkdtemp(join(tmpdir(), 'controller-models-'))
  t.after(() => rm(agentDir, { recursive: true, force: true }))
  let thinking = 'high'
  const dispatched = []
  let factoryCalls = 0
  const base = { name: 'worker', instructions: '', tools: ['read'], timeoutMs: 0 }
  const pi = { ...runtimeAPI, getThinkingLevel: () => thinking, sendMessage() {}, appendEntry() {} }
  const options = {
    agentDir,
    configLoader: async () => ({
      maxConcurrency: 4,
      diagnostics: [],
      roles: {
        worker: base,
        verifier: { ...base, name: 'verifier', model: 'fake/fixed' },
        explore: { ...base, name: 'explore', thinking: 'medium' }
      }
    }),
    childFactory: () => {
      factoryCalls++
      return async ({ profile, sessionPath, onProfileResolved }) => {
        await onProfileResolved?.({ ...profile, skillSnapshot: [] })
        dispatched.push({ profile, sessionPath })
        return {
          sessionPath,
          async prompt() {
            return { text: 'done', outcome: { kind: 'returned', status: 'succeeded' } }
          },
          async steer() {},
          async abort() {},
          async dispose() {}
        }
      }
    }
  }
  const ctx = {
    cwd: agentDir,
    hasUI: false,
    model: { provider: 'fake', id: 'parent-a' },
    sessionManager: { getSessionId: () => 'snapshot-parent', getEntries: () => [] }
  }
  const input = { agent_name: 'worker', description: 'snapshot', prompt: 'work' }
  let controller = new TaskController(pi, options)
  try {
    const first = await controller.start(input, 'first', undefined, ctx)
    assert.equal(dispatched[0].profile.model, 'fake/parent-a')
    assert.equal(dispatched[0].profile.thinking, 'high')
    ctx.model = { provider: 'fake', id: 'parent-b' }
    thinking = 'low'
    await controller.start(input, 'second', undefined, ctx)
    assert.equal(dispatched[1].profile.model, 'fake/parent-b')
    assert.equal(dispatched[1].profile.thinking, 'low')
    await controller.start({ ...input, agent_name: 'verifier' }, 'role-model', undefined, ctx)
    assert.equal(dispatched[2].profile.model, 'fake/fixed')
    assert.equal(dispatched[2].profile.thinking, undefined)
    await controller.start({ ...input, model: 'fake/override' }, 'input-model', undefined, ctx)
    assert.equal(dispatched[3].profile.model, 'fake/override')
    assert.equal(dispatched[3].profile.thinking, undefined)
    await controller.start({ ...input, agent_name: 'explore' }, 'role-thinking', undefined, ctx)
    assert.equal(dispatched[4].profile.model, 'fake/parent-b')
    assert.equal(dispatched[4].profile.thinking, 'medium')
    await controller.start({ ...input, effort: 'high' }, 'explicit-effort', undefined, ctx)
    assert.equal(dispatched[5].profile.model, 'fake/parent-b')
    assert.equal(dispatched[5].profile.effort, 'high')
    assert.equal(
      dispatched[5].profile.thinking,
      undefined,
      'an override must not inherit a contradictory Pi level'
    )
    await controller.ensure(ctx)
    await controller.engine.query()
    await controller.ensure(ctx)
    assert.equal(factoryCalls, 1, 'all tasks and repeated queries share one factory')
    await controller.shutdown('reload')
    ctx.model = { provider: 'fake', id: 'parent-c' }
    thinking = 'xhigh'
    controller = new TaskController(pi, options)
    const continued = await controller.send(
      { task_id: first.task_id, content: 'continue' },
      'continuation',
      undefined,
      ctx
    )
    assert.equal(continued.session_id, first.session_id)
    assert.equal(dispatched[6].sessionPath, dispatched[0].sessionPath)
    assert.equal(dispatched[6].profile.model, 'fake/parent-a')
    assert.equal(dispatched[6].profile.thinking, 'high')
    assert.equal(factoryCalls, 2, 'reload creates exactly one replacement factory')
  } finally {
    await controller.shutdown()
  }
})

test('controller passes the public parent registry object into its one owner factory', async () => {
  const f = fixture()
  const registry = {
    getRegisteredProviderIds: () => [],
    getRegisteredProviderConfig: () => undefined,
    getRegisteredNativeProvider: () => undefined
  }
  f.ctx.modelRegistry = registry
  try {
    await f.controller.ensure(f.ctx)
    await f.controller.ensure(f.ctx)
    assert.equal(f.factories.length, 1)
    assert.equal(f.factories[0].inheritedModelRegistry, registry)
  } finally {
    await f.controller.shutdown()
  }
})

test('default controller factory forwards extension provider registry before model selection without a custom factory', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const agentDir = await mkdtemp(join(tmpdir(), 'controller-provider-registry-'))
  t.after(() => rm(agentDir, { recursive: true, force: true }))
  const calls = []
  const providerConfig = {
    api: 'openai-completions',
    baseUrl: 'https://example.invalid/offline',
    models: []
  }
  const registry = {
    getRegisteredProviderIds: () => {
      calls.push(['ids'])
      return ['extension-fixture']
    },
    getRegisteredProviderConfig: (id) => {
      calls.push(['config', id])
      return id === 'extension-fixture' ? providerConfig : undefined
    },
    getRegisteredNativeProvider: (id) => {
      calls.push(['native', id])
      return undefined
    }
  }
  let runtimeCreates = 0
  t.mock.method(ModelRuntime, 'create', async (options) => {
    runtimeCreates++
    assert.equal(options.authPath, agentDir + '/auth.json')
    assert.equal(options.allowModelNetwork, false)
    return {
      registerProvider: (id, config) => calls.push(['seed', id, config]),
      registerNativeProvider: (provider) => calls.push(['seed-native', provider]),
      getModel: (provider, id) => {
        calls.push(['lookup', provider, id])
        return undefined
      }
    }
  })
  const controller = new TaskController(
    { ...runtimeAPI, getThinkingLevel: () => 'off', sendMessage() {}, appendEntry() {} },
    {
      agentDir,
      configLoader: async () => ({
        roles: {
          worker: {
            name: 'worker',
            instructions: '',
            tools: ['read'],
            extensions: [],
            skills: [],
            mcp: false,
            timeoutMs: 0
          }
        },
        diagnostics: []
      })
    }
  )
  const ctx = {
    cwd: agentDir,
    hasUI: false,
    isProjectTrusted: () => false,
    model: { provider: 'extension-fixture', id: 'offline-model' },
    modelRegistry: registry,
    sessionManager: { getSessionId: () => 'extension-provider-parent', getEntries: () => [] }
  }
  try {
    const result = await controller.start(
      { agent_name: 'worker', description: 'registry path', prompt: 'offline' },
      'registry-call',
      undefined,
      ctx
    )
    // Stop at the mock lookup boundary: no auth files, provider requests, or SDK
    // sessions are created. The real default factory must seed before lookup.
    assert.equal(result.status, 'failed')
    assert.match(result.error, /Unknown child model: extension-fixture\/offline-model/)
    assert.equal(runtimeCreates, 1)
    const seed = calls.findIndex(([kind]) => kind === 'seed')
    const lookup = calls.findIndex(([kind]) => kind === 'lookup')
    assert.ok(seed >= 0, 'default createPiChildFactory must receive and seed the parent registry')
    assert.deepEqual(calls[seed], ['seed', 'extension-fixture', providerConfig])
    assert.ok(
      lookup > seed,
      'extension provider must be seeded before selecting the frozen provider/id'
    )
    assert.deepEqual(calls[lookup], ['lookup', 'extension-fixture', 'offline-model'])
  } finally {
    await controller.shutdown()
  }
})

test('SDK failure notices remain readable after terminal widgets disappear without another model message', async () => {
  /* oxlint-disable no-await-in-loop -- Each case owns and closes the same controller lease. */
  for (const status of ['failed', 'lost']) {
    const f = fixture()
    const { host, tui } = widgetHost()
    const manager = SessionManager.inMemory('/project')
    const queued = []
    const statuses = new Map()
    host.chatContainer = new Container()
    host.footerDataProvider = { setExtensionStatus: (key, value) => statuses.set(key, value) }
    tui.addChild(host.chatContainer)
    f.ctx.sessionManager = manager
    f.ctx.hasUI = true
    f.ctx.ui = {
      setStatus: (key, value) => host.setExtensionStatus(key, value),
      setWidget: (...args) => host.setExtensionWidget(...args),
      notify: (...args) => host.showExtensionNotify(...args)
    }
    f.pi.appendEntry = (type, data) => manager.appendCustomEntry(type, data)
    const sends = []
    f.pi.sendMessage = (message, options) => {
      f.sent.push([message, options])
      sends.push(
        AgentSession.prototype.sendCustomMessage.call(
          { isStreaming: true, agent: { followUp: (message) => queued.push(message) } },
          message,
          options
        )
      )
    }
    try {
      await f.controller.ensure(f.ctx)
      const task = { ...complete(), status: 'running', notification_pending: false }
      f.engines[0].tasks.push(task)
      await f.controller.updateUI()
      assert.match(statuses.get('task-agents'), /Agents 1/)
      assert.ok(host.widgetContainerAbove.render(80).length > 0)
      task.status = status
      task.notification_pending = true
      await f.controller.updateUI()
      assert.equal(statuses.get('task-agents'), undefined)
      assert.equal(host.widgetContainerAbove.render(80).join('').trim(), '')
      await Promise.all([f.controller.flush(), f.controller.flush()])
      await Promise.all(sends)
      assert.equal(queued.length, 1, 'only the existing followUp reaches the agent queue')
      assert.equal(queued[0].display, false)
      host.addMessageToChat(queued[0])
      for (const width of [20, 40, 80]) {
        const lines = host.chatContainer.render(width).map(stripTerminalSequences)
        const text = lines.join(' ').replace(/\s+/g, ' ')
        assert.match(text, new RegExp(`${status} task t1`))
        assert.match(text, /\/tasks list/)
        assert.ok(lines.every((line) => visibleWidth(line) <= width))
        assert.doesNotMatch(text, /succeeded/)
      }
      assert.deepEqual(
        manager.buildSessionContext().messages,
        [],
        'notice receipts add no model context'
      )
      assert.equal(manager.getEntries().length, 1)
      assert.equal(f.sent.length, 1)
      assert.equal(f.controller.uiTimer, undefined, 'no terminal animation or polling timer')
    } finally {
      await f.controller.shutdown()
      tui.stop()
    }
  }
  /* oxlint-enable no-await-in-loop */
})

test('SDK failure notice receipts survive disk reload without suppressing the native result notification', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'controller-notice-'))
  let manager = SessionManager.create('/project', dir)
  manager.appendMessage({ role: 'user', content: 'Fixture only', timestamp: Date.now() })
  const f = fixture()
  f.ctx.sessionManager = manager
  f.pi.appendEntry = (type, data) => manager.appendCustomEntry(type, data)
  const notices = []
  f.ctx.hasUI = true
  f.ctx.ui = { setStatus() {}, setWidget() {}, notify: (...args) => notices.push(args) }
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks.push({ ...complete(), status: 'failed' })
    await f.controller.flush()
    assert.equal(notices.length, 1)
    assert.equal(f.sent.length, 1)
    assert.equal(f.engines[0].tasks[0].notification_pending, true)
    await f.controller.shutdown('reload')
    manager = SessionManager.open(manager.getSessionFile())
    f.ctx.sessionManager = manager
    await f.controller.ensure(f.ctx)
    f.engines[1].tasks.push({ ...complete(), status: 'failed' })
    await f.controller.flush()
    assert.equal(notices.length, 1)
    assert.equal(f.sent.length, 2, 'an unreceipted owner message is still recoverable')
    const result = f.sent[1][0]
    manager.appendCustomMessageEntry(
      result.customType,
      result.content,
      result.display,
      result.details
    )
    await f.controller.flush()
    assert.equal(notices.length, 1)
    assert.equal(f.sent.length, 2)
    assert.equal(f.engines[1].tasks[0].notification_pending, false)
  } finally {
    await f.controller.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('visible failures follow pause, dialog and session ownership gates', async () => {
  const f = fixture([
    {
      type: 'custom',
      customType: 'pi-task-agents:failure-notice',
      data: { parent_id: 'other-parent', task_id: 't1' }
    }
  ])
  const notices = []
  f.ctx.hasUI = true
  f.ctx.ui = { setStatus() {}, setWidget() {}, notify: (...args) => notices.push(args) }
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks.push({ ...complete(), status: 'lost' })
    f.controller.pause()
    await f.controller.flush()
    f.controller.resume()
    f.controller.dialogOpen = true
    await f.controller.flush()
    f.controller.dialogOpen = false
    f.ctx.sessionManager.getSessionId = () => 'parent-b'
    await f.controller.flush()
    assert.equal(notices.length, 0)
    assert.equal(f.sent.length, 0)
    f.ctx.sessionManager.getSessionId = () => 'parent-a'
    await f.controller.flush()
    assert.equal(notices.length, 1)
    assert.equal(f.sent.length, 1)
  } finally {
    await f.controller.shutdown()
  }
})

test('restored result receipts, foreground failures and ordinary terminal states are not re-announced', async () => {
  const f = fixture([
    {
      type: 'custom_message',
      customType: RESULT_TYPE,
      details: { task_id: 'seen', parent_id: 'parent-a' }
    }
  ])
  const notices = []
  f.ctx.hasUI = true
  f.ctx.ui = { setStatus() {}, setWidget() {}, notify: (...args) => notices.push(args) }
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks.push(
      { ...complete('seen'), status: 'failed' },
      { ...complete('foreground'), status: 'failed', notification_pending: false },
      { ...complete('canceled'), status: 'canceled' },
      { ...complete('success'), verification: { modelVerdict: 'fail' } }
    )
    await f.controller.flush()
    assert.equal(notices.length, 0)
    assert.equal(f.sent.length, 1, 'both unread terminal tasks share one notice')
    assert.equal(f.entries.length, 1)
  } finally {
    await f.controller.shutdown()
  }
})

test('headless failure delivery creates no visual receipt and unavailable UI does not block the owner', async () => {
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks.push({ ...complete(), status: 'failed' })
    await f.controller.flush()
    assert.equal(f.entries.length, 0)
    assert.equal(f.sent.length, 1)
    makeRetryDue(f, 't1')
    f.ctx.hasUI = true
    f.ctx.ui = {
      notify() {
        throw new Error('UI unavailable')
      }
    }
    await f.controller.flush()
    assert.equal(f.sent.length, 2)
  } finally {
    f.ctx.hasUI = false
    await f.controller.shutdown()
  }
})

test('warnings stay best-effort when the UI context is unavailable', async () => {
  const f = fixture()
  f.ctx.hasUI = true
  f.ctx.ui = {
    setStatus() {},
    setWidget() {},
    notify() {
      throw new Error('UI unavailable')
    }
  }
  try {
    await f.controller.ensure(f.ctx)
    assert.doesNotThrow(() => f.controller.warn(new Error('fixture warning')))
  } finally {
    f.ctx.hasUI = false
    await f.controller.shutdown()
  }
})

test('failure text excludes diagnostics and escapes untrusted IDs, and receipt write failure cannot block delivery', async () => {
  const f = fixture()
  const notices = []
  f.ctx.hasUI = true
  f.ctx.ui = { setStatus() {}, setWidget() {}, notify: (...args) => notices.push(args) }
  const append = f.pi.appendEntry
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks.push({
      ...complete('task\u001B[31m\n\u202E-id'),
      status: 'failed',
      error: 'PRIVATE_DIAGNOSTICS',
      description: 'PRIVATE_DESCRIPTION'
    })
    f.pi.appendEntry = () => {
      throw new Error('Receipt storage unavailable')
    }
    await f.controller.flush()
    assert.equal(f.sent.length, 1)
    assert.equal(notices.length, 0)
    f.pi.appendEntry = append
    makeRetryDue(f, f.engines[0].tasks[0].task_id)
    await f.controller.flush()
    assert.equal(notices.length, 1)
    assert.match(notices[0][0], /failed task task\?\?31m\?\?-id/)
    assert.doesNotMatch(notices[0][0], /PRIVATE_/)
    assert.ok(['\u001B', '\n', '\u202E'].every((character) => !notices[0][0].includes(character)))
    makeRetryDue(f, f.engines[0].tasks[0].task_id)
    await f.controller.flush()
    assert.equal(notices.length, 1)
    assert.equal(f.sent.length, 3, 'an unreceipted notice remains retryable')
  } finally {
    await f.controller.shutdown()
  }
})

test('task UI omits absent or unbounded capacity instead of showing undefined or Infinity', async () => {
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const cap of [undefined, Infinity, 4]) {
    const f = fixture()
    const statuses = []
    f.ctx.hasUI = true
    f.ctx.ui = { setStatus: (key, text) => statuses.push(text), setWidget() {}, notify() {} }
    f.controller.configLoader = async () => ({
      ...(cap === undefined ? {} : { maxConcurrency: cap }),
      roles: {},
      diagnostics: []
    })
    try {
      await f.controller.ensure(f.ctx)
      f.engines[0].tasks.push({ task_id: 'running', status: 'running' })
      await f.controller.updateUI()
      assert.equal(statuses.at(-1), cap === 4 ? 'Agents 1/4' : 'Agents 1')
    } finally {
      await f.controller.shutdown()
    }
  }
  /* oxlint-enable no-await-in-loop */
})

for (const mode of ['tui', 'rpc']) {
  test(`${mode} UI shows the real default /4 capacity and queues the fifth task`, async (t) => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'controller-default-capacity-'))
    const statuses = []
    const widgets = []
    const children = []
    const { host, tui } = widgetHost(80)
    const controller = new TaskController(
      { ...runtimeAPI, getThinkingLevel: () => 'high', sendMessage() {}, appendEntry() {} },
      {
        agentDir: root,
        // Use the production config loader and engine, with only model execution held offline.
        childFactory: () => async () => {
          let finish
          const child = {
            prompt: () =>
              new Promise((resolve) => {
                finish = resolve
              }),
            async steer() {},
            async abort() {
              finish?.({ text: 'Stopped offline fixture' })
            },
            async dispose() {}
          }
          children.push(child)
          return child
        }
      }
    )
    t.after(async () => {
      await controller.shutdown()
      tui.stop()
      await rm(root, { recursive: true, force: true })
    })
    const ctx = {
      cwd: root,
      mode,
      hasUI: true,
      model: { provider: 'fixture', id: 'offline' },
      isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => `default-capacity-${mode}`, getEntries: () => [] },
      ui: {
        setStatus: (_key, value) => statuses.push(value),
        setWidget(key, value) {
          widgets.push(value)
          if (mode === 'tui') {
            host.setExtensionWidget(key, value)
          }
        },
        notify() {}
      }
    }
    const start = (index) =>
      controller.start(
        {
          agent_name: 'worker',
          description: `Capacity task ${index}`,
          prompt: 'Hold this offline fixture',
          run_in_background: true
        },
        `default-${index}`,
        undefined,
        ctx
      )
    await start(1)
    await controller.updateUI()
    assert.equal(controller.config.maxConcurrency, 4)
    assert.deepEqual(controller.config.sources, [], 'no configured concurrency override')
    assert.equal(statuses.at(-1), 'Agents 1/4')
    for (const index of [2, 3, 4, 5]) {
      // oxlint-disable-next-line no-await-in-loop -- Admission order defines which task is fifth.
      await start(index)
    }
    const tasks = await controller.engine.query()
    await controller.updateUI()
    assert.deepEqual(
      tasks.map((task) => task.status),
      ['running', 'running', 'running', 'running', 'queued']
    )
    assert.equal(children.length, 4, 'the queued fifth task has no child execution')
    assert.equal(statuses.at(-1), 'Agents 4/4 · queued 1')
    const content = widgets.at(-1)
    assert.equal(typeof content, mode === 'tui' ? 'function' : 'object')
    const rows =
      mode === 'tui'
        ? host.widgetContainerAbove.render(80).slice(1).map(stripTerminalSequences)
        : content
    assert.equal(rows.length, 5)
    for (const [index, task] of tasks.entries()) {
      assert.ok(rows[index].includes(task.task_id.slice(0, 8)))
      assert.ok(rows[index].includes(`Capacity task ${index + 1}`))
      assert.doesNotMatch(rows[index], /(?:last|activity):/)
    }
    assert.match(rows[4], /^queued · worker · /)
    if (mode === 'tui') {
      assert.ok(rows.slice(0, 4).every((row) => !row.startsWith('running · ')))
      assert.ok(rows.every((row) => visibleWidth(row) <= 80))
    } else {
      assert.ok(Array.isArray(content), 'RPC receives only serializable text rows')
      assert.deepEqual(rows, rows.map(stripTerminalSequences))
    }
  })
}

test('task UI separates queued work from occupied capacity and includes current activity', async () => {
  const f = fixture(),
    statuses = [],
    widgets = []
  f.ctx.hasUI = true
  f.ctx.ui = {
    setStatus: (_key, value) => statuses.push(value),
    setWidget: (_key, value) => widgets.push(value),
    notify() {}
  }
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks.push(
      {
        task_id: 'running',
        status: 'running',
        agent_name: 'worker',
        description: 'Build',
        started_at: new Date(Date.now() - 5000).toISOString(),
        activity: 'bash: running'
      },
      {
        task_id: 'queued',
        status: 'queued',
        agent_name: 'worker',
        description: 'Wait',
        created_at: new Date().toISOString()
      }
    )
    await f.controller.updateUI()
    assert.equal(statuses.at(-1), 'Agents 1/4 · queued 1')
    assert.match(widgetLines(widgets.at(-1)).join('\n'), /bash: running/)
    assert.ok(f.controller.uiTimer)
    await f.controller.shutdown()
    assert.equal(f.controller.uiTimer, undefined)
  } finally {
    await f.controller.shutdown()
  }
})

test('terminal cleanup holds stay visible and running tasks are not hidden behind the queue', async () => {
  const f = fixture(),
    statuses = [],
    widgets = []
  f.ctx.hasUI = true
  f.ctx.ui = {
    setStatus: (_key, value) => statuses.push(value),
    setWidget: (_key, value) => widgets.push(value),
    notify() {}
  }
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks.push(
      {
        task_id: 'cleanup',
        status: 'canceled',
        agent_name: 'worker',
        description: 'Owned cleanup',
        cleanup_pending: true
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        task_id: `q${i}`,
        status: 'queued',
        agent_name: 'worker',
        description: 'Waiting'
      }))
    )
    await f.controller.updateUI()
    assert.equal(statuses.at(-1), 'Agents 1/4 · queued 8 · cleanup pending 1')
    const lines = widgetLines(widgets.at(-1))
    assert.match(lines[0], /Owned cleanup/)
    assert.match(lines[0], /cleanup pending/)
    assert.equal(lines.length, 7)
    assert.equal(lines[6], '3 more tasks · /tasks list')
  } finally {
    await f.controller.shutdown()
  }
})

test('SDK task widget bounds CJK rows, prioritizes cleanup and retains hidden counts', async () => {
  const f = fixture()
  const { host, tui } = widgetHost()
  f.ctx.hasUI = true
  f.ctx.ui = {
    setStatus() {},
    setWidget: (...args) => host.setExtensionWidget(...args),
    notify() {}
  }
  try {
    const engine = await f.controller.ensure(f.ctx)
    engine.tasks = [
      {
        task_id: 'cleanup',
        status: 'failed',
        cleanup_pending: true,
        agent_name: 'worker',
        description: '长中文任务'.repeat(100),
        stopError: { code: 'CHILD_CLEANUP_FAILED', message: 'dispose failed' }
      },
      {
        task_id: 'active',
        status: 'running',
        agent_name: 'worker',
        description: '长中文任务'.repeat(100),
        activity: 'bash: running'
      },
      ...Array.from({ length: 7 }, (_, i) => ({ task_id: `q${i}`, status: 'queued' }))
    ]
    const original = JSON.stringify(engine.tasks)
    await f.controller.updateUI()
    for (const width of [20, 40, 60, 80, 120, 240]) {
      const lines = host.widgetContainerAbove.render(width).slice(1).map(stripTerminalSequences)
      assert.ok(lines.length <= 8, `${width}: ${lines.length} rows`)
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `${width}: column overflow`
      )
      assert.match(lines.slice(0, 2).join('\n'), /failed/)
      assert.match(lines.slice(0, 2).join('\n'), /cleanup pending/)
      assert.match(lines.at(-1), /3 more.*\/tasks list/)
      if (width >= 40) {
        assert.match(lines[0], /cleanup/)
        assert.match(lines[1], /worker.*active.*长中文任务/)
        if (width >= 60) {
          assert.match(lines[1], /bash: running$/, 'activity shares space with long goals')
        } else {
          assert.doesNotMatch(lines[1], /bash:/, 'narrow rows retain identity and goal')
        }
      }
      if (width >= 80) {
        assert.match(lines[0], /dispose failed/)
      }
    }
    const runningRow = host.widgetContainerAbove.render(80).map(stripTerminalSequences)[2]
    engine.tasks[1].activity = 'bash: done'
    await f.controller.updateUI()
    const doneRow = host.widgetContainerAbove.render(80).map(stripTerminalSequences)[2]
    assert.notEqual(doneRow, runningRow)
    assert.match(doneRow, /^worker.*active.*长中文任务.* · bash: done$/)
    engine.tasks[1].activity = 'bash: running'
    for (const width of [0, 1, 2, 3, 7, 14, 19]) {
      const component = host.extensionWidgetsAbove.get('task-agents')
      const lines = component.render(width)
      assert.ok(lines.length <= 13)
      assert.ok(lines.every((line) => visibleWidth(line) <= width))
      if (width === 0) {
        assert.deepEqual(lines, [])
      }
    }
    assert.equal(
      JSON.stringify(await engine.query()),
      original,
      '/tasks list retains full summaries'
    )
    engine.tasks = [
      'failed',
      'canceled',
      'succeeded',
      'stopping',
      'running',
      'queued',
      'queued'
    ].map((status, i) => ({ task_id: `held${i}`, status, cleanup_pending: true }))
    await f.controller.updateUI()
    const held = host.extensionWidgetsAbove.get('task-agents')
    const narrow = held.render(20).map(stripTerminalSequences)
    assert.equal(narrow.length, 13, 'at most two rows per visible task plus the hidden count')
    assert.equal(narrow.filter((line) => line.includes('cleanup pending')).length, 6)
    assert.match(narrow.at(-1), /1 more.*\/tasks list/)
    assert.equal(held.render(40).length, 7)
  } finally {
    await f.controller.shutdown()
    tui.stop()
  }
})

test('SDK cleanup rows identify tasks before identical long errors at 20/40/80 columns', async () => {
  const f = fixture()
  const { host, tui } = widgetHost()
  f.ctx.hasUI = true
  f.ctx.ui = {
    setStatus() {},
    setWidget: (...args) => host.setExtensionWidget(...args),
    notify() {}
  }
  try {
    const engine = await f.controller.ensure(f.ctx)
    engine.tasks = ['alpha123-rest', 'bravo456-rest'].map((id) => ({
      task_id: id,
      status: 'failed',
      cleanup_pending: true,
      description: `Different task ${id}`,
      error: 'Cannot confirm cleanup '.repeat(30)
    }))
    await f.controller.updateUI()
    const component = host.extensionWidgetsAbove.get('task-agents')
    for (const width of [20, 40, 60, 80, 120]) {
      const rows = component.render(width).map(stripTerminalSequences)
      const perTask = rows.length / 2
      const first = rows.slice(0, perTask).join('\n')
      const second = rows.slice(perTask).join('\n')
      assert.match(first, /alpha123/, `${width}: first identity`)
      assert.match(second, /bravo456/, `${width}: second identity`)
      for (const text of [first, second]) {
        if (width >= 80) {
          assert.match(text, /Cannot/)
        }
        assert.match(text, /failed/)
        assert.match(text, /cleanup pending/)
        if (text.includes('Cannot')) {
          assert.ok(text.search(/alpha123|bravo456/) < text.indexOf('Cannot'))
        }
      }
      assert.notEqual(first, second)
      assert.ok(rows.every((line) => visibleWidth(line) <= width))
    }
  } finally {
    await f.controller.shutdown()
    tui.stop()
  }
})

test('SDK task selection promotes cleanup at the end without placing queued work ahead of running', async () => {
  const f = fixture()
  const { host, tui } = widgetHost()
  f.ctx.hasUI = true
  f.ctx.ui = {
    setStatus() {},
    setWidget: (...args) => host.setExtensionWidget(...args),
    notify() {}
  }
  try {
    const engine = await f.controller.ensure(f.ctx)
    engine.tasks = [
      { task_id: 'queued', status: 'queued' },
      ...Array.from({ length: 6 }, (_, i) => ({ task_id: `run${i}`, status: 'running' })),
      { task_id: 'cleanup', status: 'failed', cleanup_pending: true }
    ]
    await f.controller.updateUI()
    const rows = host.extensionWidgetsAbove
      .get('task-agents')
      .render(80)
      .map(stripTerminalSequences)
    assert.match(rows[0], /cleanup pending/)
    assert.match(rows[0], /cleanup/)
    assert.ok(rows.slice(1, 6).every((row, index) => row.startsWith(`run${index}`)))
    assert.match(rows.at(-1), /2 more tasks.*\/tasks list/)
    assert.equal(rows.length, 7)
  } finally {
    await f.controller.shutdown()
    tui.stop()
  }
})

test('SDK task widget preserves grapheme prefixes and follows live themes on invalidation', async (t) => {
  const previous = process.env.NO_COLOR
  delete process.env.NO_COLOR
  t.after(() => {
    if (previous === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = previous
    }
    initTheme('dark', false)
  })
  const f = fixture()
  const { host, tui } = widgetHost()
  f.ctx.hasUI = true
  f.ctx.ui = {
    setStatus() {},
    setWidget: (...args) => host.setExtensionWidget(...args),
    notify() {}
  }
  try {
    const engine = await f.controller.ensure(f.ctx)
    const description = '中'.repeat(99) + '👩‍🚒🇨🇳é✊🏽😀 tail'
    engine.tasks = [{ task_id: 'active', status: 'running', description }]
    await f.controller.updateUI()
    const component = host.extensionWidgetsAbove.get('task-agents')
    const full = component.render(1000).map(stripTerminalSequences)
    assert.ok(full[0].endsWith(description))
    const prefixes = new Set([''])
    let prefix = ''
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      full[0]
    )) {
      prefix += segment
      prefixes.add(prefix)
    }
    for (let width = 0; width <= 240; width++) {
      const lines = component.render(width).map(stripTerminalSequences)
      assert.equal(lines.length, width ? 1 : 0)
      for (const line of lines) {
        assert.ok(line.isWellFormed())
        assert.ok(visibleWidth(line) <= width)
        assert.ok(prefixes.has(line.replace(/…$/, '')), `grapheme split at ${width}`)
      }
    }
    engine.tasks[0].activity = 'bash: failed'
    const dark = component.render(80)
    assert.match(dark.map(stripTerminalSequences).join('\n'), /bash: failed$/)
    initTheme('light', false)
    component.invalidate()
    const light = component.render(80)
    assert.notDeepEqual(light, dark)
    assert.deepEqual(light.map(stripTerminalSequences), dark.map(stripTerminalSequences))
    assert.match(light.map(stripTerminalSequences).join('\n'), /^active · /)
  } finally {
    await f.controller.shutdown()
    tui.stop()
  }
})

test('real SDK terminal writes contain no untrusted C0/C1 controls from task fields', () => {
  const previous = process.env.NO_COLOR
  const controls = '\u009B\u009D\u009C\u0085\u0007'
  const tasks = [
    {
      task_id: `id${controls}123456-rest`,
      status: 'running',
      agent_name: `role${controls}tail`,
      description: `goal${controls}tail`,
      activity: `tool${controls}tail: running`
    },
    {
      task_id: 'error123-rest',
      status: 'failed',
      agent_name: 'worker',
      description: 'Error goal',
      error: `error${controls}tail`
    },
    {
      task_id: 'cleanup1-rest',
      status: 'failed',
      cleanup_pending: true,
      agent_name: 'worker',
      description: 'Cleanup goal',
      stopError: { code: 'CHILD_CLEANUP_FAILED', message: `cleanup${controls}tail` }
    }
  ]
  const original = JSON.stringify(tasks)
  try {
    for (const appearance of ['dark', 'light', 'no-color']) {
      if (appearance === 'no-color') {
        process.env.NO_COLOR = '1'
      } else {
        delete process.env.NO_COLOR
      }
      for (const width of [20, 40, 80, 120]) {
        const { host, tui, writes } = widgetHost(width)
        initTheme(appearance === 'light' ? 'light' : 'dark', false)
        try {
          host.setExtensionWidget('task-agents', (_tui, theme) => taskWidget(tasks, 0, theme))
          tui.renderNow()
          const output = writes.join('')
          assert.ok(output.length > 0, 'inspect terminal.write, not only component strings')
          assert.doesNotMatch(output, /[\u0080-\u009F]/u, `${appearance}/${width}`)
          const plain = stripTerminalSequences(output)
          assert.ok(!plain.includes('\u0007'), 'only SDK-owned OSC resets may contain BEL')
          if (width === 120) {
            for (const field of ['role', 'goal', 'tool', 'error', 'cleanup']) {
              assert.ok(plain.includes(`${field} tail`), `${appearance}: sanitized ${field}`)
            }
          }
        } finally {
          tui.stop()
        }
      }
    }
    assert.equal(JSON.stringify(tasks), original, 'display sanitation leaves full summaries intact')
  } finally {
    if (previous === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = previous
    }
    initTheme('dark', false)
  }
})

test('SDK task widget refresh uses differential rendering and only the existing polling timer', async (t) => {
  const f = fixture()
  const { host, tui, terminal, writes } = widgetHost(80)
  f.ctx.hasUI = true
  f.ctx.ui = {
    setStatus() {},
    setWidget: (...args) => host.setExtensionWidget(...args),
    notify() {}
  }
  try {
    const engine = await f.controller.ensure(f.ctx)
    engine.tasks = [{ task_id: 'active', status: 'running', description: '中文👩‍🚒é'.repeat(30) }]
    const timeout = t.mock.method(globalThis, 'setTimeout')
    const interval = t.mock.method(globalThis, 'setInterval')
    await f.controller.updateUI()
    tui.renderNow()
    assert.ok(writes.join('').includes('active'))
    const redraws = tui.fullRedraws
    writes.length = 0
    await f.controller.updateUI()
    tui.renderNow()
    assert.equal(writes.join(''), '', 'unchanged content must not repaint')
    assert.equal(tui.fullRedraws, redraws)
    assert.deepEqual(
      timeout.mock.calls.map((call) => call.arguments[1]),
      [1000]
    )
    assert.equal(interval.mock.calls.length, 0)
    assert.ok(f.controller.uiTimer)
    engine.tasks[0].activity = 'read: running'
    await f.controller.updateUI()
    tui.renderNow()
    assert.match(stripTerminalSequences(writes.join('')), /read: running/)
    assert.equal(tui.fullRedraws, redraws, 'activity changes must not force a full repaint')
    assert.equal(writes.join('').includes('\u001B[2J'), false)
    writes.length = 0
    engine.tasks[0].activity = 'read: done'
    await f.controller.updateUI()
    tui.renderNow()
    assert.match(stripTerminalSequences(writes.join('')), /read: done/)
    assert.doesNotMatch(stripTerminalSequences(writes.join('')), /(?:last|activity):/)
    assert.match(host.widgetContainerAbove.render(80).map(stripTerminalSequences)[1], /^active · /)
    assert.equal(tui.fullRedraws, redraws)
    assert.deepEqual(
      timeout.mock.calls.map((call) => call.arguments[1]),
      [1000]
    )
    assert.equal(interval.mock.calls.length, 0)
    terminal.columns = 20
    tui.renderNow()
    assert.ok(tui.render(20).every((line) => visibleWidth(line) <= 20))
    engine.tasks = []
    await f.controller.updateUI()
    assert.equal(f.controller.uiTimer, undefined)
    assert.equal(host.extensionWidgetsAbove.size, 0)
  } finally {
    await f.controller.shutdown()
    tui.stop()
  }
})

test('owner factory reuse rejects trust changes until explicit reload', async () => {
  const f = fixture()
  try {
    const engine = await f.controller.ensure(f.ctx)
    await f.controller.ensure(f.ctx)
    assert.equal(f.factories.length, 1)
    f.ctx.isProjectTrusted = () => true
    await assert.rejects(f.controller.ensure(f.ctx), /project trust changed; reload/)
    assert.equal(f.factories.length, 1)
    assert.equal(f.controller.engine, engine)
    await f.controller.shutdown('reload')
    await f.controller.ensure(f.ctx)
    assert.equal(f.factories.length, 2)
    assert.equal(f.factories[1].projectTrusted, true)
    assert.equal(engine.closed, true)
  } finally {
    await f.controller.shutdown()
  }
})

test('co-terminal notifications merge into one model-visible message and one receipt', async () => {
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks.push(complete('t1'), complete('t2'))
    await f.controller.flush()
    assert.equal(f.sent.length, 1)
    const [message, options] = f.sent[0]
    assert.match(message.content, /Child tasks finished \(2\)/)
    assert.match(message.content, /t1 \(worker\) succeeded/)
    assert.match(message.content, /t2 \(worker\) succeeded/)
    assert.match(message.content, /Use task_output/)
    assert.deepEqual(message.details, { task_ids: ['t1', 't2'], parent_id: 'parent-a' })
    assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' })
    f.entries.push({ type: 'custom_message', ...message })
    await f.controller.reconcile()
    assert.equal(
      f.engines[0].tasks.some((task) => task.notification_pending),
      false
    )
  } finally {
    await f.controller.shutdown()
  }
})

test('notification batches stay bounded while every terminal task is delivered', async () => {
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    const tasks = Array.from({ length: 33 }, (_, index) =>
      complete(`t${index.toString().padStart(2, '0')}`)
    )
    f.engines[0].tasks.push(...tasks)
    await f.controller.flush()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0][0].details.task_ids.length, 32)
    await f.controller.flush()
    assert.equal(f.sent.length, 2)
    assert.equal(f.sent[1][0].details.task_id, 't32')
  } finally {
    await f.controller.shutdown()
  }
})

test('unsent notices retry at 1/2/5 seconds, cool down to a cap, and stop at the persisted receipt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    f.ctx.isIdle = () => true
    f.ctx.hasPendingMessages = () => false
    f.engines[0].tasks.push(complete())
    await f.controller.flush()
    assert.equal(f.sent.length, 1)
    assert.equal(f.controller.retryAt.get('t1'), 1000)

    const advance = async (ms) => {
      t.mock.timers.tick(ms)
      await f.controller.flush()
    }
    await advance(1000)
    assert.equal(f.sent.length, 2)
    assert.equal(f.controller.retryAt.get('t1'), 3000)
    await advance(1000)
    assert.equal(f.sent.length, 2)
    await advance(1000)
    assert.equal(f.sent.length, 3)
    assert.equal(f.controller.retryAt.get('t1'), 8000)
    await advance(5000)
    assert.equal(f.sent.length, 3, 'the fourth turn waits for the delivery window')
    assert.equal(f.controller.retryAt.get('t1'), 8000)
    await advance(52001)
    assert.equal(f.sent.length, 4)
    assert.equal(f.controller.retryAt.get('t1'), 120001)
    await advance(60000)
    assert.equal(f.sent.length, 5)
    assert.equal(f.controller.retryAt.get('t1'), 240001)
    await advance(120000)
    assert.equal(f.sent.length, 6)
    assert.equal(f.controller.retryAt.get('t1'), 480001)
    await advance(240000)
    assert.equal(f.sent.length, 7)
    assert.equal(f.controller.retryAt.get('t1'), 780001)
    await advance(300000)
    assert.equal(f.sent.length, 8)
    assert.equal(f.controller.retryAt.get('t1'), 1080001)

    f.entries.push({ type: 'custom_message', ...f.sent.at(-1)[0] })
    await f.controller.reconcile()
    assert.equal(f.engines[0].tasks[0].notification_pending, false)
    await advance(300000)
    assert.equal(f.sent.length, 8)
  } finally {
    await f.controller.shutdown()
  }
})

test('resume clears a long cooldown and pause disarms its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    f.ctx.isIdle = () => true
    f.ctx.hasPendingMessages = () => false
    f.engines[0].tasks.push(complete())
    await f.controller.flush()
    /* oxlint-disable no-await-in-loop -- Fast retries must advance through their timers in order. */
    for (const delay of [1000, 2000, 5000]) {
      t.mock.timers.tick(delay)
      await f.controller.flush()
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(f.sent.length, 3)
    assert.equal(f.controller.retryAt.get('t1'), 8000)
    f.controller.pause()
    assert.equal(f.controller.retryTimer, undefined)
    assert.equal(f.controller.burstTimer, undefined)
    assert.equal(f.engines[0].tasks[0].notification_pending, true)
    f.controller.resume()
    assert.equal(f.controller.retryAt.has('t1'), false)
    makeRetryDue(f, 't1')
    await f.controller.flush()
    assert.equal(f.sent.length, 3, 'resume does not bypass the delivery window')
    t.mock.timers.tick(52001)
    await f.controller.flush()
    assert.equal(f.sent.length, 4)
    assert.equal(f.controller.attempts.get('t1'), 1)
  } finally {
    await f.controller.shutdown()
  }
})

test('delivery turns are capped per minute and deferred terminals merge into the next window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture()
  try {
    await f.controller.ensure(f.ctx)
    const deliver = async (id) => {
      f.engines[0].tasks.push(complete(id))
      await f.controller.flush()
      f.entries.push({ type: 'custom_message', ...f.sent.at(-1)[0] })
      await f.controller.reconcile()
    }
    await deliver('t1')
    await deliver('t2')
    await deliver('t3')
    assert.equal(f.sent.length, 3)
    f.engines[0].tasks.push(complete('t4'))
    await f.controller.flush()
    assert.equal(f.sent.length, 3, 'the fourth delivery turn waits for the window')
    assert.notEqual(f.controller.burstTimer, undefined)
    assert.equal(f.engines[0].tasks[3].notification_pending, true)

    f.engines[0].tasks.push(complete('t5'))
    t.mock.timers.tick(60001)
    await f.controller.flush()
    assert.equal(f.sent.length, 4)
    assert.deepEqual(f.sent[3][0].details.task_ids, ['t4', 't5'])
    assert.equal(f.controller.burstDelivered, 1)

    f.entries.push({ type: 'custom_message', ...f.sent[3][0] })
    await f.controller.reconcile()
    f.engines[0].tasks.push(complete('t6'))
    await f.controller.flush()
    assert.equal(f.sent.length, 5, 'a fresh window allows another delivery turn')
  } finally {
    await f.controller.shutdown()
  }
})

test('real TaskEngine lifecycle releases the store and reopens persisted tasks after shutdown', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const agentDir = await mkdtemp(join(tmpdir(), 'controller-real-lifecycle-'))
  t.after(() => rm(agentDir, { recursive: true, force: true }))
  const profile = { name: 'worker', instructions: '', tools: ['read'], timeoutMs: 0 }
  let disposed = 0
  const setup = () => {
    const controller = new TaskController(
      { ...runtimeAPI, getThinkingLevel: () => 'off', sendMessage() {}, appendEntry() {} },
      {
        agentDir,
        configLoader: async () => ({
          maxConcurrency: 2,
          roles: { worker: profile },
          diagnostics: []
        }),
        childFactory:
          () =>
          async ({ sessionPath }) => ({
            sessionPath,
            prompt: async () => ({
              text: 'real lifecycle',
              outcome: { kind: 'returned', status: 'succeeded' }
            }),
            steer: async () => {},
            abort: async () => {},
            dispose: async () => {
              disposed++
            }
          })
      }
    )
    const ctx = {
      cwd: agentDir,
      hasUI: false,
      model: { provider: 'fake', id: 'parent' },
      sessionManager: { getSessionId: () => 'real-parent', getEntries: () => [] }
    }
    return { controller, ctx }
  }
  const first = setup()
  const task = await first.controller.start(
    { agent_name: 'worker', description: 'real lifecycle', prompt: 'work' },
    'real-lifecycle',
    undefined,
    first.ctx
  )
  assert.equal(task.status, 'succeeded')
  await first.controller.shutdown()
  assert.equal(disposed, 1)
  const second = setup()
  try {
    await second.controller.ensure(second.ctx)
    assert.equal(
      (await second.controller.engine.query({ task_id: task.task_id })).status,
      'succeeded'
    )
    assert.equal((await second.controller.engine.query()).length, 1)
  } finally {
    await second.controller.shutdown()
  }
})

test('initialization timeout wakes the owning controller after persisting its cleanup report', async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), 'controller-initialization-notice-'))
  t.after(() => rm(agentDir, { recursive: true, force: true }))
  const entered = deferred(),
    factory = deferred(),
    disposing = deferred(),
    cleanup = deferred(),
    notified = deferred()
  const entries = [],
    messages = []
  let prompts = 0
  const controller = new TaskController(
    {
      ...runtimeAPI,
      getThinkingLevel: () => 'off',
      appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
      sendMessage: (...args) => {
        messages.push(args)
        notified.resolve()
      }
    },
    {
      agentDir,
      configLoader: async () => ({
        maxConcurrency: 1,
        roles: {
          worker: { name: 'worker', instructions: '', tools: [], timeoutMs: 1000 }
        },
        diagnostics: []
      }),
      childFactory:
        () =>
        async ({ sessionPath }) => {
          entered.resolve()
          await factory.promise
          return {
            sessionPath,
            prompt: async () => {
              prompts++
              return { text: 'must not run', outcome: { kind: 'returned', status: 'succeeded' } }
            },
            steer: async () => {},
            abort: async () => {},
            dispose: async () => {
              disposing.resolve()
              await cleanup.promise
            }
          }
        }
    }
  )
  const ctx = {
    cwd: agentDir,
    mode: 'tui',
    hasUI: false,
    model: { provider: 'fake', id: 'parent' },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'initialization-parent', getEntries: () => entries }
  }
  try {
    const task = await controller.start(
      {
        agent_name: 'worker',
        description: 'initialization notice',
        prompt: 'offline',
        run_in_background: true
      },
      'initialization-notice',
      undefined,
      ctx
    )
    const engine = controller.engine
    await bounded(entered.promise, 4000, 'child factory entry')
    const runtime = engine.runtimes.get(task.task_id)
    await bounded(notified.promise, 4000, 'initialization timeout notification')
    assert.equal(prompts, 0)
    assert.equal(engine.runtimes.get(task.task_id), runtime)
    assert.equal(messages[0][0].details.parent_id, 'initialization-parent')
    assert.equal(messages[0][0].details.task_id, task.task_id)
    assert.match(messages[0][0].content, /cleanup_pending: true/)
    assert.deepEqual(messages[0][1], { triggerTurn: true, deliverAs: 'followUp' })
    const before = JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0]
    assert.equal(before.status, 'failed')
    assert.equal(before.notification_pending, true)
    assert.equal(before.ownedCommandCleanupPending, true)
    const early = await engine.output(task.task_id, { offset: 0 })
    const visible = new OutputProjector().result(early, outputWait(), 'initialization-parent')
      .content[0].text
    assert.match(visible, /\[failed\] Task timed out/)
    assert.match(visible, /Child initialization cleanup is unconfirmed/)
    assert.equal(early.output, before.output)

    entries.push({ type: 'custom_message', ...messages[0][0] })
    await controller.reconcile()
    assert.deepEqual(await engine.pendingNotifications(), [])
    factory.resolve()
    await bounded(disposing.promise, 4000, 'late child disposal')
    cleanup.resolve()
    await bounded(runtime.done, 4000, 'late initialization settlement')
    await controller.flush()
    assert.equal(prompts, 0)
    assert.equal(engine.runtimes.size, 0)
    assert.equal(
      messages.length,
      1,
      'existing task-ID receipts still reconcile cleanup-only updates'
    )
    assert.equal(
      (await engine.output(task.task_id, { offset: 0 })).output,
      early.output,
      'cleanup-only settlement must preserve the readable failure without duplicate suffixes'
    )
    assert.equal(
      JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0].output,
      before.output
    )
  } finally {
    factory.resolve()
    cleanup.resolve()
    const remaining = controller.engine?.runtimes.values() ?? []
    await bounded(
      Promise.all([...remaining].map((runtime) => runtime.done)),
      4000,
      'released child settlement'
    )
    await bounded(controller.shutdown(), 10000, 'initialization owner shutdown')
  }
})
