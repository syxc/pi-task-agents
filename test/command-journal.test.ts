import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { CommandJournal, CommandLogs, COMMAND_ENTRY } from '../src/command-journal.ts'
import { createBackgroundTaskId } from '../src/vendor/mcode-background-task/id.ts'
import type { BackgroundTask } from '../src/vendor/mcode-background-task/types.ts'
import { utf8Output } from '../src/utf8-output.ts'

function row(manager: SessionManager, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: createBackgroundTaskId(),
    kind: 'bash',
    ownerSessionId: manager.getSessionId(),
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    metadata: { parentTurnId: 'opaque-native-turn' },
    ...overrides
  }
}

test('Pi journal preserves upstream task transitions and session-owned change events', async () => {
  const manager = SessionManager.inMemory()
  const journal = new CommandJournal(manager)
  await journal.restore()
  const task = row(manager, { status: 'queued' })
  const waiter = journal.waiters.create(`session:${manager.getSessionId()}`)
  await journal.create(task)
  assert.equal(await waiter.wait(50), 'event')
  waiter.cancel()
  await journal.patch(task.taskId, { status: 'running' })
  await journal.patch(task.taskId, { status: 'succeeded' })
  await assert.rejects(journal.patch(task.taskId, { status: 'running' }), /transition/i)
  const restored = new CommandJournal(manager)
  await restored.restore()
  assert.equal((await restored.get(task.taskId))?.status, 'succeeded')
})

test('history never replays active commands or claims they stopped, and rejects foreign/malformed records', async () => {
  const manager = SessionManager.inMemory()
  const task = row(manager)
  manager.appendCustomEntry(COMMAND_ENTRY, { version: 1, task })
  const journal = new CommandJournal(manager)
  await journal.restore()
  const lost = await journal.get(task.taskId)
  assert.equal(lost?.status, 'lost')
  assert.equal(lost?.metadata?.outputIncomplete, true)
  assert.match(lost?.lastError?.message ?? '', /not replayed or confirmed stopped/)
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const invalid of [
    { taskId: '../foreign' },
    { ownerSessionId: 'another-child' },
    { metadata: {} },
    { kind: 'agent' }
  ]) {
    const bad = SessionManager.inMemory()
    bad.appendCustomEntry(COMMAND_ENTRY, { version: 1, task: { ...row(bad), ...invalid } })
    await assert.rejects(new CommandJournal(bad).restore(), /Invalid owned-command history/)
  }
  /* oxlint-enable no-await-in-loop */
})

test('journal restores only the active branch, never a command from a sibling branch', async () => {
  const manager = SessionManager.inMemory()
  manager.appendCustomEntry('owned-branch-anchor', {})
  const anchor = manager.getLeafId()!
  const other = row(manager)
  manager.appendCustomEntry(COMMAND_ENTRY, { version: 1, task: other })
  manager.branch(anchor)
  const active = row(manager, { status: 'succeeded' })
  manager.appendCustomEntry(COMMAND_ENTRY, { version: 1, task: active })
  const journal = new CommandJournal(manager)
  await journal.restore()
  assert.equal(await journal.get(other.taskId), undefined)
  assert.equal((await journal.get(active.taskId))?.status, 'succeeded')
})

test('journal failure blocks new admission, retains dirty facts, and supports an explicit flush retry', async (t) => {
  const manager = SessionManager.inMemory()
  const journal = new CommandJournal(manager)
  const task = row(manager, { status: 'queued' })
  const writer = t.mock.method(manager, 'appendCustomEntry', () => {
    throw new Error('injected journal write failure')
  })
  await assert.rejects(journal.create(task), /injected journal write/)
  assert.equal(journal.dirty.has(task.taskId), true)
  assert.throws(() => journal.assertWritable(), /injected journal write/)
  writer.mock.restore()
  await journal.flush()
  journal.assertWritable()
  assert.equal(journal.dirty.size, 0)
  const restored = new CommandJournal(manager)
  await restored.restore()
  assert.equal((await restored.get(task.taskId))?.status, 'lost')
})

test('private logs have UTF-8 byte cursors, restrictive modes, bounded reads and no symlink/path inputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-command-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logs = new CommandLogs(join(root, 'child.jsonl'))
  const id = createBackgroundTaskId()
  const fd = logs.create(id)
  logs.append(fd, Buffer.from('中🙂Z'))
  logs.close(fd)
  assert.equal((await stat(logs.root)).mode & 0o777, 0o700)
  assert.equal((await stat(join(logs.root, id + '.log'))).mode & 0o777, 0o600)
  assert.deepEqual(logs.read(id, 0, 1), {
    output: '中',
    next_offset: 3,
    truncated: true,
    output_bytes: 8
  })
  assert.deepEqual(logs.read(id, 1, 1), {
    output: '🙂',
    next_offset: 7,
    truncated: true,
    output_bytes: 8
  })
  assert.equal(logs.read(id, 7, 1).output, 'Z')
  assert.throws(() => logs.read('../forbidden', 0), /Invalid command handle/)
  const alias = createBackgroundTaskId()
  await symlink(join(logs.root, id + '.log'), join(logs.root, alias + '.log'))
  assert.throws(() => logs.read(alias, 0), /ELOOP/)
  const linked = new CommandLogs(join(root, 'linked.jsonl'))
  await symlink(logs.root, linked.root)
  assert.throws(() => linked.create(createBackgroundTaskId()), /must not be a symlink/)
  assert.equal(await readFile(join(logs.root, id + '.log'), 'utf8'), '中🙂Z')
})

test('an incomplete final UTF-8 point stays unread until its remaining bytes arrive', () => {
  const bytes = Buffer.from('🙂')
  assert.deepEqual(utf8Output(bytes.subarray(0, 2)), {
    content: '',
    nextOffset: 0,
    truncated: true
  })
  assert.deepEqual(utf8Output(bytes, 0, 1), { content: '🙂', nextOffset: 4, truncated: false })
})
