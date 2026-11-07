import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { basename, join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { constants } from 'node:fs'
import test from 'node:test'
import { answer, deferred, fixture, tool } from './pi-backend-test-helpers.ts'

test(
  'native aborted Bash retries a streamed source that was unavailable until the metadata-free error',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      child = await f.child({ name: 'worker', tools: ['bash'] })
    const open = fs.open,
      ready = deferred()
    let blocked = true,
      denied = 0,
      source = '',
      id = ''
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (
        blocked &&
        typeof args[0] === 'string' &&
        /^pi-bash-[a-f0-9]{16}\.log$/.test(basename(args[0])) &&
        args[1] === (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      ) {
        denied++
        throw Object.assign(new Error('Native stream open has not completed'), { code: 'ENOENT' })
      }
      return open(...args)
    })
    syncBuiltinESMExports()
    const unsubscribe = f.session().subscribe((event) => {
      if (event.type === 'tool_execution_update' && event.toolName === 'bash') {
        const details = event.partialResult.details as { fullOutputPath?: string } | undefined
        if (details?.fullOutputPath) {
          source = details.fullOutputPath
          ready.resolve()
        }
      }
      if (event.type === 'tool_execution_end' && event.toolName === 'bash') {
        blocked = false
      }
    })
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('native-output:'.repeat(10000));setInterval(()=>{},1000)")}`
    f.script((step) => {
      if (step === 1) {
        return tool('bash_task', { action: 'start', command })
      }
      const receipt = f
        .session()
        .messages.find(
          (message) => message.role === 'toolResult' && message.toolName === 'bash_task'
        )
      assert.ok(receipt && receipt.role === 'toolResult')
      id = JSON.parse(
        receipt.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
      ).command_id
      return answer('WAITING_FOR_NATIVE_COMMAND')
    })
    const pending = child
      .prompt('Run only the assigned native command and wait for its result.')
      .catch((error) => error.partialResult)
    try {
      await ready.promise
      await child.abort()
      const result = await pending
      assert.equal(result.outcome.status, 'aborted')
      assert.ok(denied > 0)
      const native = await fs.readFile(source),
        saved = await fs.readFile(join(f.session().sessionFile! + '.commands', id + '.log'))
      assert.ok(native.length > 50000)
      assert.equal(saved.equals(native), true)
      const record = f
        .session()
        .sessionManager.getBranch()
        .findLast(
          (entry) => entry.type === 'custom' && entry.customType === 'pi-task-agents:command'
        )
      assert.ok(record?.type === 'custom')
      assert.equal(
        (record.data as { task: { metadata: { outputIncomplete: boolean } } }).task.metadata
          .outputIncomplete,
        false
      )
    } finally {
      blocked = false
      await child.abort()
      await pending
      unsubscribe()
      t.mock.restoreAll()
      syncBuiltinESMExports()
      if (source) {
        await fs.unlink(source).catch(() => {})
      }
    }
  }
)
