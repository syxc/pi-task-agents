import test from 'node:test'
import assert from 'node:assert/strict'
import {
  E2E_ENABLED,
  E2E_LUNA,
  createEnvironment,
  finishScenario,
  isRecord,
  requiredString
} from './harness.ts'

test(
  'task_output waits for terminal output and clamps long waits',
  { skip: E2E_ENABLED ? false : 'set PI_E2E=1 to run real-model e2e', timeout: 240_000 },
  async () => {
    const startedAt = Date.now()
    const environment = await createEnvironment({ parentModel: E2E_LUNA })
    const client = await environment.spawnRpc()
    try {
      const { from } = await client.promptAndSettle(
        [
          'Call the task tool exactly once with agent_name "worker", description "output wait", run_in_background true, and prompt:',
          '"Run bash with the command sleep 3, wait for it to finish, then reply exactly OUTPUT_READY. Do not use other tools."',
          'After it returns, call task_output with that task_id, offset 0, wait_ms 15000.',
          'Then call task_output again with the same task_id, offset 0, wait_ms 60000.',
          'Then reply exactly OUTPUT_FLOW_DONE.',
          'If a completion notification arrives, reply exactly OUTPUT_NOTICE and stop. Do not call other tools.'
        ].join(' ')
      )
      const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
      assert.ok(taskEnd, 'task tool did not run')
      const taskId = requiredString(taskEnd.details.task_id, 'task_id')

      const outputs = await client.waitForToolEnds('task_output', 2, { from: taskEnd.index + 1 })
      const [waited, clamped] = outputs
      assert.ok(waited && clamped)
      assert.equal(waited.isError, false)
      assert.equal(clamped.isError, false)
      assert.equal(waited.details.task_id, taskId)
      assert.equal(waited.details.status, 'succeeded')
      assert.equal(waited.details.effective_wait_ms, 15_000)
      assert.equal(waited.details.wait_ms_clamped, false)
      assert.equal(waited.details.timed_out, false)
      assert.match(waited.text, /OUTPUT_READY/u)

      assert.equal(clamped.details.status, 'succeeded')
      assert.equal(clamped.details.effective_wait_ms, 30_000)
      assert.equal(clamped.details.wait_ms_clamped, true)
      assert.equal(clamped.details.timed_out, false)
      assert.match(clamped.text, /OUTPUT_READY/u)
      // A terminal read returns immediately; the clamp hint only applies when the
      // wait actually expires while the task is active.
      assert.doesNotMatch(clamped.text, /task_output_hint/u)

      const reply = await client.waitForAssistantText('OUTPUT_FLOW_DONE', {
        from: taskEnd.index + 1
      })
      assert.ok(reply)
      assert.ok(isRecord(waited.details.verification))

      await finishScenario('task-output-wait', startedAt, client, environment)
    } finally {
      await environment.dispose()
    }
  }
)

test(
  'task_output clamps an expired long wait while the task is still running',
  { skip: E2E_ENABLED ? false : 'set PI_E2E=1 to run real-model e2e', timeout: 240_000 },
  async () => {
    const startedAt = Date.now()
    const environment = await createEnvironment({ parentModel: E2E_LUNA })
    const client = await environment.spawnRpc()
    try {
      const { from } = await client.promptAndSettle(
        [
          'Call the task tool exactly once with agent_name "worker", description "slow output", run_in_background true, and prompt:',
          '"Run bash with the command sleep 45, wait for it to finish, then reply exactly SLOW_DONE. Do not use other tools."',
          'After it returns, call task_output with that task_id, offset 0, wait_ms 60000.',
          'Wait for that call to finish before doing anything else; do not stop the task early.',
          'After task_output returns, call task_stop with that task_id and reason "e2e clamp".',
          'Then reply exactly CLAMP_FLOW_DONE. Do not call other tools.'
        ].join(' ')
      )
      const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
      assert.ok(taskEnd, 'task tool did not run')
      const taskId = requiredString(taskEnd.details.task_id, 'task_id')

      const [outputEnd] = await client.waitForToolEnds('task_output', 1, {
        from: taskEnd.index + 1
      })
      assert.ok(outputEnd, 'task_output did not run')
      assert.equal(outputEnd.isError, false)
      assert.equal(outputEnd.details.task_id, taskId)
      assert.equal(outputEnd.details.status, 'running')
      assert.equal(outputEnd.details.effective_wait_ms, 30_000)
      assert.equal(outputEnd.details.wait_ms_clamped, true)
      assert.equal(outputEnd.details.timed_out, true)
      assert.match(outputEnd.text, /wait_ms exceeded 30000/u)
      assert.match(outputEnd.text, /was capped at 30000/u)

      const [stopEnd] = await client.waitForToolEnds('task_stop', 1, {
        from: outputEnd.index + 1
      })
      assert.ok(stopEnd, 'task_stop did not run')
      assert.equal(stopEnd.isError, false)
      assert.equal(stopEnd.details.status, 'canceled')

      const reply = await client.waitForAssistantText('CLAMP_FLOW_DONE', {
        from: outputEnd.index + 1
      })
      assert.ok(reply)

      await finishScenario('task-output-clamp', startedAt, client, environment)
    } finally {
      await environment.dispose()
    }
  }
)

test(
  'task_stop cancels a running child and keeps output readable',
  { skip: E2E_ENABLED ? false : 'set PI_E2E=1 to run real-model e2e', timeout: 240_000 },
  async () => {
    const startedAt = Date.now()
    const environment = await createEnvironment({ parentModel: E2E_LUNA })
    const client = await environment.spawnRpc()
    try {
      const { from } = await client.promptAndSettle(
        [
          'Call the task tool exactly once with agent_name "worker", description "stop target", run_in_background true, and prompt:',
          '"Run bash with the command sleep 45, wait for it to finish, then reply exactly STOP_TARGET_DONE. Do not use other tools."',
          'After it returns, call task_stop with that task_id and reason "e2e stop".',
          'After it returns, call task_output with that task_id and offset 0.',
          'Then reply exactly STOP_FLOW_DONE. Do not call other tools.'
        ].join(' ')
      )
      const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
      assert.ok(taskEnd, 'task tool did not run')
      assert.equal(taskEnd.details.status, 'started')
      const taskId = requiredString(taskEnd.details.task_id, 'task_id')

      const [stopEnd] = await client.waitForToolEnds('task_stop', 1, { from: taskEnd.index + 1 })
      assert.ok(stopEnd, 'task_stop did not run')
      assert.equal(stopEnd.isError, false)
      assert.equal(stopEnd.details.task_id, taskId)
      assert.equal(stopEnd.details.status, 'canceled')
      assert.match(stopEnd.text, /is canceled/u)
      assert.ok(
        typeof stopEnd.durationMs === 'number' && stopEnd.durationMs < 30_000,
        'task_stop did not release the child promptly'
      )

      const [outputEnd] = await client.waitForToolEnds('task_output', 1, {
        from: stopEnd.index + 1
      })
      assert.ok(outputEnd, 'task_output did not run')
      assert.equal(outputEnd.isError, false)
      assert.equal(outputEnd.details.task_id, taskId)
      assert.equal(outputEnd.details.status, 'canceled')
      assert.doesNotMatch(outputEnd.text, /STOP_TARGET_DONE/u)

      const reply = await client.waitForAssistantText('STOP_FLOW_DONE', {
        from: stopEnd.index + 1
      })
      assert.ok(reply)

      await finishScenario('task-stop', startedAt, client, environment)
    } finally {
      await environment.dispose()
    }
  }
)
