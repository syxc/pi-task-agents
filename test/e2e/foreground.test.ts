import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  E2E_LUNA,
  createEnvironment,
  e2eOptions,
  finishScenario,
  isRecord,
  readChildMetrics,
  requiredString
} from './harness.ts'

test('foreground worker writes a file, query returns the task', e2eOptions(240_000), async () => {
  const startedAt = Date.now()
  const environment = await createEnvironment({ parentModel: E2E_LUNA })
  const client = await environment.spawnRpc()
  try {
    const { disposition, from } = await client.promptAndSettle(
      [
        'Call the task tool exactly once with agent_name "worker", description "write marker", run_in_background false, and prompt:',
        '"Use the write tool to create marker.txt in the working directory containing exactly FOREGROUND_OK and no other text. Then reply exactly CHILD_WRITE_DONE. Do not use other tools."',
        'After the task tool returns, call task_query with that task_id.',
        'Then call task_query with no arguments.',
        'Then reply exactly PARENT_FOREGROUND_DONE. Do not call any other tools.'
      ].join(' ')
    )
    assert.equal(disposition, 'started')

    const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
    assert.ok(taskEnd, 'task tool did not run')
    assert.equal(taskEnd.isError, false)
    assert.equal(taskEnd.details.status, 'succeeded')
    assert.equal(taskEnd.details.final_text, 'CHILD_WRITE_DONE')
    assert.equal(taskEnd.details.resolved_agent_name, 'worker')
    const taskId = requiredString(taskEnd.details.task_id, 'task_id')
    assert.ok(typeof taskEnd.details.event_count === 'number' && taskEnd.details.event_count > 0)
    const verification = taskEnd.details.verification
    assert.ok(isRecord(verification))
    assert.equal(verification.fileChange, 'change_observed')
    assert.ok(
      Array.isArray(verification.changedFiles) &&
        verification.changedFiles.some(
          (path) => typeof path === 'string' && path.endsWith('marker.txt')
        ),
      'verification did not report marker.txt'
    )

    const queries = await client.waitForToolEnds('task_query', 2, { from: taskEnd.index + 1 })
    assert.equal(queries[0]?.isError, false)
    assert.equal(queries[1]?.isError, false)
    const single = queries[0]?.details.task
    assert.ok(isRecord(single))
    assert.equal(single.task_id, taskId)
    assert.equal(single.status, 'succeeded')
    const list = queries[1]?.details
    assert.ok(isRecord(list))
    assert.ok(typeof list.count === 'number' && list.count >= 1)
    assert.ok(
      Array.isArray(list.tasks) &&
        list.tasks.some((task) => isRecord(task) && task.task_id === taskId)
    )

    const reply = await client.waitForAssistantText('PARENT_FOREGROUND_DONE', {
      from: taskEnd.index + 1
    })
    assert.ok(reply)
    const content = await readFile(join(environment.workspace, 'marker.txt'), 'utf8')
    assert.equal(content.trim(), 'FOREGROUND_OK')

    const child = await readChildMetrics(environment.agentDir)
    assert.deepEqual(child.models, [`openai-codex/${E2E_LUNA}`])
    assert.ok(child.assistantMessages >= 2)

    await finishScenario('foreground-worker', startedAt, client, environment)
  } finally {
    await environment.dispose()
  }
})
