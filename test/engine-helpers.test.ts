import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTaskInput } from '../src/engine-helpers.ts'

test('task Skill selections normalize names without becoming paths', () => {
  const normalized = normalizeTaskInput({
    agent_name: 'worker',
    description: 'test',
    prompt: 'work',
    skills: [' Ａ ', 'A', 'B']
  })
  assert.deepEqual(normalized.skills, ['A', 'B'])
  assert.deepEqual(normalizeTaskInput({ description: 'test', prompt: 'work' }).skills, undefined)
  for (const skills of [[''], ['../escape'], ['..'], ['C:skill'], ['skill\\path']]) {
    assert.throws(
      () => normalizeTaskInput({ description: 'test', prompt: 'work', skills }),
      /Task skills/
    )
  }
})
