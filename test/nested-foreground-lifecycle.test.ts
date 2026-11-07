import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { busy, input, setup, waitFor } from './nested-foreground-test-helpers.ts'

for (const order of ['nested-first', 'direct-first']) {
  test(
    `real SDK identical nested/direct IDs remain distinct: ${order}`,
    { timeout: 10000 },
    async (t) => {
      const f = await setup(t, 'parallel', 1)
      const a = await f.run('task', input('CHILD_SEED_A'))
      const b = await f.run('task', input('CHILD_SEED_B'))
      const holder = await f.saturate(1)
      const nestedEntered = f.deferred(),
        directEntered = f.deferred()
      const permitNested = f.deferred(),
        permitDirect = f.deferred(),
        nestedDone = f.deferred()
      const collision = 'collision-root/1'
      let nestedOutcome, captured, pending, nestedArgs, directArgs
      const startNested = () => {
        pending = captured.executeTool('task_send', {
          task_id: a.result.details.task_id,
          content: 'NESTED_COLLISION'
        })
        pending.then(
          (outcome) => {
            nestedOutcome = outcome
            nestedDone.resolve()
          },
          () => nestedDone.resolve()
        )
      }
      f.api.on('tool_call', async (event) => {
        if (event.toolName !== 'task_send' || event.toolCallId !== collision) {
          return
        }
        if (event.parentToolCallId) {
          nestedArgs = event.input
          nestedEntered.resolve()
          await permitNested.promise
        } else {
          directArgs = event.input
          directEntered.resolve()
          await permitDirect.promise
        }
      })
      f.custom(async (ctx) => {
        captured = ctx
        if (order === 'nested-first') {
          startNested()
          await nestedEntered.promise
        }
        return { content: [], details: { detached: true } }
      })
      // The SDK prepares every top-level batch hook before executing that batch.
      // Use a real detached native invocation across turns so both hooks can be pending.
      await f.run('owned_custom', {}, 'collision-root')
      const before = f.controller.engine.state.tasks.length
      const running = f.run(
        'task_send',
        {
          task_id: b.result.details.task_id,
          content: 'DIRECT_COLLISION'
        },
        collision
      )
      if (order === 'direct-first') {
        await directEntered.promise
        startNested()
      }
      try {
        await Promise.all([nestedEntered.promise, directEntered.promise])
        assert.notEqual(
          nestedArgs,
          directArgs,
          'The SDK must provide distinct validated objects despite equal IDs'
        )
        if (order === 'nested-first') {
          permitNested.resolve()
          await nestedDone.promise
          busy(nestedOutcome)
        }
        permitDirect.resolve()
        await waitFor(() =>
          f.controller.engine.state.tasks.some(
            (entry) => entry.input.prompt === 'DIRECT_COLLISION' && entry.status === 'queued'
          )
        )
        permitNested.resolve()
        await nestedDone.promise
        busy(nestedOutcome)
        assert.equal(f.controller.engine.state.tasks.length, before + 1)
        assert.equal(
          f.controller.engine.state.tasks.some(
            (entry) => entry.input.prompt === 'NESTED_COLLISION'
          ),
          false
        )
        holder.release()
        await running
        const direct = f.session.messages.findLast(
          (entry) => entry.role === 'toolResult' && entry.toolCallId === collision
        )
        assert.equal(direct.details.status, 'succeeded')
        assert.notEqual(direct.isError, true)
        await f.drain()
      } finally {
        permitNested.resolve()
        permitDirect.resolve()
        holder.release()
        await f.controller.stopAll('Owned collision fixture cleanup')
        await running
        await pending
      }
    }
  )
}

test(
  'real SDK agent_end cannot erase a detached invocation still waiting in a permission hook',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t, 'sequential', 1)
    const seed = await f.run('task', input('CHILD_SEED'))
    const holder = await f.saturate(1)
    const entered = f.deferred(),
      permit = f.deferred()
    let pending,
      ended = false
    f.api.on('tool_call', async (event) => {
      if (event.toolName === 'task_send' && event.parentToolCallId) {
        entered.resolve()
        await permit.promise
      }
    })
    f.api.on('agent_end', () => {
      ended = true
    })
    f.custom(async (ctx, signal) => {
      pending = ctx.executeTool(
        'task_send',
        { task_id: seed.result.details.task_id, content: 'AFTER_END_NESTED' },
        { signal }
      )
      pending.catch(() => {})
      await entered.promise
      return { content: [], details: { detached: true } }
    })
    const before = JSON.stringify(f.controller.engine.state)
    await f.run('owned_custom', {}, 'detached-end')
    assert.equal(ended, true, 'This must be the real SDK agent_end, not a synthetic clear')
    permit.resolve()
    busy(await pending)
    assert.equal(JSON.stringify(f.controller.engine.state), before)
    holder.release()
    await f.drain()
    assert.equal(f.notifications.length, 1)
  }
)

