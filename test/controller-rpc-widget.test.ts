import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { getPackageDir, initTheme, InteractiveMode } from '@earendil-works/pi-coding-agent'
import {
  Container,
  stripTerminalSequences,
  TuiMainScreen,
  visibleWidth
} from '@earendil-works/pi-tui'
import { TaskController } from '../src/controller.ts'
import { taskProgress } from '../src/task-presentation.ts'

const task = (patch = {}) => ({
  task_id: 'task0001-long-id',
  agent_name: 'worker',
  description: 'Inspect widget transport',
  status: 'running',
  started_at: new Date().toISOString(),
  activity: 'bash: running',
  ...patch
})

// This engine controls presentation only; the real Pi process owns the RPC adapter.
const engineSource = `class Engine {
  tasks = []
  async init() {}
  async close() {}
  async query() { return this.tasks }
  async pendingNotifications() { return [] }
}`

async function rpcFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-controller-rpc-widget-'))
  const home = join(root, 'home'),
    agentDir = join(root, 'agent'),
    cwd = join(root, 'workspace')
  await Promise.all([mkdir(home), mkdir(agentDir), mkdir(cwd)])
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: 'off'
    })
  )
  const extension = join(root, 'widget-fixture.ts')
  await writeFile(
    extension,
    `
    import { TaskController } from ${JSON.stringify(fileURLToPath(new URL('../src/controller.ts', import.meta.url)))}
    ${engineSource}
    export default function(pi) {
      const controller = new TaskController(pi, {
        agentDir: ${JSON.stringify(agentDir)}, Engine,
        configLoader: async () => ({ maxConcurrency: 4, roles: {}, diagnostics: [] }),
        childFactory: () => () => { throw new Error('No child/model may be started') }
      })
      pi.on('session_start', async (_event, ctx) => {
        await controller.ensure(ctx)
        ctx.ui.notify('widget-fixture-ready', 'info')
      })
      pi.on('session_shutdown', async (event) => controller.shutdown(event.reason))
      pi.registerCommand('widget-fixture', { handler: async (args, ctx) => {
        if (args === 'factory-probe') {
          ctx.ui.setWidget('factory-probe', () => ({ render: () => ['not serializable'], invalidate() {} }))
          ctx.ui.setWidget('array-probe', ['serializable'])
          return
        }
        if (args === 'warn') { controller.warn(new Error('fixture warning')); return }
        const engine = await controller.ensure(ctx)
        engine.tasks = JSON.parse(args)
        await controller.updateUI()
      } })
    }
  `
  )
  const audit = join(root, 'network.jsonl')
  const guard = fileURLToPath(new URL('./fixtures/resource-mcp/offline-guard.mjs', import.meta.url))
  const child = spawn(
    process.execPath,
    [
      join(getPackageDir(), 'dist/cli.js'),
      '--mode',
      'rpc',
      '--offline',
      '--no-mcp',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-themes',
      '--session-dir',
      join(root, 'sessions'),
      '-e',
      extension
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        TERM: 'dumb',
        RESOURCE_MCP_NETWORK_AUDIT: audit,
        NODE_OPTIONS: '--import=' + guard
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const events = []
  let buffer = '',
    stderr = '',
    failure,
    sequence = 0
  child.stdout.on('data', (bytes) => {
    buffer += bytes.toString()
    let end
    // RPC framing is LF only, not Unicode line/paragraph separators.
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        events.push(JSON.parse(line))
      } catch {
        failure = new Error('Invalid RPC record: ' + line)
      }
    }
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  child.on('error', (error) => {
    failure = error
  })
  async function waitFor(predicate) {
    const deadline = Date.now() + 12000
    while (!predicate()) {
      if (failure) {
        throw failure
      }
      assert.equal(child.exitCode, null, stderr)
      assert.ok(Date.now() < deadline, 'RPC fixture timed out: ' + stderr + JSON.stringify(events))
      // oxlint-disable-next-line no-await-in-loop -- Wait for the independent RPC process.
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  t.after(async () => {
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited
      clearTimeout(timer)
    }
    const auditEvents = (await readFile(audit, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(auditEvents.length > 0)
    assert.ok(
      auditEvents.every((event) => event.event === 'guard-installed'),
      JSON.stringify(auditEvents)
    )
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  await waitFor(() => events.some((event) => event.message === 'widget-fixture-ready'))
  async function command(type, fields = {}) {
    const id = String(++sequence),
      start = events.length
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n')
    await waitFor(() => events.some((event) => event.type === 'response' && event.id === id))
    const response = events.find((event) => event.type === 'response' && event.id === id)
    assert.equal(response.success, true, JSON.stringify(response))
    return events.slice(start)
  }
  return {
    command,
    update: (tasks) => command('prompt', { message: '/widget-fixture ' + JSON.stringify(tasks) }),
    events
  }
}

const widgets = (events) =>
  events.filter((event) => event.method === 'setWidget' && event.widgetKey === 'task-agents')
const statuses = (events) =>
  events.filter((event) => event.method === 'setStatus' && event.statusKey === 'task-agents')
const lines = (events) => {
  const widget = widgets(events).findLast((event) => Array.isArray(event.widgetLines))
  assert.ok(
    widget,
    'Expected serializable task setWidget; factories are silently ignored by Pi RPC'
  )
  return widget.widgetLines
}
const plain = (rows) => {
  assert.ok(rows.every((row) => typeof row === 'string'))
  for (const row of rows) {
    assert.equal(stripTerminalSequences(row), row)
    assert.equal(/[\p{Cc}\p{Zl}\p{Zp}]/u.test(row), false, JSON.stringify(row))
  }
}

test(
  'real offline Pi RPC emits task rows, updates, cleanup, hidden counts and clears across sessions',
  { timeout: 30000 },
  async (t) => {
    const rpc = await rpcFixture(t)
    const probe = await rpc.command('prompt', { message: '/widget-fixture factory-probe' })
    assert.equal(
      probe.some((event) => event.widgetKey === 'factory-probe'),
      false
    )
    assert.deepEqual(probe.find((event) => event.widgetKey === 'array-probe').widgetLines, [
      'serializable'
    ])

    const completed = lines(await rpc.update([task({ activity: 'Completed' })]))
    assert.doesNotMatch(completed[0], /Completed/)
    assert.match(completed[0], /^worker · task0001 · /)

    const initial = await rpc.update([task()])
    assert.match(statuses(initial).at(-1).statusText, /Agents 1\/4/)
    const first = lines(initial)
    assert.match(first.join('\n'), /worker/)
    assert.match(first.join('\n'), /task0001/)
    assert.match(first.join('\n'), /Inspect widget transport/)
    assert.match(first.join('\n'), /bash: running/)
    assert.match(first[0], /^worker · task0001 · /)
    assert.doesNotMatch(first[0], /\b(?:Last|activity):/i)
    plain(first)

    const changed = lines(
      await rpc.update([task({ description: 'Review the result', activity: 'read: done' })])
    )
    assert.match(changed.join('\n'), /Review the result/)
    assert.match(changed.join('\n'), /read: done/)
    assert.doesNotMatch(changed.join('\n'), /bash: running/)

    const fullActivity = 'namespace.very_long_tool_name_'.repeat(10) + ': failed'
    const semanticTasks = [
      { task_id: 'complete', activity: '\x1B[32mCompleted\x1B[0m' },
      { task_id: 'queued01', status: 'queued' },
      { task_id: 'stopping', status: 'stopping' },
      { task_id: 'error001', error: 'explicit task error' },
      {
        task_id: 'cancel01',
        status: 'canceled',
        cleanup_pending: true,
        cancel_reason: 'explicit cancellation'
      },
      { task_id: 'fullact1', activity: fullActivity }
    ].map((patch) => task({ started_at: undefined, ...patch }))
    const semanticRows = lines(await rpc.update(semanticTasks))
    assert.doesNotMatch(semanticRows.join('\n'), /Completed|\b(?:Last|activity):/i)
    assert.ok(semanticRows.includes('worker · complete · Inspect widget transport'))
    assert.ok(semanticRows.some((row) => row.startsWith('queued · worker · queued01')))
    assert.ok(semanticRows.some((row) => row.startsWith('stopping · worker · stopping')))
    assert.match(semanticRows.join('\n'), /running · worker · error001 · explicit task error/)
    assert.match(semanticRows.join('\n'), /canceled · cleanup pending.*explicit cancellation/)
    assert.ok(semanticRows.some((row) => row.endsWith(fullActivity)))
    for (const entry of semanticTasks.slice(1)) {
      assert.ok(semanticRows.includes(taskProgress(entry)), semanticRows.join('\n'))
    }
    plain(semanticRows)

    const cleanup = lines(
      await rpc.update([
        ...Array.from({ length: 7 }, (_, index) => task({ task_id: 'running' + index })),
        task({
          task_id: 'cleanup0',
          status: 'failed',
          cleanup_pending: true,
          error: 'cleanup refused'
        })
      ])
    )
    assert.equal(cleanup.length, 7)
    assert.match(cleanup[0], /failed.*cleanup pending/)
    assert.match(cleanup[0], /cleanup refused/)
    assert.match(cleanup.at(-1), /2 more tasks/)
    plain(cleanup)

    const hostile = lines(
      await rpc.update([
        task({
          agent_name: '\x1B[31mworker\x1B[0m',
          task_id: '\x1B[32mtask0001\x1B[0m',
          description:
            '\x1B]8;;https://example.invalid\x07Goal\x1B]8;;\x07\nnext\r\t\u0085\u2028\u2029',
          activity: '\x1B[33mbash: failed\x1B[0m\0',
          stopError: { code: 'STOP', message: '\x1B[31mstop failed\x1B[0m\nretry' }
        })
      ])
    )
    plain(hostile)
    assert.match(hostile.join('\n'), /worker/)
    assert.match(hostile.join('\n'), /task0001/)
    assert.match(hostile.join('\n'), /Goal/)
    assert.match(hostile.join('\n'), /bash: failed/)
    assert.match(hostile.join('\n'), /stop failed/)
    assert.doesNotMatch(hostile.join('\n'), /\[31m|\[32m|https:\/\//)

    const cleared = await rpc.update([])
    assert.equal(widgets(cleared).at(-1).widgetLines, undefined)
    assert.equal(statuses(cleared).at(-1).statusText, undefined)
    const warning = await rpc.command('prompt', { message: '/widget-fixture warn' })
    assert.ok(
      warning.some(
        (event) =>
          event.method === 'notify' &&
          event.message === 'Task agents: fixture warning' &&
          event.notifyType === 'warning'
      )
    )

    await rpc.update([task()])
    const switched = await rpc.command('new_session')
    assert.ok(widgets(switched).some((event) => event.widgetLines === undefined))
    assert.ok(statuses(switched).some((event) => event.statusText === undefined))
    const replacement = lines(
      await rpc.update([task({ task_id: 'new00001', description: 'Replacement session' })])
    )
    assert.match(replacement.join('\n'), /new00001.*Replacement session/)
    assert.doesNotMatch(replacement.join('\n'), /task0001/)
    assert.equal(
      rpc.events.some((event) => event.type === 'agent_start'),
      false
    )
  }
)

function controllerFixture(mode = 'tui', hasUI = true) {
  const writes = [],
    engines = []
  class Engine {
    tasks = []
    constructor() {
      engines.push(this)
    }
    async init() {}
    async close() {}
    async query() {
      return this.tasks
    }
    async pendingNotifications() {
      return []
    }
  }
  const ctx = {
    mode,
    hasUI,
    cwd: '/fixture',
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => 'parent', getEntries: () => [] },
    ui: {
      setWidget: (key, value) => writes.push({ key, value }),
      setStatus() {},
      notify() {},
      get theme() {
        throw new Error('No eager theme access')
      }
    }
  }
  const controller = new TaskController(
    { getThinkingLevel: () => 'off' },
    {
      agentDir: '/fixture/controller-rpc-' + Math.random(),
      Engine,
      configLoader: async () => ({ maxConcurrency: 4, roles: {}, diagnostics: [] }),
      childFactory: () => () => {
        throw new Error('No child may be started')
      }
    }
  )
  return { controller, ctx, writes, engines }
}

test('TUI retains a lazy themed, width-aware widget factory', async () => {
  const f = controllerFixture()
  try {
    await f.controller.ensure(f.ctx)
    f.engines[0].tasks = [task({ description: '检查图形客户端任务状态及终端宽度' })]
    await f.controller.updateUI()
    const factory = f.writes.at(-1).value
    assert.equal(typeof factory, 'function')
    const colors = []
    const component = factory(
      {},
      {
        fg: (color, text) => {
          colors.push(color)
          return text
        }
      }
    )
    const wide = component.render(200)
    assert.match(wide.join('\n'), /worker.*task0001/)
    assert.match(wide.join('\n'), /bash: running/)
    assert.equal(colors.includes('muted'), process.env.NO_COLOR === undefined)
    for (const width of [0, 12, 32, 80]) {
      assert.ok(component.render(width).every((row) => visibleWidth(row) <= width))
    }
    // Exercise the real SDK widget adapter without starting a terminal or model.
    initTheme('dark', false)
    const tui = new TuiMainScreen({
      columns: 80,
      rows: 40,
      write() {},
      hideCursor() {},
      showCursor() {},
      stop() {}
    })
    const host = Object.create(InteractiveMode.prototype)
    Object.assign(host, {
      ui: tui,
      extensionWidgetsAbove: new Map(),
      extensionWidgetsBelow: new Map(),
      widgetContainerAbove: new Container(),
      widgetContainerBelow: new Container()
    })
    try {
      host.setExtensionWidget('task-agents', factory)
      const rendered = host.widgetContainerAbove.render(80).map(stripTerminalSequences)
      assert.match(rendered.join('\n'), /worker.*task0001/)
      for (const width of [20, 40, 80]) {
        assert.ok(
          host.widgetContainerAbove.render(width).every((row) => visibleWidth(row) <= width)
        )
      }
      host.setExtensionWidget('task-agents', undefined)
      assert.equal(host.widgetContainerAbove.render(80).join('').trim(), '')
    } finally {
      tui.stop()
    }
    f.engines[0].tasks = []
    await f.controller.updateUI()
    assert.equal(f.writes.at(-1).value, undefined)
  } finally {
    await f.controller.shutdown()
  }
})

test('a delayed old-session query cannot overwrite replacement-session task rows', async () => {
  const f = controllerFixture('rpc')
  try {
    await f.controller.ensure(f.ctx)
    let release, entered
    const querying = new Promise((resolve) => {
      entered = resolve
    })
    f.engines[0].query = () => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    }
    const updating = f.controller.updateUI()
    await querying
    const replacement = {
      ...f.ctx,
      sessionManager: { getSessionId: () => 'replacement', getEntries: () => [] }
    }
    await f.controller.ensure(replacement)
    f.engines[1].tasks = [task({ task_id: 'new00001', description: 'Replacement session' })]
    await f.controller.updateUI()
    const current = f.writes.at(-1).value
    release([task({ description: 'Stale session' })])
    await updating
    assert.equal(f.writes.at(-1).value, current)
    assert.match(current.join('\n'), /new00001.*Replacement session/)
    assert.doesNotMatch(current.join('\n'), /Stale session/)
  } finally {
    await f.controller.shutdown()
  }
})

test('non-TUI hasUI contexts use plain arrays, and headless contexts emit no widget', async () => {
  for (const [mode, hasUI] of [
    ['rpc', true],
    [undefined, true],
    ['print', false],
    ['json', false]
  ]) {
    const f = controllerFixture(mode, hasUI)
    // Explicit undefined exercises an older/custom host without a mode field.
    f.ctx.mode = mode
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each fixture owns one independent controller.
      await f.controller.ensure(f.ctx)
      f.engines[0].tasks = [task()]
      // oxlint-disable-next-line no-await-in-loop -- Update the current fixture before teardown.
      await f.controller.updateUI()
      if (hasUI) {
        assert.ok(Array.isArray(f.writes.at(-1).value))
        plain(f.writes.at(-1).value)
      } else {
        assert.deepEqual(f.writes, [])
      }
    } finally {
      // oxlint-disable-next-line no-await-in-loop -- Release the current fixture owner before continuing.
      await f.controller.shutdown()
    }
  }
})
