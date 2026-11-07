import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { TaskCallAncestry } from '../src/task-call-ancestry.ts'
import { busy, input, setup } from './nested-foreground-test-helpers.ts'

test('missing or copied hook arguments are unknown, never proof of a direct invocation', () => {
  const ancestry = new TaskCallAncestry()
  const ctx = { sessionManager: { getSessionId: () => 'owner' } } as ExtensionContext
  assert.equal(ancestry.take('task', 'unobserved', {}, ctx), 'unknown')
  for (const nested of [false, true]) {
    const args = input('CLONED_ARGUMENTS')
    ancestry.observe(
      {
        type: 'tool_call',
        toolName: 'task',
        toolCallId: 'same-id',
        input: args,
        ...(nested ? { parentToolCallId: 'caller' } : {})
      },
      ctx
    )
    assert.equal(ancestry.take('task', 'same-id', structuredClone(args), ctx), 'unknown')
    assert.equal(ancestry.take('task', 'same-id', args, ctx), nested ? 'nested' : 'direct')
    assert.equal(
      ancestry.take('task', 'same-id', args, ctx),
      'unknown',
      'A consumed marker cannot authorize another call'
    )
  }
})

for (const firstNested of [true, false]) {
  test(`shared argument object and ID stay unknown: ${firstNested ? 'nested-first' : 'direct-first'}`, () => {
    const ancestry = new TaskCallAncestry()
    const ctx = { sessionManager: { getSessionId: () => 'owner' } } as ExtensionContext
    for (const name of ['task', 'task_send']) {
      const args = { prompt: 'SHARED_ARGUMENTS' }
      const observe = (nested: boolean) =>
        ancestry.observe(
          {
            type: 'tool_call',
            toolName: name,
            toolCallId: 'shared-id',
            input: args,
            ...(nested ? { parentToolCallId: 'caller' } : {})
          },
          ctx
        )
      observe(firstNested)
      observe(!firstNested)
      assert.equal(ancestry.take(name, 'shared-id', args, ctx), 'unknown')
      assert.equal(ancestry.take(name, 'shared-id', args, ctx), 'unknown')
      observe(false)
      assert.equal(
        ancestry.take(name, 'shared-id', args, ctx),
        'unknown',
        'Another direct hook cannot reauthorize ambiguous shared args'
      )
    }
  })
}

for (const transformation of ['no-event', 'copied-direct', 'copied-nested']) {
  for (const name of ['task', 'task_send']) {
    test(
      `simulated SDK ${transformation}: full-capacity ${name} cannot bypass the real engine guard`,
      { timeout: 10000 },
      async (t) => {
        const f = await setup(t, 'parallel', 1)
        const seed = await f.run('task', input('CHILD_SEED'))
        const holder = await f.saturate(1)
        const params =
          name === 'task'
            ? input('CHILD_UNKNOWN_ORIGIN')
            : { task_id: seed.result.details.task_id, content: 'CHILD_UNKNOWN_ORIGIN' }
        const invocationId = 'simulated-sdk-invocation'
        f.custom(async (ctx, signal) => {
          const hookArgs = structuredClone(params)
          // Simulate a peer SDK omitting the hook or copying args between the
          // public hook and the registered wrapper. Do not patch the installed SDK.
          if (transformation !== 'no-event') {
            await f.session.extensionRunner.emitToolCall({
              type: 'tool_call',
              toolName: name,
              toolCallId: invocationId,
              input: hookArgs,
              ...(transformation === 'copied-nested'
                ? { parentToolCallId: 'simulated-parent' }
                : {})
            })
          }
          const executionArgs = structuredClone(hookArgs)
          return ctx.tools
            .find((entry) => entry.name === name)
            .execute(invocationId, executionArgs, signal, () => {})
        })
        const before = JSON.stringify(f.controller.engine.state)
        const rejected = await f.run('owned_custom', {})
        busy(rejected)
        assert.match(rejected.result.details.error_message, /unverified-origin/)
        assert.equal(JSON.stringify(f.controller.engine.state), before)
        assert.equal(f.counts.get('CHILD_UNKNOWN_ORIGIN'), undefined)
        holder.release()
        await f.drain()

        // Unknown provenance is restricted only when full. Its terminal receipt
        // must still replay before the guard when the owner fills again.
        const admitted = await f.run('owned_custom', {})
        assert.equal(admitted.result.details.status, 'succeeded')
        const taskId = admitted.result.details.task_id
        const replayHolder = await f.saturate(1, 'CHILD_UNKNOWN_REPLAY_HOLD')
        const taskCount = f.controller.engine.state.tasks.length
        const replay = await f.run('owned_custom', {})
        assert.equal(replay.result.details.task_id, taskId)
        assert.equal(replay.result.details.status, 'succeeded')
        assert.equal(f.controller.engine.state.tasks.length, taskCount)
        replayHolder.release()
        await f.drain()
      }
    )
  }
}
