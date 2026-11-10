import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import {
  E2E_LUNA,
  createEnvironment,
  e2eOptions,
  finishScenario,
  readChildMetrics,
  requiredString
} from './harness.ts'

test('task_send continues the same idle child history', e2eOptions(240_000), async () => {
  const startedAt = Date.now()
  const environment = await createEnvironment({ parentModel: E2E_LUNA })
  const client = await environment.spawnRpc()
  try {
    const first = await client.promptAndSettle(
      [
        'Call the task tool exactly once with agent_name "worker", description "remember codeword", run_in_background false, and prompt:',
        '"Remember the exact codeword ALPHA-7 for a later question. Reply exactly READY_ALPHA. Do not use tools."',
        'After it returns, reply exactly SEND_PHASE_ONE.'
      ].join(' ')
    )
    const [taskEnd] = await client.waitForToolEnds('task', 1, { from: first.from })
    assert.ok(taskEnd)
    assert.equal(taskEnd.details.status, 'succeeded')
    assert.equal(taskEnd.details.final_text, 'READY_ALPHA')
    const taskId = requiredString(taskEnd.details.task_id, 'task_id')
    const subSessionId = requiredString(taskEnd.details.sub_session_id, 'session_id')

    const second = await client.promptAndSettle(
      [
        `Call task_send with task_id "${taskId}" and content "Reply with the codeword you were told to remember, and nothing else."`,
        'After it returns, reply exactly SEND_PHASE_TWO.'
      ].join(' ')
    )
    const [sendEnd] = await client.waitForToolEnds('task_send', 1, {
      from: second.from
    })
    assert.ok(sendEnd)
    assert.equal(sendEnd.isError, false)
    assert.equal(sendEnd.details.status, 'succeeded')
    assert.equal(sendEnd.details.final_text, 'ALPHA-7')
    assert.equal(sendEnd.details.session_id, subSessionId)

    const reply = await client.waitForAssistantText('SEND_PHASE_TWO', {
      from: second.from
    })
    assert.ok(reply)

    const child = await readChildMetrics(environment.agentDir)
    assert.equal(child.sessionFiles, 1)
    assert.ok(child.assistantMessages >= 2)

    await finishScenario('task-send', startedAt, client, environment)
  } finally {
    await environment.dispose()
  }
})

test(
  'a restarted parent resumes the persisted child through task_send',
  e2eOptions(300_000),
  async () => {
    const startedAt = Date.now()
    const environment = await createEnvironment({
      parentModel: E2E_LUNA,
      sessionId: 'e2e-resume'
    })
    try {
      const firstClient = await environment.spawnRpc()
      let taskId: string | undefined
      let subSessionId: string | undefined
      try {
        const first = await firstClient.promptAndSettle(
          [
            'Call the task tool exactly once with agent_name "worker", description "remember resume code", run_in_background false, and prompt:',
            '"Remember the exact codeword RESUME-9 for a later question. Reply exactly READY_RESUME. Do not use tools."',
            'After it returns, reply exactly RESUME_PHASE_ONE.'
          ].join(' ')
        )
        const [taskEnd] = await firstClient.waitForToolEnds('task', 1, { from: first.from })
        assert.ok(taskEnd)
        assert.equal(taskEnd.details.status, 'succeeded')
        assert.equal(taskEnd.details.final_text, 'READY_RESUME')
        taskId = requiredString(taskEnd.details.task_id, 'task_id')
        subSessionId = requiredString(taskEnd.details.sub_session_id, 'session_id')
        await firstClient.waitForAssistantText('RESUME_PHASE_ONE', { from: first.from })
      } finally {
        await firstClient.stop()
      }

      assert.ok(taskId)
      assert.ok(subSessionId)
      const sessionFiles = (await readdir(environment.sessionsDir)).filter((name) =>
        name.endsWith('.jsonl')
      )
      assert.ok(sessionFiles.length > 0, 'parent session was not persisted')

      const secondClient = await environment.spawnRpc()
      const second = await secondClient.promptAndSettle(
        [
          `Call task_send with task_id "${taskId}" and content "Reply with the codeword you were told to remember, and nothing else."`,
          'After it returns, reply exactly RESUME_PHASE_TWO.'
        ].join(' ')
      )
      const [sendEnd] = await secondClient.waitForToolEnds('task_send', 1, {
        from: second.from
      })
      assert.ok(sendEnd)
      assert.equal(sendEnd.isError, false)
      assert.equal(sendEnd.details.status, 'succeeded')
      assert.equal(sendEnd.details.final_text, 'RESUME-9')
      assert.equal(sendEnd.details.session_id, subSessionId)
      await secondClient.waitForAssistantText('RESUME_PHASE_TWO', { from: second.from })

      const child = await readChildMetrics(environment.agentDir)
      assert.equal(child.sessionFiles, 1)

      await finishScenario('restart-resume', startedAt, secondClient, environment)
    } finally {
      await environment.dispose()
    }
  }
)
