import test from 'node:test'
import assert from 'node:assert/strict'
import {
  E2E_ENABLED,
  E2E_TERRA,
  createEnvironment,
  finishScenario,
  readChildMetrics
} from './harness.ts'

test(
  'children inherit the parent terra model when no role overrides exist',
  { skip: E2E_ENABLED ? false : 'set PI_E2E=1 to run real-model e2e', timeout: 240_000 },
  async () => {
    const startedAt = Date.now()
    const environment = await createEnvironment({
      parentModel: E2E_TERRA,
      childModel: null
    })
    const client = await environment.spawnRpc()
    try {
      const { from } = await client.promptAndSettle(
        [
          'Call the task tool exactly once with agent_name "worker", description "inherit model", run_in_background false, and prompt:',
          '"Do not use tools. Reply exactly INHERIT_CHILD_OK."',
          'After it returns, reply exactly INHERIT_PARENT_DONE.'
        ].join(' ')
      )
      const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
      assert.ok(taskEnd)
      assert.equal(taskEnd.isError, false)
      assert.equal(taskEnd.details.status, 'succeeded')
      assert.equal(taskEnd.details.final_text, 'INHERIT_CHILD_OK')
      const child = await readChildMetrics(environment.agentDir)
      assert.deepEqual(child.models, [`openai-codex/${E2E_TERRA}`])
      await client.waitForAssistantText('INHERIT_PARENT_DONE', { from })
      await finishScenario('model-inheritance', startedAt, client, environment, {
        parentTokens: 40_000,
        childTokens: 20_000
      })
    } finally {
      await environment.dispose()
    }
  }
)
