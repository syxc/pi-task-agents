import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { roleAllowsTool } from '../src/resource-selection.ts'
import { answer, fixture, tool } from './pi-backend-test-helpers.ts'

const parentControls = [
  'todo',
  'todowrite',
  'ask_user',
  'ask_user_question',
  'create_goal',
  'get_goal',
  'until'
]

test('all leaf roles reject parent planning, interactive questions and independent scheduling', () => {
  for (const role of ['explore', 'worker', 'verifier', 'mavis', 'agent:custom']) {
    for (const name of parentControls) {
      assert.equal(roleAllowsTool(role, name), false, role + ':' + name)
      assert.equal(roleAllowsTool(role, ' ' + name.toUpperCase() + ' '), false, name)
    }
    assert.equal(roleAllowsTool(role, 'memory_search'), true)
    assert.equal(roleAllowsTool(role, 'plugin_owned'), true)
    assert.equal(
      roleAllowsTool(role, 'mcp__owned__get_goal'),
      true,
      'Not an arbitrary substring ban'
    )
  }
})

test('real SDK removes only blocked extension tools, keeps hooks, and prevents their execution', async (t) => {
  const f = await fixture(t)
  const path = join(f.root, 'parent-controls.mjs')
  await writeFile(
    path,
    `export default pi => {
    pi.on('input', e => e.text === 'raw' ? { action: 'transform', text: 'owned transformed input' } : undefined);
    for (const name of ${JSON.stringify([...parentControls, 'plugin_owned', 'memory_search'])})
      pi.registerTool({ name, label: name, description: name,
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'EXTENSION_EXECUTED_' + name }], details: {} }) });
  };`
  )
  /* oxlint-disable no-await-in-loop -- Cases reuse the scripted runtime and current session; complete each case in order. */
  for (const role of ['explore', 'worker', 'verifier', 'mavis']) {
    const child = await f.child(
      { name: role, tools: ['read', ...parentControls], extensions: [path] },
      join(f.root, role + '.jsonl')
    )
    const callable = f.session().getCallableToolNames()
    for (const name of parentControls) {
      assert.equal(callable.includes(name), false, role + ':' + name)
    }
    assert.ok(callable.includes('plugin_owned'))
    assert.ok(callable.includes('memory_search'))
    f.script((step) => (step === 1 ? tool('create_goal', {}) : answer('done')))
    await child.prompt('raw')
    const history = JSON.stringify(f.session().messages)
    assert.match(history, /owned transformed input/)
    assert.doesNotMatch(history, /EXTENSION_EXECUTED_create_goal/)
    await child.dispose()
  }
  /* oxlint-enable no-await-in-loop */
})

test('shared delegated contract tells every role to return blockers and respect memory ownership', async (t) => {
  const f = await fixture(t)
  f.script((_step, context) => {
    const prompt =
      context.systemPrompt ??
      JSON.stringify(context.messages.filter((message) => message.role === 'system'))
    assert.match(prompt, /parent.*conversation|parent.*history/i)
    assert.match(prompt, /Do not ask.*user/i)
    assert.match(prompt, /blocker/i)
    assert.match(prompt, /schedul/i)
    assert.match(prompt, /Memory|memory/)
    assert.match(prompt, /child-owned/i)
    assert.match(prompt, /When codemode is enabled/)
    assert.match(prompt, /prefer direct tools for a single simple call/)
    assert.match(prompt, /concise handoff/)
    assert.match(prompt, /unless needed as evidence/)
    return answer()
  })
  /* oxlint-disable no-await-in-loop -- Cases reuse the scripted runtime and current session; complete each case in order. */
  for (const role of ['explore', 'worker', 'verifier', 'mavis']) {
    const child = await f.child({ name: role }, join(f.root, role + '.jsonl'))
    await child.prompt('Check delegated scope')
    await child.dispose()
  }
  /* oxlint-enable no-await-in-loop */
})
