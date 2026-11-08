import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InteractiveMode, initTheme, type Theme } from '@earendil-works/pi-coding-agent'
import {
  Container,
  TuiMainScreen,
  stripTerminalSequences,
  visibleWidth,
  type Terminal
} from '@earendil-works/pi-tui'
import {
  renderRoles,
  roleOverview,
  taskElapsed,
  taskProgress,
  taskWidget
} from '../src/task-presentation.ts'
import type { TaskSummary } from '../src/types.ts'

const now = Date.parse('2026-01-01T00:02:05Z')
const sampleTask = (overrides: Partial<TaskSummary> = {}): TaskSummary =>
  ({
    task_id: '5b14b85d-rest',
    status: 'running',
    agent_name: 'verifier',
    description: '复核观察截断优先级',
    created_at: '2026-01-01T00:00:00Z',
    activity: 'codemode: done',
    ...overrides
  }) as TaskSummary

function sdkRows(
  tasks: TaskSummary[],
  width: number,
  clock = now,
  options: { appearance?: string; raw?: boolean; onTheme?: (theme: Theme) => void } = {}
) {
  const tui = new TuiMainScreen({
    columns: width,
    rows: 40,
    write() {},
    hideCursor() {},
    showCursor() {},
    stop() {}
  } as unknown as Terminal)
  initTheme(options.appearance ?? 'dark', false)
  const host = Object.create(InteractiveMode.prototype)
  Object.assign(host, {
    ui: tui,
    extensionWidgetsAbove: new Map(),
    extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(),
    widgetContainerBelow: new Container()
  })
  try {
    host.setExtensionWidget('task-agents', (_tui: unknown, theme: Theme) => {
      options.onTheme?.(theme)
      return taskWidget(tasks, 0, theme, clock)
    })
    return host.widgetContainerAbove
      .render(width)
      .slice(1)
      .map((line: string) => (options.raw ? line : stripTerminalSequences(line)))
  } finally {
    tui.stop()
  }
}

test('hidden task hint never displays an incomplete command', () => {
  const widget = taskWidget([], 12, { fg: (_color: unknown, text: string) => text } as never, now)
  assert.deepEqual(widget.render(20), ['12 more /tasks list'])
  assert.deepEqual(widget.render(14), ['12 more'])
  for (const width of [40, 60, 80, 120]) {
    assert.deepEqual(widget.render(width), ['12 more tasks · /tasks list'])
  }
})

const profile = {
  name: 'worker',
  instructions: 'PRIVATE_ROLE_INSTRUCTIONS',
  tools: ['read', 'bash'],
  timeoutMs: 0
}

test('role overview distinguishes inheritance, model defaults and explicit resource selections', () => {
  const roles = {
    worker: profile,
    verifier: {
      ...profile,
      name: 'verifier',
      model: 'provider/model',
      skills: [],
      extensions: ['./one.ts'],
      mcpServers: []
    }
  }
  const overview = roleOverview(roles)
  assert.equal('model' in overview.worker, false)
  assert.equal('instructions' in overview.worker, false)
  assert.deepEqual(overview.worker.resources, {
    skills: 'inherit',
    extensions: 'inherit',
    mcp: 'inherit'
  })
  assert.deepEqual(overview.verifier.resources, {
    skills: 'off',
    extensions: '1 selected',
    mcp: 'off'
  })
  const text = renderRoles(roles)
  assert.match(text, /inherit current conversation/)
  assert.match(text, /provider\/model \| model default/)
  assert.doesNotMatch(text, /PRIVATE_ROLE_INSTRUCTIONS|timeoutMs/)
})

test('task elapsed times are bounded, readable, and do not invent missing timestamps', () => {
  const created_at = '2026-01-01T00:00:00Z'
  assert.equal(taskElapsed({ created_at }, Date.parse(created_at) + 65000), '1m 5s')
  assert.equal(
    taskElapsed({
      created_at,
      started_at: '2026-01-01T00:00:05Z',
      finished_at: '2026-01-01T00:00:07Z'
    }),
    '2s'
  )
  assert.equal(taskElapsed({ created_at: 'invalid' }), '')
  assert.equal(taskElapsed({ created_at }, 0), '0s')
})

