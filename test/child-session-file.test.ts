import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { prepareSession } from '../src/child-session-file.ts'

test('a crashed trailing child session record is skipped and repaired on resume', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-child-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace'),
    dir = join(root, 'sessions'),
    path = join(dir, 'child.jsonl')
  await Promise.all([mkdir(cwd), mkdir(dir, { recursive: true, mode: 0o700 })])
  const header = {
    type: 'session',
    version: 3,
    id: 'child-session',
    timestamp: new Date().toISOString(),
    cwd
  }
  const entry = {
    type: 'message',
    id: 'entry-1',
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'hello' }
  }
  await writeFile(
    path,
    [JSON.stringify(header), JSON.stringify(entry), '{"type":"message"'].join('\n'),
    { mode: 0o600 }
  )
  const manager = await prepareSession(path, cwd, SessionManager)
  assert.equal(manager.getSessionId(), 'child-session')
  assert.deepEqual(
    manager.getEntries().map((item) => item.id),
    ['entry-1']
  )
  assert.match(await readFile(path, 'utf8'), /"type":"message"\n$/)
})
