import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { createChildMessageWindow } from '../src/child-message-window.ts'

type Entry = {
  id: string
  type: 'message'
  message: { role: string; content: string | { type: 'text'; text: string }[] }
}

const message = (id: string, role: 'user' | 'assistant', text: string): Entry => ({
  id,
  type: 'message',
  message: { role, content: [{ type: 'text', text }] }
})

const manager = (entries: Entry[], branch: Entry[]): SessionManager =>
  ({
    getEntries: () => entries,
    getBranch: () => branch
  }) as unknown as SessionManager

test('committed window reads assistants after the observed root', () => {
  const entries: Entry[] = [message('old', 'user', 'old turn')]
  const branch = [...entries]
  const window = createChildMessageWindow(manager(entries, branch))
  const run = {}
  window.begin(run)
  const root = message('root', 'user', 'current prompt')
  const answer = message('answer', 'assistant', 'current answer')
  entries.push(root, answer)
  branch.push(root, answer)
  window.observe(run, root.message)
  window.observe(run, answer.message)
  assert.deepEqual(window.read(run), { available: true, text: 'current answer' })
})

test('committed window keeps an empty result when no root message was observed', () => {
  const entries: Entry[] = [message('old', 'user', 'old turn')]
  const branch = [...entries]
  const window = createChildMessageWindow(manager(entries, branch))
  const run = {}
  window.begin(run)
  assert.deepEqual(window.read(run), { available: true, text: '' })
})

test('committed window rejects an observed root that left the active branch', () => {
  const entries: Entry[] = []
  const branch: Entry[] = []
  const window = createChildMessageWindow(manager(entries, branch))
  const run = {}
  window.begin(run)
  const root = message('root', 'user', 'current prompt')
  const answer = message('answer', 'assistant', 'uncommitted answer')
  entries.push(root, answer)
  branch.push(answer)
  window.observe(run, root.message)
  window.observe(run, answer.message)
  assert.deepEqual(window.read(run), { available: false, text: '' })
})