test('progress preserves graphemes at former UTF-16 cutoffs and puts critical state first', () => {
  for (const grapheme of ['😀', '👩‍🚒', '🇨🇳', 'é', '✊🏽']) {
    const description = '中'.repeat(99) + grapheme + ' description tail'
    const reason = '错'.repeat(159) + grapheme + ' reason tail'
    const line = taskProgress({
      task_id: 'unicode',
      status: 'failed',
      agent_name: 'worker',
      description,
      error: reason,
      cleanup_pending: true
    } as Parameters<typeof taskProgress>[0])
    assert.doesNotMatch(
      line,
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    )
    assert.ok(line.includes(description))
    assert.ok(line.includes(reason))
    assert.ok(line.startsWith('failed · cleanup pending · '))
  }
})

test('SDK adaptive rows retain state and identity before role, goal and volatile activity', () => {
  const tasks = [
    sampleTask(),
    sampleTask({ task_id: '6c25c96e-rest', agent_name: 'worker', status: 'queued' }),
    sampleTask({ task_id: '7d36da7f-rest', status: 'stopping', activity: 'bash: running' }),
    sampleTask({ task_id: '8e47eb80-rest', description: '复核另一条同角色任务目标' }),
    ...(['failed', 'lost', 'canceled'] as const).map((status, index) =>
      sampleTask({ task_id: `${index}f58fc91-rest`, status, activity: undefined })
    )
  ]
  const original = JSON.stringify(tasks)
  for (const width of [20, 40, 60, 80, 120]) {
    const rows = sdkRows(tasks, width)
    assert.equal(rows.length, tasks.length, `${width}: one physical row per task`)
    for (const [index, task] of tasks.entries()) {
      if (task.status === 'running') {
        assert.ok(!rows[index].startsWith('running'), `${width}: omit redundant task running`)
      } else {
        assert.ok(rows[index].startsWith(task.status), `${width}: explicit non-running status`)
      }
      assert.ok(rows[index].includes(task.task_id.slice(0, 8)), `${width}: short ID`)
      assert.ok(visibleWidth(rows[index]) <= width)
      if (width >= 40) {
        assert.ok(rows[index].includes(task.agent_name), `${width}: role`)
        assert.match(rows[index], /复核/, `${width}: goal before activity`)
        assert.ok(
          rows[index].indexOf(task.agent_name) < rows[index].indexOf(task.task_id.slice(0, 8))
        )
      }
      if (width >= 80) {
        assert.ok(rows[index].includes(task.description), `${width}: full goal`)
        assert.match(rows[index], task.activity ? /(?:codemode: done|bash: running)$/ : /2m 5s/)
      }
    }
    assert.notEqual(rows[0], rows[3], `${width}: same-role tasks remain distinguishable`)
  }
  assert.deepEqual(sdkRows([tasks[0]], 20), ['5b14b85d · 复核观察…'])
  assert.equal(JSON.stringify(tasks), original, 'full queryable summaries are untouched')
})