test(
  'a canceled detached permission hook does not retain ancestry for a later direct invocation with the same ID',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t, 'sequential', 1)
    const seed = await f.run('task', input('CHILD_SEED'))
    const holder = await f.saturate(1)
    const entered = f.deferred(),
      permit = f.deferred()
    const cancel = new AbortController()
    let pending, argumentRef
    f.api.on('tool_call', async (event) => {
      if (event.toolName === 'task_send' && event.parentToolCallId) {
        argumentRef = new WeakRef(event.input)
        entered.resolve()
        await permit.promise
      }
    })
    f.custom(async (ctx) => {
      pending = ctx.executeTool(
        'task_send',
        { task_id: seed.result.details.task_id, content: 'CANCELED_PERMISSION' },
        { signal: cancel.signal }
      )
      pending.catch(() => {})
      await entered.promise
      return { content: [], details: {} }
    })
    await f.run('owned_custom', {}, 'cancel-detached')
    cancel.abort()
    permit.resolve()
    const canceled = await pending
    assert.equal(canceled.isError, true)
    assert.match(JSON.stringify(canceled.result), /aborted/i)
    assert.equal(f.controller.engine.state.tasks.length, 2)
    if (typeof globalThis.gc === 'function') {
      await delay(0)
      globalThis.gc()
      await delay(0)
      assert.equal(argumentRef.deref(), undefined)
    }
    const running = f.run(
      'task_send',
      { task_id: seed.result.details.task_id, content: 'DIRECT_AFTER_CANCEL' },
      'cancel-detached/1'
    )
    await waitFor(() =>
      f.controller.engine.state.tasks.some(
        (entry) => entry.input.prompt === 'DIRECT_AFTER_CANCEL' && entry.status === 'queued'
      )
    )
    holder.release()
    const direct = await running
    assert.equal(direct.result.details.status, 'succeeded')
    await f.drain()
  }
)

test(
  'SDK SessionManager replacement rejects old pending hook arguments instead of admitting them to the new owner',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t, 'sequential', 1)
    const seed = await f.run('task', input('CHILD_SEED'))
    const holder = await f.saturate(1)
    const entered = f.deferred(),
      permit = f.deferred()
    let pending
    f.api.on('tool_call', async (event) => {
      if (event.toolName === 'task_send' && event.parentToolCallId) {
        entered.resolve()
        await permit.promise
      }
    })
    f.custom(async (ctx, signal) => {
      pending = ctx.executeTool(
        'task_send',
        { task_id: seed.result.details.task_id, content: 'OLD_OWNER_PENDING' },
        { signal }
      )
      pending.catch(() => {})
      await entered.promise
      return { content: [], details: {} }
    })
    await f.run('owned_custom', {}, 'old-owner-root')
    const old = f.controller.engine
    const oldId = f.session.sessionManager.getSessionId()
    const shutdown = f.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'switch' })
    holder.release()
    await shutdown
    // Exercise replacement on the actual SDK manager and runner. A normal runtime
    // also invalidates the old runner; this intentionally tests the stricter reused-runner case.
    f.session.sessionManager.newSession()
    await f.session.extensionRunner.emit({ type: 'session_start', reason: 'switch' })
    assert.notEqual(f.session.sessionManager.getSessionId(), oldId)
    const current = f.controller.engine
    assert.notEqual(current, old)
    permit.resolve()
    const outcome = await pending
    assert.equal(outcome.isError, true)
    assert.equal(outcome.result.details.code, 'TASK_CALL_EXPIRED')
    assert.equal(outcome.result.details.admitted, false)
    assert.equal(outcome.result.details.task_id, undefined)
    assert.equal(old.state.tasks.length, 2)
    assert.equal(current.state.tasks.length, 0)
  }
)

test(
  'blocked SDK calls keep no strong reference to their validated arguments',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t, 'parallel', 1)
    const seed = await f.run('task', input('CHILD_SEED'))
    const args = []
    f.api.on('tool_call', (event) => {
      if (event.toolName === 'task_send' && event.parentToolCallId) {
        args.push(new WeakRef(event.input))
        return { block: true, reason: 'Owned permission denial' }
      }
    })
    f.custom(async (ctx, signal) => {
      /* oxlint-disable no-await-in-loop -- Finish each real blocked invocation before starting the next. */
      for (let i = 0; i < 32; i++) {
        const outcome = await ctx.executeTool(
          'task_send',
          { task_id: seed.result.details.task_id, content: 'DENIED_' + i },
          { signal }
        )
        assert.equal(outcome.isError, true)
      }
      /* oxlint-enable no-await-in-loop */
      return { content: [], details: {} }
    })
    await f.run('owned_custom', {})
    assert.equal(args.length, 32)
    assert.equal(f.controller.engine.state.tasks.length, 1)
    // The dedicated --expose-gc validation checks collection as well as behavior.
    if (typeof globalThis.gc === 'function') {
      await delay(0)
      globalThis.gc()
      await delay(0)
      assert.equal(args.filter((ref) => ref.deref() !== undefined).length, 0)
    }
    const direct = await f.run(
      'task_send',
      { task_id: seed.result.details.task_id, content: 'DIRECT_AFTER_DENIAL' },
      'phase-2/1'
    )
    assert.equal(direct.result.details.status, 'succeeded')
    assert.equal(f.controller.engine.state.tasks.length, 2)
  }
)
