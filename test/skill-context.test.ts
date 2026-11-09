import assert from 'node:assert/strict'
import test from 'node:test'
import type { Skill } from '@earendil-works/pi-coding-agent'
import { searchAuthorizedSkills } from '../src/skill-context.ts'

const skills = Array.from({ length: 23 }, (_, index) => ({
  name: `skill-${index}`,
  description: index === 21 ? 'Unicode Ａlpha support' : `Description ${index}`,
  filePath: `/authorized/skill-${index}/SKILL.md`
})) as Skill[]

test('Skill metadata search is Unicode-aware and paginates without truncation', () => {
  const first = searchAuthorizedSkills(skills)
  assert.equal(first.total, 23)
  assert.equal(first.skills.length, 10)
  assert.equal(first.has_more, true)
  assert.equal(first.next_offset, 10)

  const second = searchAuthorizedSkills(skills, '', first.next_offset ?? 0)
  assert.equal(second.skills.length, 10)
  assert.equal(second.next_offset, 20)
  const last = searchAuthorizedSkills(skills, '', second.next_offset ?? 0)
  assert.equal(last.skills.length, 3)
  assert.equal(last.has_more, false)
  assert.equal(last.next_offset, null)
  assert.deepEqual(
    searchAuthorizedSkills(skills, ' alpha ').skills.map((skill) => skill.name),
    ['skill-21']
  )
  assert.equal(searchAuthorizedSkills(skills, 'missing').total, 0)
})
