import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  E2E_LUNA,
  createEnvironment,
  e2eOptions,
  finishScenario,
  isRecord,
  readChildMetrics
} from './harness.ts'

test('explore reports workspace evidence without changing files', e2eOptions(240_000), async () => {
  const startedAt = Date.now()
  const environment = await createEnvironment({ parentModel: E2E_LUNA })
  await writeFile(join(environment.workspace, 'notes.txt'), 'EXPLORE_TOKEN_9\n')
  const client = await environment.spawnRpc()
  try {
    const { from } = await client.promptAndSettle(
      [
        'Call the task tool exactly once with agent_name "explore", description "read notes", run_in_background false, and prompt:',
        '"Read notes.txt and reply with exactly its content. Do not modify any file."',
        'After it returns, reply exactly EXPLORE_DONE.'
      ].join(' ')
    )
    const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
    assert.ok(taskEnd)
    assert.equal(taskEnd.isError, false)
    assert.equal(taskEnd.details.status, 'succeeded')
    assert.equal(taskEnd.details.resolved_agent_name, 'explore')
    assert.equal(String(taskEnd.details.final_text).trim(), 'EXPLORE_TOKEN_9')
    const verification = taskEnd.details.verification
    assert.ok(isRecord(verification))
    assert.equal(verification.fileChange, 'no_observed_change')
    assert.deepEqual(verification.changedFiles, [])
    assert.equal(
      (await readFile(join(environment.workspace, 'notes.txt'), 'utf8')).trim(),
      'EXPLORE_TOKEN_9'
    )
    await client.waitForAssistantText('EXPLORE_DONE', { from })
    await finishScenario('explore-read-only', startedAt, client, environment)
  } finally {
    await environment.dispose()
  }
})

test('verifier ends with a parsed FAIL verdict', e2eOptions(240_000), async () => {
  const startedAt = Date.now()
  const environment = await createEnvironment({ parentModel: E2E_LUNA })
  await writeFile(
    join(environment.workspace, 'buggy.js'),
    'export function add(a, b) {\n  return a - b\n}\n'
  )
  const client = await environment.spawnRpc()
  try {
    const { from } = await client.promptAndSettle(
      [
        'Call the task tool exactly once with agent_name "verifier", description "review buggy add", run_in_background false, and prompt:',
        '"Review buggy.js. Its add function must return the sum of its arguments. Reply with exactly two lines: first a one-sentence description of the bug, then the line VERDICT: FAIL. Do not write the words PASS or PARTIAL anywhere. Do not modify any file."',
        'After it returns, reply exactly VERIFIER_DONE.'
      ].join(' ')
    )
    const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
    assert.ok(taskEnd)
    assert.equal(taskEnd.isError, false)
    assert.equal(taskEnd.details.status, 'succeeded')
    assert.equal(taskEnd.details.resolved_agent_name, 'verifier')
    assert.match(String(taskEnd.details.final_text), /VERDICT: FAIL/u)
    const verification = taskEnd.details.verification
    assert.ok(isRecord(verification))
    assert.equal(verification.modelVerdict, 'fail', String(taskEnd.details.final_text))
    await client.waitForAssistantText('VERIFIER_DONE', { from })
    await finishScenario('verifier-verdict', startedAt, client, environment)
  } finally {
    await environment.dispose()
  }
})

test('worker children inherit user skills', e2eOptions(240_000), async () => {
  const startedAt = Date.now()
  const environment = await createEnvironment({
    parentModel: E2E_LUNA,
    skills: [
      {
        name: 'magic-skill',
        description: 'Provides the project codeword. Use when asked for the project codeword.',
        instructions:
          'When you are asked for the project codeword, reply with exactly SKILL_MAGIC_42 and nothing else.'
      }
    ]
  })
  const client = await environment.spawnRpc()
  try {
    const { from } = await client.promptAndSettle(
      [
        'Call the task tool exactly once with agent_name "worker", description "use skill", run_in_background false, and prompt:',
        '"Read the SKILL.md file of the available skill named magic-skill, follow that skill, and reply with only the project codeword. Do not modify any file."',
        'After it returns, reply exactly SKILL_DONE.'
      ].join(' ')
    )
    const [taskEnd] = await client.waitForToolEnds('task', 1, { from })
    assert.ok(taskEnd)
    assert.equal(taskEnd.isError, false)
    assert.equal(taskEnd.details.status, 'succeeded')
    assert.match(String(taskEnd.details.final_text), /SKILL_MAGIC_42/u)
    const child = await readChildMetrics(environment.agentDir)
    assert.ok(child.assistantMessages >= 2)
    await client.waitForAssistantText('SKILL_DONE', { from })
    await finishScenario('skill-inheritance', startedAt, client, environment)
  } finally {
    await environment.dispose()
  }
})

test('invalid role and unknown task IDs return tool errors', e2eOptions(240_000), async () => {
  const startedAt = Date.now()
  const environment = await createEnvironment({ parentModel: E2E_LUNA })
  const client = await environment.spawnRpc()
  try {
    const { from } = await client.promptAndSettle(
      [
        'Run these four tool calls in order. Some are expected to fail; perform them exactly as written.',
        '1) task with agent_name "nope", description "invalid role", run_in_background false, prompt "noop". Use agent_name "nope" exactly even though it is invalid; do not substitute a valid role.',
        '2) task_send with task_id "does-not-exist", content "hello".',
        '3) task_append with task_id "does-not-exist", content "   ".',
        '4) task_agents with no arguments.',
        'Then reply exactly ERRORS_CHECKED. Do not retry failed calls and do not call other tools.'
      ].join(' ')
    )
    const [invalidRole] = await client.waitForToolEnds('task', 1, { from })
    assert.ok(invalidRole)
    assert.equal(invalidRole.isError, true, invalidRole.text)
    assert.match(invalidRole.text, /unknown role/u)

    const [unknownSend] = await client.waitForToolEnds('task_send', 1, {
      from: invalidRole.index + 1
    })
    assert.ok(unknownSend)
    assert.equal(unknownSend.isError, true)
    assert.equal(unknownSend.details.code, 'TASK_NOT_FOUND')

    const [emptyAppend] = await client.waitForToolEnds('task_append', 1, {
      from: unknownSend.index + 1
    })
    assert.ok(emptyAppend)
    assert.equal(emptyAppend.isError, true)
    assert.equal(emptyAppend.details.code, 'INVALID_ARGUMENT')

    const [agents] = await client.waitForToolEnds('task_agents', 1, {
      from: emptyAppend.index + 1
    })
    assert.ok(agents)
    assert.equal(agents.isError, false)
    const roles = agents.details.roles
    assert.ok(isRecord(roles))
    for (const name of ['explore', 'worker', 'verifier', 'mavis']) {
      assert.ok(isRecord(roles[name]), `task_agents is missing ${name}`)
    }

    await client.waitForAssistantText('ERRORS_CHECKED', { from })
    await finishScenario('error-boundaries', startedAt, client, environment, {
      requiresChildSession: false
    })
  } finally {
    await environment.dispose()
  }
})