test('SDK long goals share common widths with current or recent activity, not task completion', () => {
  const task = sampleTask({ description: '复核👩‍🚒é🇨🇳观察目标'.repeat(20) })
  for (const width of [20, 40, 60, 80, 120]) {
    const done = sdkRows([task], width)
    const active = sdkRows([{ ...task, activity: 'bash: running' }], width)
    const next = sdkRows([{ ...task, activity: 'read: running' }], width)
    for (const row of [done[0], active[0], next[0]]) {
      assert.doesNotMatch(row, /^(?:running|succeeded|failed|Completed) · /)
      assert.match(row, /5b14b85d/)
      assert.ok(visibleWidth(row) <= width)
      assert.doesNotMatch(row, /(?:last|activity):/)
      if (width >= 40) {
        assert.match(row, /verifier.*复核/)
      }
    }
    if (width >= 60) {
      assert.notDeepEqual(active, done, 'tool completion stays visible beside a long goal')
      assert.notDeepEqual(active, next, 'a new tool stays visible beside a long goal')
      assert.match(done[0], /codemode: done$/)
      assert.match(active[0], /bash: running$/)
      assert.match(next[0], /read: running$/)
      assert.doesNotMatch(done[0], /2m 5s/, 'activity outranks the clock for long goals')
    } else {
      assert.deepEqual(active, done, 'narrow rows retain identity and goal before activity')
    }
  }
  const rows = sdkRows([sampleTask()], 120)
  assert.match(rows[0], /^verifier · 5b14b85d · 复核观察截断优先级 · 2m 5s · codemode: done$/)
  assert.match(
    sdkRows([sampleTask({ activity: 'bash: failed' })], 120)[0],
    /^verifier · 5b14b85d.* · bash: failed$/
  )
  assert.match(
    sdkRows([sampleTask({ activity: 'bash: running' })], 120)[0],
    /^verifier · 5b14b85d.* · bash: running$/
  )
  assert.match(
    sdkRows([sampleTask({ status: 'succeeded' })], 120)[0],
    /^succeeded.* · codemode: done$/
  )
  assert.match(sdkRows([sampleTask()], 120, now + 1000)[0], /2m 6s/)
})

test(
  'real SDK completion activity cannot masquerade as a task terminal state',
  { timeout: 10000 },
  async (t) => {
    const {
      fixture,
      deferred,
      profile: childProfile
    } = await import('./pi-backend-test-helpers.ts')
    const { TaskEngine } = await import('../src/engine.ts')
    const { join } = await import('node:path')
    const f = await fixture(t)
    const finished = deferred()
    const pending: TaskSummary[] = []
    const engine = new TaskEngine({
      rootDir: join(f.root, 'engine'),
      parentId: 'completion-widget',
      cwd: f.cwd,
      createChild: f.create,
      onChange(task) {
        if (task.status === 'running' && task.activity === 'Completed') {
          pending.push(task)
        }
        if (task.status === 'succeeded') {
          finished.resolve()
        }
      }
    })
    try {
      await engine.init()
      const started = await engine.start(
        {
          agent_name: 'worker',
          description: 'Offline completion handoff',
          prompt: 'Finish offline',
          run_in_background: true
        },
        childProfile
      )
      await finished.promise
      assert.ok(pending.length > 0, 'the real backend reports Completed before the engine finishes')
      for (const width of [20, 40, 80, 120]) {
        for (const task of pending) {
          const [row] = sdkRows([task], width)
          assert.doesNotMatch(row, /Completed|succeeded|(?:last|activity):/)
          assert.ok(row.includes(task.task_id.slice(0, 8)))
          assert.ok(visibleWidth(row) <= width)
          assert.equal(task.activity, 'Completed', 'presentation does not alter the runtime fact')
        }
      }
      const terminal = await engine.query({ task_id: started.task_id })
      assert.equal(terminal.status, 'succeeded')
      assert.match(sdkRows([terminal], 120)[0], /^succeeded · /)
    } finally {
      await engine.close()
    }
  }
)

test('SDK tool state words use semantic theme colors, not the goal or tool name', (t) => {
  const previous = process.env.NO_COLOR
  delete process.env.NO_COLOR
  t.after(() => {
    if (previous === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = previous
    }
  })
  for (const appearance of ['dark', 'light']) {
    for (const width of [20, 40, 80, 120]) {
      const colors = new Set<string>()
      for (const [state, token] of [
        ['running', 'accent'],
        ['done', 'success'],
        ['failed', 'error']
      ] as const) {
        let expected = ''
        let coloredGoal = ''
        let coloredTool = ''
        const [row] = sdkRows(
          [sampleTask({ description: '复核👩‍🚒é🇨🇳观察目标'.repeat(20), activity: `bash: ${state}` })],
          width,
          now,
          {
            appearance,
            raw: true,
            onTheme(theme) {
              expected = theme.fg(token, state)
              coloredGoal = theme.fg(token, '复核')
              coloredTool = theme.fg(token, 'bash')
            }
          }
        )
        colors.add(expected.replace(state, 'state'))
        const plain = stripTerminalSequences(row)
        assert.ok(visibleWidth(row) <= width)
        assert.doesNotMatch(plain, /(?:last|activity):/)
        assert.doesNotMatch(plain, /^(?:running|failed|succeeded) · /)
        assert.equal(row.includes(expected), width >= 80, `${appearance}/${width}/${state}`)
        assert.equal(row.includes(coloredGoal), false)
        assert.equal(row.includes(coloredTool), false)
        if (width >= 80) {
          assert.ok(plain.endsWith(`bash: ${state}`))
        }
      }
      assert.equal(colors.size, 3, `${appearance}: distinct semantic state colors`)
    }
  }
})

