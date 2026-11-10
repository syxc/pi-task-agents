import test from 'node:test'
import assert from 'node:assert/strict'
import {
  E2E_LUNA,
  createEnvironment,
  e2eOptions,
  finishScenario,
  isRecord,
  notificationTaskIds,
  readChildTasks,
  requiredString
} from './harness.ts'

test(
  'background task completion wakes the parent with a notification',
  e2eOptions(240_000),
  async () => {
    const startedAt = Date.now()
    const environment = await createEnvironment({ parentModel: E2E_LUNA })
    const client = await environment.spawnRpc()
    try {
      const { from } = await client.promptAndSettle(
        [
          'Call the task tool exactly once with agent_name "worker", description "background sleep", run_in_background true, and prompt:',
          '"Run bash with the command sleep 2, wait for it to finish, then reply exactly BG_CHILD_DONE. Do not use other tools."',
          'After the task tool returns, reply exactly BG_LAUNCHED.',
          'When a completion notification for that task arrives, reply exactly BG_NOTICE_SEEN and stop. Do not call other tools.'
        ].join(' ')
      )
      const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
      assert.ok(taskEnd, 'task tool did not run')
      assert.equal(taskEnd.isError, false)
      assert.equal(taskEnd.details.status, 'started')
      const taskId = requiredString(taskEnd.details.task_id, 'task_id')

      const launched = await client.waitForAssistantText('BG_LAUNCHED', { from })
      assert.ok(launched)

      const notification = await client.waitForEvent(
        (event) => notificationTaskIds(event).includes(taskId),
        { from: taskEnd.index + 1, timeoutMs: 120_000, label: `notification for ${taskId}` }
      )
      const message = notification.event.message
      assert.ok(isRecord(message))
      assert.equal(message.role, 'custom')
      assert.equal(message.customType, 'pi-task-agents:result')
      assert.ok(isRecord(message.details))
      assert.equal(message.details.task_id, taskId)
      assert.equal(message.details.status, 'succeeded')

      const notice = await client.waitForAssistantText('BG_NOTICE_SEEN', {
        from: notification.index + 1
      })
      assert.ok(notice)

      const store = await readChildTasks(environment.agentDir)
      const stored = store.tasks.find((task) => task.task_id === taskId)
      assert.ok(stored, 'task store has no record of the background task')
      assert.equal(stored.status, 'succeeded')

      await finishScenario('background-notification', startedAt, client, environment)
    } finally {
      await environment.dispose()
    }
  }
)

test(
  'parallel background tasks deliver notifications for both tasks',
  e2eOptions(300_000),
  async () => {
    const startedAt = Date.now()
    const environment = await createEnvironment({ parentModel: E2E_LUNA })
    const client = await environment.spawnRpc()
    try {
      const { from } = await client.promptAndSettle(
        [
          'Call the task tool twice with run_in_background true.',
          'First call: agent_name "worker", description "parallel one", prompt: "Run bash with the command sleep 3, wait for it to finish, then reply exactly PARALLEL_ONE. Do not use other tools."',
          'Second call: agent_name "worker", description "parallel two", prompt: "Run bash with the command sleep 3, wait for it to finish, then reply exactly PARALLEL_TWO. Do not use other tools."',
          'After both calls return, reply exactly TWO_LAUNCHED.',
          'Each time a completion notification arrives, reply exactly NOTICE_BATCH and stop. Do not call other tools.'
        ].join(' ')
      )
      const taskEnds = await client.waitForToolEnds('task', 2, { from })
      assert.equal(taskEnds.length, 2)
      for (const end of taskEnds) {
        assert.equal(end.details.status, 'started')
      }
      const known = taskEnds.map((end) => requiredString(end.details.task_id, 'task_id'))
      assert.equal(new Set(known).size, 2)

      const seen = new Set<string>()
      let cursor = Math.max(...taskEnds.map((end) => end.index)) + 1
      while (seen.size < 2) {
        // oxlint-disable-next-line no-await-in-loop -- Each notification batch starts the wait for the next unseen task.
        const match = await client.waitForEvent(
          (event) => notificationTaskIds(event).some((id) => known.includes(id) && !seen.has(id)),
          { from: cursor, timeoutMs: 150_000, label: 'notifications for both tasks' }
        )
        for (const id of notificationTaskIds(match.event)) {
          if (known.includes(id)) {
            seen.add(id)
          }
        }
        cursor = match.index + 1
      }
      assert.deepEqual([...seen].sort(), [...known].sort())

      const notice = await client.waitForAssistantText('NOTICE_BATCH', { from })
      assert.ok(notice)

      const store = await readChildTasks(environment.agentDir)
      const stored = known.map((id) => store.tasks.find((task) => task.task_id === id))
      for (const task of stored) {
        assert.ok(task, 'task store is missing a parallel task')
        assert.equal(task.status, 'succeeded')
      }
      const windows = stored.filter(isRecord)
      const start = Math.max(...windows.map((task) => Date.parse(String(task.started_at))))
      const finish = Math.min(...windows.map((task) => Date.parse(String(task.finished_at))))
      assert.ok(
        Number.isFinite(start) && Number.isFinite(finish) && start < finish,
        'parallel tasks did not overlap in execution'
      )

      await finishScenario('parallel-background', startedAt, client, environment)
    } finally {
      await environment.dispose()
    }
  }
)
