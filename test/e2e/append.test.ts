import test from 'node:test'
import assert from 'node:assert/strict'
import {
  E2E_LUNA,
  createEnvironment,
  e2eOptions,
  finishScenario,
  notificationTaskIds,
  readChildMetrics,
  readChildTasks,
  requiredString
} from './harness.ts'

test(
  'task_append activates an idle child and notifies on completion',
  e2eOptions(240_000),
  async () => {
    const startedAt = Date.now()
    const environment = await createEnvironment({ parentModel: E2E_LUNA })
    const client = await environment.spawnRpc()
    try {
      const { from } = await client.promptAndSettle(
        [
          'Call the task tool exactly once with agent_name "worker", description "remember append code", run_in_background false, and prompt:',
          '"Remember the exact codeword BETA-3 for a later question. Reply exactly READY_BETA. Do not use tools."',
          'After it returns, call task_append with that task_id and content "Reply with the codeword you were told to remember, and nothing else."',
          'After task_append returns, reply exactly APPEND_QUEUED and stop. Do not call other tools.',
          'When a task completion notification arrives later, call task_output with the notified task_id and offset 0, then reply exactly APPEND_FLOW_DONE.'
        ].join(' ')
      )
      const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
      assert.ok(taskEnd)
      assert.equal(taskEnd.isError, false)
      assert.equal(taskEnd.details.status, 'succeeded')
      assert.equal(taskEnd.details.final_text, 'READY_BETA')
      const taskId = requiredString(taskEnd.details.task_id, 'task_id')

      const [appendEnd] = await client.waitForToolEnds('task_append', 1, {
        from: taskEnd.index + 1
      })
      assert.ok(appendEnd)
      assert.equal(appendEnd.isError, false)
      assert.equal(appendEnd.details.mode, 'activated')
      assert.equal(appendEnd.details.accepted, true)
      const appendTaskId = requiredString(appendEnd.details.task_id, 'task_id')
      assert.notEqual(appendTaskId, taskId)
      await client.waitForAssistantText('APPEND_QUEUED', { from: taskEnd.index + 1 })

      const notice = await client.waitForEvent(
        (event) => notificationTaskIds(event).includes(appendTaskId),
        { from: appendEnd.index + 1, label: 'append completion notification' }
      )

      const [outputEnd] = await client.waitForToolEnds('task_output', 1, {
        from: notice.index + 1
      })
      assert.ok(outputEnd)
      assert.equal(outputEnd.isError, false)
      assert.equal(outputEnd.details.task_id, appendTaskId)
      assert.equal(outputEnd.details.status, 'succeeded')
      assert.equal(outputEnd.details.summary, 'BETA-3')
      await client.waitForAssistantText('APPEND_FLOW_DONE', { from: notice.index + 1 })

      const stored = await readChildTasks(environment.agentDir)
      assert.equal(stored.stores, 1)
      const original = stored.tasks.find((task) => task.task_id === taskId)
      const appended = stored.tasks.find((task) => task.task_id === appendTaskId)
      assert.ok(original && appended)
      assert.equal(
        requiredString(appended.session_id, 'append session_id'),
        requiredString(original.session_id, 'original session_id')
      )
      const child = await readChildMetrics(environment.agentDir)
      assert.equal(child.sessionFiles, 1)
      assert.ok(child.assistantMessages >= 2)

      await finishScenario('task-append', startedAt, client, environment)
    } finally {
      await environment.dispose()
    }
  }
)