test('SDK NO_COLOR keeps task and tool states readable without ANSI', () => {
  const previous = process.env.NO_COLOR
  process.env.NO_COLOR = '1'
  try {
    for (const width of [20, 40, 80, 120]) {
      for (const state of ['running', 'done', 'failed']) {
        const [row] = sdkRows(
          [sampleTask({ description: '复核'.repeat(50), activity: `bash: ${state}` })],
          width,
          now,
          { raw: true }
        )
        assert.equal(row, stripTerminalSequences(row))
        assert.ok(visibleWidth(row) <= width)
        if (width >= 80) {
          assert.ok(row.endsWith(`bash: ${state}`))
        }
      }
    }
  } finally {
    if (previous === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = previous
    }
  }
})

test('SDK tool state changes keep goal and tool-name prefixes stable', () => {
  for (const width of [60, 80, 120]) {
    for (const name of ['bash', 'mcp__' + '工具👩‍🚒é🇨🇳'.repeat(20)]) {
      const rows = ['running', 'done', 'failed'].map(
        (state) =>
          sdkRows(
            [
              sampleTask({
                description: '复核👩‍🚒é🇨🇳观察目标'.repeat(20),
                activity: `${name}: ${state}`
              })
            ],
            width
          )[0]
      )
      const stable = rows.map((row) => row.replace(/: (running|done|failed)$/, ': state'))
      assert.equal(new Set(stable).size, 1, `${width}: avoid shifting fields on tool completion`)
    }
  }
})

test('SDK truncates tool names, never their running/done/failed suffix', () => {
  for (const description of ['复核', '复核👩‍🚒é🇨🇳观察目标'.repeat(20)]) {
    for (const state of ['running', 'done', 'failed']) {
      const task = sampleTask({
        description,
        activity: `mcp__completed_${'工具👩‍🚒é🇨🇳'.repeat(20)}: ${state}`
      })
      for (const width of [20, 40, 60, 80, 120]) {
        const [row] = sdkRows([task], width)
        assert.ok(visibleWidth(row) <= width)
        assert.equal(row.isWellFormed(), true)
        assert.doesNotMatch(row, /^(?:running|succeeded|failed|Completed) · /)
        assert.doesNotMatch(row, /(?:activity|last):/)
        if (width >= 80 || row.includes(':')) {
          assert.match(row, new RegExp(` · m.*…: ${state}$`))
        }
      }
    }
  }
})

test('SDK clocks are omitted rather than clipped into noisy partial durations', () => {
  assert.deepEqual(sdkRows([sampleTask({ description: '复核', activity: undefined })], 20), [
    '5b14b85d · 复核'
  ])
  for (const width of [20, 40, 60, 80, 120]) {
    const [row] = sdkRows(
      [
        sampleTask({
          agent_name: 'worker',
          status: 'lost',
          error: 'Connection lost',
          description: '检查连接',
          activity: undefined
        })
      ],
      width
    )
    assert.doesNotMatch(row, / · 2(?:…|m …)$/)
  }
})

