import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InteractiveMode, initTheme } from '@earendil-works/pi-coding-agent'
import {
  Container,
  TuiMainScreen,
  stripTerminalSequences,
  visibleWidth
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

function sdkRows(tasks: TaskSummary[], width: number, clock = now) {
  const tui = new TuiMainScreen({
    columns: width,
    rows: 40,
    write() {},
    hideCursor() {},
    showCursor() {},
    stop() {}
  })
  initTheme('dark', false)
  const host = Object.create(InteractiveMode.prototype)
  Object.assign(host, {
    ui: tui,
    extensionWidgetsAbove: new Map(),
    extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(),
    widgetContainerBelow: new Container()
  })
  try {
    host.setExtensionWidget('task-agents', (_tui, theme) => taskWidget(tasks, 0, theme, clock))
    return host.widgetContainerAbove.render(width).slice(1).map(stripTerminalSequences)
  } finally {
    tui.stop()
  }
}

test('hidden task hint never displays an incomplete command', () => {
  const widget = taskWidget([], 12, { fg: (_color, text) => text } as never, now)
  assert.deepEqual(widget.render(20), ['12 more /tasks list'])
  assert.deepEqual(widget.render(14), ['12 more'])
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
    assert.equal(line.isWellFormed(), true)
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
    sampleTask({ task_id: '8e47eb80-rest', description: '复核另一条同角色任务目标' })
  ]
  const original = JSON.stringify(tasks)
  for (const width of [20, 40, 80]) {
    const rows = sdkRows(tasks, width)
    assert.equal(rows.length, tasks.length, `${width}: one physical row per task`)
    for (const [index, task] of tasks.entries()) {
      assert.ok(rows[index].startsWith(task.status), `${width}: explicit status`)
      assert.ok(rows[index].includes(task.task_id.slice(0, 8)), `${width}: short ID`)
      assert.ok(visibleWidth(rows[index]) <= width)
      if (width >= 40) {
        assert.ok(rows[index].includes(task.agent_name), `${width}: role`)
        assert.match(rows[index], /复核/, `${width}: goal before activity`)
        assert.ok(
          rows[index].indexOf(task.agent_name) < rows[index].indexOf(task.task_id.slice(0, 8))
        )
      }
      if (width === 80) {
        assert.ok(rows[index].includes(task.description), `${width}: full goal`)
        assert.match(rows[index], /2m 5s/)
      }
    }
    assert.notEqual(rows[0], rows[3], `${width}: same-role tasks remain distinguishable`)
  }
  assert.deepEqual(sdkRows([tasks[0]], 20), ['running · 5b14b85d'])
  assert.equal(JSON.stringify(tasks), original, 'full queryable summaries are untouched')
})

test('SDK activity completion is not task completion and never displaces a long goal', () => {
  const task = sampleTask({ description: '复核👩‍🚒é🇨🇳观察目标'.repeat(20) })
  for (const width of [20, 40, 80]) {
    const done = sdkRows([task], width)
    const active = sdkRows([{ ...task, activity: `bash: running ${'output '.repeat(100)}` }], width)
    assert.deepEqual(active, done, `${width}: long goal outranks volatile tool text`)
    if (width >= 40) {
      assert.match(done[0], /复核/)
    }
    if (width === 80) {
      assert.match(done[0], /2m 5s$/, 'elapsed time still has room beside a long goal')
    }
  }
  const rows = sdkRows([sampleTask()], 120)
  assert.match(
    rows[0],
    /^running · verifier · 5b14b85d · 复核观察截断优先级 · 2m 5s · last: codemode: done$/
  )
  assert.match(
    sdkRows([sampleTask({ activity: 'bash: failed' })], 120)[0],
    /^running.*last: bash: failed$/
  )
  assert.match(
    sdkRows([sampleTask({ activity: 'bash: running' })], 120)[0],
    /^running.*activity: bash: running$/
  )
  assert.match(
    sdkRows([sampleTask({ status: 'succeeded' })], 120)[0],
    /^succeeded.*last: codemode: done$/
  )
  assert.match(sdkRows([sampleTask()], 120, now + 1000)[0], /2m 6s/)
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
  for (const width of [20, 40, 80]) {
    const rows = sdkRows(tasks, width)
    const perTask = width === 20 ? 2 : 1
    assert.equal(rows.length, tasks.length * perTask)
    for (const [index, task] of tasks.entries()) {
      const text = rows.slice(index * perTask, (index + 1) * perTask).join('\n')
      assert.ok(text.includes(task.status))
      assert.ok(text.includes(task.task_id.slice(0, 8)))
      assert.match(text, /cleanup pending/)
      if (width === 80) {
        assert.match(text, /Cannot confirm cleanup/)
      }
    }
    assert.ok(rows.every((row) => visibleWidth(row) <= width))
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
