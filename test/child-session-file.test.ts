import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { assertSessionFile, prepareSession } from '../src/child-session-file.ts'

test('missing child sessions are reported as not found without masking other I/O errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-child-session-assert-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(assertSessionFile(join(root, 'missing.jsonl')), {
    code: 'TASK_CHILD_NOT_FOUND',
    status: 404
  })
  await symlink(join(root, 'loop'), join(root, 'loop'))
  await assert.rejects(assertSessionFile(join(root, 'loop', 'child.jsonl')), { code: 'ELOOP' })
})

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
