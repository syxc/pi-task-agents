import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { answer, fixture, tool } from './pi-backend-test-helpers.ts'

function previous(f: Awaited<ReturnType<typeof fixture>>) {
  const message = f
    .session()
    .messages.findLast(
      (message) => message.role === 'toolResult' && message.toolName === 'bash_task'
    )
  assert.ok(message && message.role === 'toolResult')
  return JSON.parse(
    message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
  )
}

test(
  'native managed-command writes reach the Worker tool-target observation before settlement',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      child = await f.child({ name: 'worker', tools: ['bash'] })
    const target = join(f.cwd, 'managed-observed.txt')
    let id = ''
    f.script((step) => {
      if (step === 1) {
        return tool('bash_task', {
          action: 'start',
          command: `printf changed > ${JSON.stringify(target)}`
        })
      }
      if (step === 2) {
        id = previous(f).command_id
        return answer('WAIT_FOR_WRITE')
      }
      if (step === 3) {
        return tool('bash_task', { action: 'output', command_id: id })
      }
      assert.equal(step, 4)
      assert.equal(previous(f).status, 'succeeded')
      return answer('WRITE_COMPLETE')
    })
    const result = await child.prompt(
      'Run the assigned managed command and report its completed write.'
    )
    assert.equal(result.text, 'WRITE_COMPLETE')
    assert.equal(await readFile(target, 'utf8'), 'changed')
    assert.equal(result.verification?.fileChange, 'change_observed')
    assert.ok(result.verification?.changedFiles?.includes('managed-observed.txt'))
    assert.equal(result.verification?.modelVerdict, undefined)
  }
)

test(
  'stopped managed Bash preserves confirmed partial writes and reports observation uncertainty',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      child = await f.child({ name: 'worker', tools: ['bash'] })
    const target = join(f.cwd, 'managed-partial.txt')
    let id = ''
    f.script((step) => {
      if (step === 1) {
        return tool('bash_task', {
          action: 'start',
          command: `printf partial > ${JSON.stringify(target)}; printf PARTIAL_WRITE_READY; sleep 30`
        })
      }
      if (step === 2) {
        id = previous(f).command_id
        return tool('bash_task', { action: 'output', command_id: id, wait_ms: 5000 })
      }
      if (step === 3) {
        assert.match(previous(f).output, /PARTIAL_WRITE_READY/)
        return tool('bash_task', { action: 'stop', command_id: id })
      }
      if (step === 4) {
        return tool('bash_task', { action: 'output', command_id: id, offset: 0 })
      }
      assert.equal(step, 5)
      assert.equal(previous(f).status, 'canceled')
      return answer('PARTIAL_WRITE_RETAINED')
    })
    const result = await child.prompt(
      'Stop the assigned managed command after its first write and retain the evidence.'
    )
    assert.equal(result.text, 'PARTIAL_WRITE_RETAINED')
    assert.equal(await readFile(target, 'utf8'), 'partial')
    assert.equal(result.verification?.fileChange, 'uncertain')
    assert.ok(result.verification?.changedFiles?.includes('managed-partial.txt'))
  }
)
