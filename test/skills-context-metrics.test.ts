import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readContextTrace, skillFixtures } from './e2e/skills-context-support.ts'

test('Skills e2e separates first-request context from later cached requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-skills-metrics-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'child.jsonl')
  const messages = [
    { type: 'thinking_level_change', thinkingLevel: 'high' },
    {
      type: 'message',
      message: {
        role: 'system',
        content: '',
        sections: { preamble: 'owned', skills: '<skills><skill>中文</skill></skills>' },
        toolsAdded: [{ name: 'read', parameters: { type: 'object' } }]
      }
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        usage: { input: 100, cacheRead: 200, cacheWrite: 30, output: 7 },
        content: [
          { type: 'toolCall', name: 'task_skill_search', arguments: { query: '中文' } },
          { type: 'toolCall', name: 'read', arguments: { path: '/owned/中文/SKILL.md' } }
        ]
      }
    },
    {
      type: 'message',
      message: { role: 'system', sections: { skills: '<skills></skills>' } }
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        usage: { input: 50, cacheRead: 1000, cacheWrite: 0, output: 9 },
        content: [{ type: 'text', text: 'done' }]
      }
    }
  ]
  await writeFile(path, messages.map((message) => JSON.stringify(message)).join('\n') + '\n')
  const trace = await readContextTrace(path)
  assert.equal(trace.firstPromptTokens, 330)
  assert.equal(trace.requests, 2)
  assert.equal(trace.advertisedSkills, 1)
  assert.equal(trace.systemChars, 'owned'.length + '<skills><skill>中文</skill></skills>'.length)
  assert.deepEqual(trace.skillReads, ['/owned/中文/SKILL.md'])
  assert.deepEqual(trace.toolCalls, ['task_skill_search', 'read'])
  assert.deepEqual(trace.thinkingLevels, ['high'])
})

test('Skills A/B fixtures keep dependency instructions out of the parent catalog', () => {
  const fixtures = skillFixtures(4)
  assert.equal(fixtures.length, 100)
  assert.equal(new Set(fixtures.map((skill) => skill.name)).size, 100)
  const bootstrap = fixtures.find((skill) => skill.name === 'bootstrap-code')
  const archive = fixtures.find((skill) => skill.name === 'archive-ledger')
  assert.ok(bootstrap && archive)
  assert.match(bootstrap.instructions, /archive-ledger/u)
  assert.doesNotMatch(archive.description, /bootstrap/iu)
  assert.doesNotMatch(fixtures.map((skill) => skill.description).join('\n'), /MAPLE|CEDAR/u)
})
