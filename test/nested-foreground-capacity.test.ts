import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { answer, tool } from './pi-backend-test-helpers.ts'
import { busy, input, setup, waitFor } from './nested-foreground-test-helpers.ts'

function notifiedTaskIds(f) {
  return f.notifications.flatMap(([message]) => {
    if (Array.isArray(message.details.task_ids)) {
      return message.details.task_ids
    }
    return typeof message.details.task_id === 'string' ? [message.details.task_id] : []
  })
}

for (const mode of ['sequential', 'parallel']) {
  for (const name of ['task', 'task_send']) {
    test(
      `${mode}: saturated nested ${name} is not admitted; the same request can retry after drain`,
      { timeout: 8000 },
      async (t) => {
        const f = await setup(t, mode)
        const seed = await f.run('task', input('CHILD_SEED'))
        const target = seed.result.details.task_id
        const retained = f.controller.engine.sessions.get(seed.result.details.sub_session_id).child
        const holder = await f.saturate()
        const before = JSON.stringify(f.controller.engine.state)
        const params =
          name === 'task' ? input('CHILD_RETRY') : { task_id: target, content: 'CHILD_RETRY' }
        f.handle('CHILD_RETRY', (step) =>
          step === 1 ? tool('read', { path: 'seed.txt' }) : answer('RETRIED')
        )
        const rejected = await f.nested(name, params, 'retry-root')
        busy(rejected)
        assert.equal(
          JSON.stringify(f.controller.engine.state),
          before,
          'No task or durable receipt may be created'
        )
        assert.equal(f.counts.get('CHILD_RETRY'), undefined)
        holder.release()
        await f.drain()
        assert.equal(notifiedTaskIds(f).length, 4)
        const result = await f.nested(name, params, 'retry-root')
        assert.equal(result.result.details.status, 'succeeded')
        assert.equal(f.controller.engine.state.tasks.length, 6)
        assert.equal(
          f.leaves.findLast((event) => event.toolName === 'read').parentToolCallId,
          'retry-root/1'
        )
        if (name === 'task_send') {
          assert.equal(
            f.controller.engine.sessions.get(seed.result.details.sub_session_id).child,
            retained
          )
        }
        // Reusing the exact real SDK nested ID while full must replay the receipt, not reject or rerun.
        const replayHolder = await f.saturate(4, 'CHILD_REPLAY_HOLD')
        const admittedCount = f.controller.engine.state.tasks.length
        const replay = await f.nested(name, params, 'retry-root')
        assert.equal(replay.result.details.task_id, result.result.details.task_id)
        assert.equal(f.counts.get('CHILD_RETRY'), 2)
        assert.equal(f.controller.engine.state.tasks.length, admittedCount)
        replayHolder.release()
        await f.drain()
        assert.equal(
          notifiedTaskIds(f).length,
          8,
          'Neither foreground completion nor replay emits a background notice'
        )
      }
    )
  }

  test(
    `${mode}: direct foreground still queues, even with a slash in its direct ID`,
    { timeout: 8000 },
    async (t) => {
      const f = await setup(t, mode)
      const holder = await f.saturate()
      f.handle('CHILD_DIRECT', (step) =>
        step === 1 ? tool('read', { path: 'seed.txt' }) : answer('DIRECT_DONE')
      )
      const running = f.run('task', input('CHILD_DIRECT'), 'not-ancestry/direct-id')
      await waitFor(() =>
        f.controller.engine.state.tasks.some((entry) => entry.status === 'queued')
      )
      holder.release()
      const result = await running
      assert.equal(result.result.details.status, 'succeeded')
      await f.drain()
      assert.equal(notifiedTaskIds(f).length, 4)
    }
  )

  test(
    `${mode}: queued nested background replays one admission and delivers once`,
    { timeout: 8000 },
    async (t) => {
      const f = await setup(t, mode)
      const holder = await f.saturate()
      f.handle('CHILD_EXTRA', (step) =>
        step === 1 ? tool('read', { path: 'seed.txt' }) : answer('EXTRA_DONE')
      )
      const first = await f.nested('task', input('CHILD_EXTRA', true), 'background-replay')
      assert.equal(first.result.details.status, 'started')
      assert.equal(f.controller.engine.task(first.result.details.task_id).status, 'queued')
      assert.ok(first.result.details.task_id)
      const replay = await f.nested('task', input('CHILD_EXTRA', true), 'background-replay')
      assert.equal(replay.result.details.task_id, first.result.details.task_id)
      assert.equal(f.controller.engine.state.tasks.length, 5)
      holder.release()
      await f.drain()
      assert.equal(f.counts.get('CHILD_EXTRA'), 2)
      assert.equal(notifiedTaskIds(f).length, 5)
      assert.equal(new Set(notifiedTaskIds(f)).size, 5)
    }
  )

  test(
    `${mode}: aborting a queued direct foreground does not stop admitted background tasks`,
    { timeout: 8000 },
    async (t) => {
      const f = await setup(t, mode)
      const holder = await f.saturate()
      const running = f.run('task', input('CHILD_CANCEL_QUEUED'))
      await waitFor(() =>
        f.controller.engine.state.tasks.some((entry) => entry.status === 'queued')
      )
      await f.session.abort()
      await running
      assert.equal(
        f.controller.engine.state.tasks.find(
          (entry) => entry.input.prompt === 'CHILD_CANCEL_QUEUED'
        ).status,
        'canceled'
      )
      assert.equal(f.controller.engine.runtimes.size, 4)
      holder.release()
      await f.drain()
      assert.equal(
        f.controller.engine.state.tasks.filter((entry) => entry.status === 'succeeded').length,
        4
      )
      assert.equal(f.counts.get('CHILD_CANCEL_QUEUED'), undefined)
      // Parent abort pauses delivery, but does not change ownership or execute canceled work.
      f.controller.resume()
      await f.controller.flush()
      await f.controller.flush()
      assert.equal(notifiedTaskIds(f).length, 4)
    }
  )

  test(
    `${mode}: nested foreground below capacity preserves cancellation ancestry and cleanup`,
    { timeout: 8000 },
    async (t) => {
      const f = await setup(t, mode)
      const entered = f.deferred(),
        release = f.deferred()
      f.handle('CHILD_CANCEL_LIVE', (step) =>
        step === 1
          ? tool('write', { path: 'must-not-write.txt', content: 'no' })
          : answer('UNEXPECTED')
      )
      f.hook(async (event) => {
        if (event.toolName === 'write') {
          entered.resolve()
          await release.promise
        }
      })
      const running = f.nested('task', input('CHILD_CANCEL_LIVE'), 'cancel-nested')
      await entered.promise
      assert.equal(f.leaves[0].parentToolCallId, 'cancel-nested/1')
      const aborting = f.session.abort()
      await delay(20)
      assert.equal(
        f.controller.engine.runtimes.size,
        1,
        'Waiting permission hooks retain their owner slot'
      )
      release.resolve()
      await aborting
      await running
      await f.drain()
      assert.equal(f.controller.engine.state.tasks[0].status, 'canceled')
      await assert.rejects(readFile(join(f.cwd, 'must-not-write.txt')), { code: 'ENOENT' })
      assert.equal(f.notifications.length, 0)
    }
  )
}

