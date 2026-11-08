import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ChildFailure } from '../src/types.ts'
import { answer, deferred, fixture, profile } from './pi-backend-test-helpers.ts'

async function activityFixture(t: TestContext, sameName = false, duplicateIds = false) {
  const activity: string[] = [],
    events: AgentSessionEvent[] = [],
    started = [deferred(), deferred()],
    ended = [deferred(), deferred()],
    release = [deferred(), deferred()],
    final = deferred(),
    requestedFinal = deferred()
  const names = ['activity_a', sameName ? 'activity_a' : 'activity_b']
  const ids = ['call-a', duplicateIds ? 'call-a' : 'call-b']
  const errors = [false, false],
    finished = [false, false]
  let endCount = 0
  const customTools: ToolDefinition[] = [...new Set(names)].map((name) => ({
    name,
    label: name,
    description: 'Offline gated activity fixture',
    parameters: {
      type: 'object',
      properties: { slot: { type: 'integer' } },
      required: ['slot']
    },
    async execute(_id, args, signal) {
      const index = Number((args as { slot?: unknown }).slot)
      started[index].resolve()
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve()
          return
        }
        const abort = () => resolve()
        signal?.addEventListener('abort', abort, { once: true })
        release[index].promise.then(() => {
          signal?.removeEventListener('abort', abort)
          resolve()
        })
      })
      finished[index] = true
      if (errors[index] || signal?.aborted) {
        throw new Error('PRIVATE_TOOL_FAILURE')
      }
      return { content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }], details: {} }
    }
  }))
  const f = await fixture(t, { customTools })
  const child = await f.create({
    profile: { ...profile, tools: [...new Set(names)] },
    cwd: f.cwd,
    sessionPath: join(f.root, 'sessions', 'activity.jsonl'),
    onActivity: (text) => activity.push(text)
  })
  t.after(async () => {
    release.forEach((gate) => gate.resolve())
    final.resolve()
    await child.dispose()
  })
  f.session().subscribe((event) => {
    events.push(event)
    if (event.type === 'tool_execution_end') {
      ended[duplicateIds ? endCount++ : event.toolCallId === 'call-a' ? 0 : 1].resolve()
    }
  })
  const calls = (indices = [0, 1]) =>
    answer('', {
      stopReason: 'toolUse',
      content: indices.map((index) => ({
        type: 'toolCall',
        id: ids[index],
        name: names[index],
        arguments: { slot: index }
      }))
    })
  f.script(async (step) => {
    if (step === 1) {
      return calls()
    }
    requestedFinal.resolve()
    await final.promise
    return answer('Final owned response')
  })
  return {
    f,
    child,
    names,
    ids,
    finished,
    activity,
    events,
    started,
    ended,
    release,
    errors,
    final,
    requestedFinal,
    calls
  }
}

for (const sameName of [false, true]) {
  for (const first of [0, 1]) {
    for (const failure of ['none', 'first', 'last']) {
      for (const duplicateIds of [false, true]) {
        test(
          `real SDK parallel activity: sameName=${sameName}, first=${first}, failure=${failure}, duplicateIds=${duplicateIds}`,
          { timeout: 10000 },
          async (t) => {
            const f = await activityFixture(t, sameName, duplicateIds)
            const last = 1 - first
            f.errors[first] = failure === 'first'
            f.errors[last] = failure === 'last'
            const running = f.child.prompt('Execute the two offline gates', {
              turnId: 'parallel-turn'
            })
            try {
              await Promise.all(f.started.map((gate) => gate.promise))
              assert.equal(
                f.f.session().agent.toolExecution,
                'parallel',
                'Use the SDK default, not a mock event schedule'
              )
              assert.deepEqual([...f.f.session().agent.state.pendingToolCalls], [...new Set(f.ids)])
              assert.deepEqual(f.activity, [
                'Running',
                `${f.names[0]}: running`,
                `${f.names[1]}: running`
              ])
              f.release[first].resolve()
              await f.ended[duplicateIds ? 0 : first].promise
              assert.equal(f.finished[first], true)
              assert.equal(
                f.finished[last],
                false,
                'The other invocation is still blocked, even if the SDK pending-ID Set is empty'
              )
              if (!duplicateIds) {
                assert.deepEqual([...f.f.session().agent.state.pendingToolCalls], [f.ids[last]])
              }
              assert.equal(
                f.activity.at(-1),
                `${f.names[last]}: running`,
                'An ended sibling must not hide the still-blocked tool'
              )
              assert.deepEqual(
                f.events
                  .filter((event) => event.type.startsWith('tool_execution_'))
                  .map((event) => event.type),
                ['tool_execution_start', 'tool_execution_start', 'tool_execution_end']
              )
              f.release[last].resolve()
              await f.ended[duplicateIds ? 1 : last].promise
              await f.requestedFinal.promise
              assert.deepEqual(f.finished, [true, true])
              assert.equal(f.f.session().agent.state.pendingToolCalls.size, 0)
              assert.equal(
                f.activity.at(-1),
                `${f.names[last]}: ${f.errors[last] ? 'failed' : 'done'}`
              )
              f.final.resolve()
              const result = await running
              assert.equal(result.text, 'Final owned response')
              assert.equal(result.subTurnId, 'parallel-turn')
              assert.deepEqual(result.outcome, { kind: 'returned', status: 'succeeded' })
              assert.equal(f.activity.at(-1), 'Completed')
              assert.ok(f.activity.every((text) => !text.includes('PRIVATE_')))
            } finally {
              f.release.forEach((gate) => gate.resolve())
              f.final.resolve()
              await running.catch(() => {})
            }
          }
        )
      }
    }
  }
}

test(
  'real SDK cancellation stays cancelable and resumed turns have no ghost tools, including reused call IDs',
  { timeout: 10000 },
  async (t) => {
    const f = await activityFixture(t)
    const running = f.child.prompt('Cancel two blocked tools', { turnId: 'canceled-turn' })
    const rejected = assert.rejects(running, (error: ChildFailure) => {
      assert.equal(error.name, 'AbortError')
      assert.deepEqual(error.partialResult?.outcome, { kind: 'returned', status: 'aborted' })
      assert.equal(error.partialResult?.subTurnId, 'canceled-turn')
      return true
    })
    await Promise.all(f.started.map((gate) => gate.promise))
    const cancelIndex = f.activity.length
    await f.child.abort()
    await rejected
    assert.equal(f.f.session().agent.state.pendingToolCalls.size, 0)
    assert.ok(
      f.activity.slice(cancelIndex).every((text) => !text.endsWith(': running')),
      'Cancellation must not advertise remaining canceled calls as running'
    )

    const entered = deferred(),
      release = deferred()
    f.f.script(async () => {
      entered.resolve()
      await release.promise
      return answer('No tools on resumed turn')
    })
    const start = f.activity.length
    const next = f.child.prompt('Resume without tools', { turnId: 'resumed-turn' })
    try {
      await entered.promise
      assert.deepEqual(f.activity.slice(start), ['Running'])
    } finally {
      release.resolve()
    }
    assert.equal((await next).text, 'No tools on resumed turn')

    f.release[0].resolve()
    f.f.script((step) => (step === 1 ? f.calls([0]) : answer('Reused ID finished')))
    const reusedStart = f.activity.length
    assert.equal(
      (await f.child.prompt('Reuse call-a', { turnId: 'reused-turn' })).text,
      'Reused ID finished'
    )
    assert.deepEqual(f.activity.slice(reusedStart), [
      'Running',
      'activity_a: running',
      'activity_a: done',
      'Completed'
    ])
  }
)