test('SDK absent goals do not repeat the task ID as a description', () => {
  const task = sampleTask({ description: undefined, activity: undefined })
  for (const width of [20, 40, 60, 80, 120]) {
    const [row] = sdkRows([task], width)
    assert.equal(row.split('5b14b85d').length - 1, 1)
    assert.doesNotMatch(row, /-rest/)
    assert.ok(visibleWidth(row) <= width)
    if (width >= 40) {
      assert.match(row, /verifier.*2m 5s/)
    }
  }
})

test('SDK running exceptions keep explicit state while ordinary rows keep identity', () => {
  for (const width of [20, 40, 60, 80, 120]) {
    const [ordinary] = sdkRows([sampleTask({ activity: undefined })], width)
    assert.match(ordinary, /5b14b85d/)
    assert.doesNotMatch(ordinary, /running/)
    if (width >= 40) {
      assert.match(ordinary, /^verifier · 5b14b85d.*复核/)
    }
    for (const exception of [{ error: 'Permission denied' }, { cleanup_pending: true }]) {
      const rows = sdkRows([sampleTask(exception)], width)
      assert.match(rows[0], /^running · /)
      assert.match(rows.join('\n'), /5b14b85d/)
      if ('cleanup_pending' in exception) {
        assert.match(rows.join('\n'), /cleanup pending/)
      }
      assert.ok(rows.every((row: string) => visibleWidth(row) <= width))
    }
  }
})

test('SDK narrow cleanup diagnostics never leave a partially displayed tool state', () => {
  const task = sampleTask({ status: 'failed', cleanup_pending: true, description: 'x' })
  const rows = sdkRows([task], 30)
  assert.equal(rows.length, 2)
  assert.match(rows[0], /^failed.*5b14b85d/)
  assert.match(rows[1], /^cleanup pending/)
  assert.doesNotMatch(rows.join('\n'), /codemode:/, 'cleanup diagnostics outrank activity')
})

test('SDK errors outrank long goals and tool activity even without a cleanup hold', () => {
  const task = sampleTask({
    status: 'failed',
    error: 'Permission denied',
    description: '复核'.repeat(100),
    activity: 'bash: done'
  })
  const [row] = sdkRows([task], 80)
  assert.match(row, /^failed · verifier · 5b14b85d · Permission denied/)
  assert.doesNotMatch(row, /bash: done/)
})

test('SDK cleanup warnings retain priority, short IDs and bounded rows with long diagnostics', () => {
  const tasks = ['failed', 'canceled', 'stopping'].map((status, i) =>
    sampleTask({
      task_id: `${i}a14b85d-rest`,
      status: status as TaskSummary['status'],
      cleanup_pending: true,
      stopError: { code: 'CHILD_CLEANUP_FAILED', message: 'Cannot confirm cleanup '.repeat(30) },
      description: '长目标👩‍🚒'.repeat(100),
      activity: 'codemode: done '.repeat(100)
    })
  )
  for (const width of [20, 40, 60, 80, 120]) {
    const rows = sdkRows(tasks, width)
    const perTask = width === 20 ? 2 : 1
    assert.equal(rows.length, tasks.length * perTask)
    for (const [index, task] of tasks.entries()) {
      const text = rows.slice(index * perTask, (index + 1) * perTask).join('\n')
      assert.ok(text.includes(task.status))
      assert.ok(text.includes(task.task_id.slice(0, 8)))
      assert.match(text, /cleanup pending/)
      if (width >= 80) {
        assert.match(text, /Cannot confirm cleanup/)
      }
    }
    assert.ok(rows.every((row: string) => visibleWidth(row) <= width))
  }
})

test('progress shows activity and failure reasons without terminal control characters', () => {
  const line = taskProgress({
    task_id: 't1',
    agent_name: 'worker',
    status: 'failed',
    description: 'Check\nfixture',
    created_at: '2026-01-01T00:00:00Z',
    finished_at: '2026-01-01T00:00:10Z',
    activity: 'bash: failed',
    error: 'Missing\raccess'
  } as Parameters<typeof taskProgress>[0])
  assert.match(line, /10s/)
  assert.match(line, /bash: failed/)
  assert.match(line, /Missing access/)
  assert.doesNotMatch(line, /[\r\n]/)
})