test(
  'parallel: concurrent nested sends serialize capacity checks and replay the admitted request while full',
  { timeout: 8000 },
  async (t) => {
    const f = await setup(t, 'parallel', 1)
    const a = await f.run('task', input('CHILD_SEED_A'))
    const b = await f.run('task', input('CHILD_SEED_B'))
    const release = f.deferred()
    f.handle('CHILD_RACE', async (step) => {
      if (step === 1) {
        await release.promise
        return tool('read', { path: 'seed.txt' })
      }
      return answer('RACE_DONE')
    })
    f.custom(async (ctx, signal) => {
      const outcomes = await Promise.all(
        [a, b].map(async (seed) => {
          const outcome = await ctx.executeTool(
            'task_send',
            { task_id: seed.result.details.task_id, content: 'CHILD_RACE' },
            { signal }
          )
          if (outcome.isError) {
            release.resolve()
          }
          return outcome
        })
      )
      return { content: [], details: { outcomes } }
    })
    const first = await f.run('owned_custom', {}, 'race-root')
    const outcomes = first.result.details.outcomes
    assert.equal(outcomes.filter((entry) => !entry.isError).length, 1)
    busy(outcomes.find((entry) => entry.isError))
    const admitted = outcomes.find((entry) => !entry.isError).result.details.task_id
    assert.equal(f.controller.engine.state.tasks.length, 3)
    const holder = await f.saturate(1)
    const before = f.counts.get('CHILD_RACE')
    const replay = await f.run('owned_custom', {}, 'race-root')
    assert.equal(
      replay.result.details.outcomes.find((entry) => !entry.isError).result.details.task_id,
      admitted
    )
    busy(replay.result.details.outcomes.find((entry) => entry.isError))
    assert.equal(f.counts.get('CHILD_RACE'), before)
    assert.equal(f.controller.engine.state.tasks.length, 4)
    holder.release()
    await f.drain()
    assert.equal(f.notifications.length, 1)
  }
)

test(
  'parallel: stop cleanup retains capacity and a nested idle send gets BUSY without creating a continuation',
  { timeout: 8000 },
  async (t) => {
    const f = await setup(t, 'parallel', 1)
    const seed = await f.run('task', input('CHILD_SEED'))
    const entered = f.deferred(),
      release = f.deferred()
    f.hook(async (event) => {
      if (event.toolName === 'write') {
        entered.resolve()
        await release.promise
      }
    })
    const holder = await f.saturate(1)
    holder.release()
    await entered.promise
    f.custom(async (ctx, signal) => {
      const stopping = ctx.executeTool(
        'task_stop',
        { task_id: holder.tasks[0].task_id },
        { signal }
      )
      await waitFor(() =>
        f.controller.engine.state.tasks.some((entry) => entry.status === 'stopping')
      )
      assert.equal(f.controller.engine.runtimes.size, 1)
      const outcome = await ctx.executeTool(
        'task_send',
        { task_id: seed.result.details.task_id, content: 'CHILD_NOT_ADMITTED' },
        { signal }
      )
      busy(outcome)
      assert.equal(f.controller.engine.state.tasks.length, 2)
      release.resolve()
      const stopped = await stopping
      return { content: [], details: { outcome, stopped } }
    })
    const result = await f.run('owned_custom', {})
    assert.equal(result.result.details.stopped.result.details.status, 'canceled')
    await f.drain()
    assert.equal(f.counts.get('CHILD_NOT_ADMITTED'), undefined)
    await assert.rejects(readFile(join(f.cwd, 'CHILD_BG_0.txt')), { code: 'ENOENT' })
  }
)
