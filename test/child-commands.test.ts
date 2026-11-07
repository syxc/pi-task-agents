import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { answer, fixture, tool } from './pi-backend-test-helpers.ts'

for (const role of ['worker', 'verifier', 'mavis']) {
  test(
    `${role} owns a native background command and settles its result in the same logical task`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t)
      const child = await f.child({ name: role, tools: ['bash'] })
      assert.ok(f.session().getActiveToolNames().includes('bash_task'))
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(()=>console.log('OWNED_COMMAND_中🙂'),40)")}`
      let calls = 0
      f.script((step, context) => {
        calls++
        if (step === 1) {
          return tool('bash_task', { action: 'start', command })
        }
        if (step === 2) {
          return answer('PREMATURE_PARENT_HANDOFF')
        }
        if (step === 3) {
          assert.match(JSON.stringify(context), /Owned background Bash commands finished/)
          const start = f
            .session()
            .messages.find(
              (message) => message.role === 'toolResult' && message.toolName === 'bash_task'
            )
          assert.ok(start && start.role === 'toolResult')
          const text = start.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
          const id = JSON.parse(text).command_id
          assert.match(id, /^bg_/)
          return tool('bash_task', { action: 'output', command_id: id })
        }
        assert.equal(step, 4)
        assert.match(JSON.stringify(context), /OWNED_COMMAND_中/)
        return answer(
          role === 'verifier' ? 'VERDICT: PASS\nCOMMAND_ACKNOWLEDGED' : 'COMMAND_ACKNOWLEDGED'
        )
      })
      const result = await child.prompt(
        'Run only this owned command and read its result before reporting.',
        { turnId: `same-logical-${role}` }
      )
      assert.equal(result.subTurnId, `same-logical-${role}`)
      assert.equal(result.outcome?.status, 'succeeded')
      assert.equal(calls, 4)
      assert.doesNotMatch(result.text, /PREMATURE_PARENT_HANDOFF/)
      assert.match(result.text, /COMMAND_ACKNOWLEDGED/)
    }
  )
}

test(
  'native streamed output exceeds the SDK result cap, remains complete and survives child recreation',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      child = await f.child({ name: 'worker', tools: ['bash'] })
    const size = 2 * 1024 * 1024,
      ending = 'REQUIRED_END_RISK_尾🙂'
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write('x'.repeat(${size})+${JSON.stringify(ending)})`)}`
    const sources = new Set<string>()
    f.session().subscribe((event) => {
      if (event.type !== 'tool_execution_update' || event.toolName !== 'bash') {
        return
      }
      const details = event.partialResult.details
      if (
        details &&
        typeof details === 'object' &&
        'fullOutputPath' in details &&
        typeof details.fullOutputPath === 'string'
      ) {
        sources.add(details.fullOutputPath)
      }
    })
    t.after(async () => {
      /* oxlint-disable no-await-in-loop -- Finish owned file cleanup before removing the shared fixture. */
      for (const source of sources) {
        await unlink(source).catch(() => {})
      }
      /* oxlint-enable no-await-in-loop */
    })
    let commandId = '',
      result = '',
      reads = 0
    const lastReply = () => {
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
    f.script((step, context) => {
      if (step === 1) {
        return tool('bash_task', { action: 'start', command })
      }
      if (step === 2) {
        commandId = lastReply().command_id
        return answer('WAIT_FOR_OUTPUT')
      }
      if (step > 3) {
        const value = lastReply()
        reads++
        assert.equal(value.status, 'succeeded')
        assert.notEqual(value.output_incomplete, true)
        assert.ok(Buffer.byteLength(value.output) <= 8192)
        result += value.output
        assert.equal(value.next_offset, Buffer.byteLength(result))
        if (!value.truncated) {
          assert.match(JSON.stringify(context), /REQUIRED_END_RISK_尾/)
          return answer('OUTPUT_COMPLETE')
        }
      }
      return tool('bash_task', { action: 'output', command_id: commandId })
    })
    const terminal = await child.prompt(
      'Collect the complete command output, including the required risk at its end.'
    )
    assert.equal(terminal.text, 'OUTPUT_COMPLETE')
    assert.equal(result, 'x'.repeat(size) + ending)
    assert.ok(reads > 1)
    const sessionPath = f.session().sessionFile!
    const log = join(sessionPath + '.commands', commandId + '.log')
    assert.equal(await readFile(log, 'utf8'), result)
    assert.equal((await stat(log)).mode & 0o777, 0o600)
    assert.ok(
      (await stat(log)).nlink >= 2,
      'the live native source, not a truncated result, owns the saved bytes'
    )
    await child.dispose()
    const next = await f.child({ name: 'worker', tools: ['bash'] }, sessionPath)
    f.script((step) =>
      step === 1
        ? tool('bash_task', { action: 'output', command_id: commandId, offset: size })
        : answer('HISTORICAL_RESULT_READ')
    )
    const replay = await next.prompt('Read the saved command result without replaying its process.')
    assert.equal(replay.text, 'HISTORICAL_RESULT_READ')
    assert.equal(lastReply().output, ending)
  }
)

test(
  'owned commands permit independent foreground work, incremental wait/read and an acknowledged stop without a duplicate wake',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      child = await f.child({ name: 'worker', tools: ['bash'] })
    let id = '',
      calls = 0
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('COMMAND_READY');setInterval(()=>{},1000)")}`
    const previous = () => {
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
    f.script((step, context) => {
      calls++
      if (step === 1) {
        return tool('bash_task', { action: 'start', command })
      }
      if (step === 2) {
        id = previous().command_id
        return tool('bash_task', { action: 'output', command_id: id, wait_ms: 30001 })
      }
      if (step === 3) {
        const value = previous()
        assert.equal(value.status, 'running')
        assert.equal(value.output, 'COMMAND_READY')
        assert.equal(value.wait_ms_clamped, true)
        assert.equal(value.effective_wait_ms, 30000)
        return tool('bash', { command: 'printf INDEPENDENT_FOREGROUND_WORK' })
      }
      if (step === 4) {
        assert.match(JSON.stringify(context), /INDEPENDENT_FOREGROUND_WORK/)
        return tool('bash_task', { action: 'stop', command_id: id })
      }
      if (step === 5) {
        assert.equal(previous().status, 'canceled')
        assert.notEqual(previous().cleanup_pending, true)
        return tool('bash_task', { action: 'output', command_id: id, offset: 0 })
      }
      assert.equal(step, 6)
      assert.equal(previous().status, 'canceled')
      assert.match(previous().output, /COMMAND_READY/)
      return answer('STOP_ACKNOWLEDGED')
    })
    const result = await child.prompt(
      'Continue independent work while the owned command runs, then stop and read it.'
    )
    assert.equal(result.text, 'STOP_ACKNOWLEDGED')
    assert.equal(calls, 6)
  }
)

test(
  'a native command timeout reports failure and returns through the same logical task',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      child = await f.child({ name: 'worker', tools: ['bash'] })
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('BEFORE_TIMEOUT');setInterval(()=>{},1000)")}`
    let id = ''
    f.script((step) => {
      const message = f
        .session()
        .messages.findLast(
          (message) => message.role === 'toolResult' && message.toolName === 'bash_task'
        )
      const value =
        message?.role === 'toolResult'
          ? JSON.parse(
              message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
            )
          : undefined
      if (step === 1) {
        return tool('bash_task', { action: 'start', command, timeout: 1 })
      }
      if (step === 2) {
        id = value.command_id
        return answer('TIMEOUT_PENDING')
      }
      if (step === 3) {
        return tool('bash_task', { action: 'output', command_id: id })
      }
      assert.equal(step, 4)
      assert.equal(value.status, 'failed')
      assert.match(value.output, /BEFORE_TIMEOUT/)
      assert.match(value.error.message, /timed out/i)
      assert.notEqual(value.cleanup_pending, true)
      return answer('TIMEOUT_CONFIRMED')
    })
    const result = await child.prompt(
      'Confirm the owned command timeout without losing its partial output.'
    )
    assert.equal(result.text, 'TIMEOUT_CONFIRMED')
  }
)

test(
  'native codemode can admit owned commands without ending their execution when the script returns',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { isCodemodeEnabled: () => true }),
      child = await f.child({ name: 'worker', tools: ['bash', 'codemode'] })
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(()=>console.log('CODEMODE_COMMAND_RESULT'),80)")}`
    let calls = 0
    f.script((step, context) => {
      calls++
      if (step === 1) {
        return tool('codemode', {
          code: `console.log(await tools.bash_task({action:'start',command:${JSON.stringify(command)}}))`
        })
      }
      if (step === 2) {
        return answer('SCRIPT_RETURNED_BUT_COMMAND_PENDING')
      }
      if (step === 3) {
        assert.match(JSON.stringify(context), /Owned background Bash commands finished/)
        return tool('codemode', {
          code: "const rows=await tools.bash_task({action:'list'}); console.log(await tools.bash_task({action:'output',command_id:rows.commands[0].command_id}));"
        })
      }
      assert.equal(step, 4)
      assert.match(JSON.stringify(context), /CODEMODE_COMMAND_RESULT/)
      return answer('CODEMODE_RESULT_READ')
    })
    const result = await child.prompt(
      'Use enabled native codemode to start and read the owned command.'
    )
    assert.equal(result.text, 'CODEMODE_RESULT_READ')
    assert.equal(calls, 4)
  }
)

test(
  'steering interrupts a pending-command settle without stopping the command or leaking the discarded reply',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      child = await f.child({ name: 'worker', tools: ['bash'] })
    const releaseFile = join(f.root, 'steered-release')
    const code = `const fs=require('node:fs');let done=false;const finish=()=>{if(done)return;done=true;w.close();console.log('STEERED_COMMAND_RESULT')};const w=fs.watch(${JSON.stringify(f.root)},(_e,f)=>{if(String(f)==='steered-release')finish()});if(fs.existsSync(${JSON.stringify(releaseFile)}))finish();`
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`
    let id = '',
      calls = 0,
      entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const unsubscribe = f.session().subscribe((event) => {
      if (event.type === 'agent_end') {
        unsubscribe()
        setImmediate(entered)
      }
    })
    f.script((step, context) => {
      calls++
      if (step === 1) {
        return tool('bash_task', { action: 'start', command })
      }
      if (step === 2) {
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
        return answer('DISCARDED_BEFORE_STEERING')
      }
      if (step === 3) {
        assert.match(JSON.stringify(context), /CONTINUE_INDEPENDENT_WORK/)
        return tool('bash', { command: `touch ${JSON.stringify(releaseFile)}` })
      }
      if (step === 4) {
        return answer('DISCARDED_BEFORE_COMMAND_RESULT')
      }
      if (step === 5) {
        return tool('bash_task', { action: 'output', command_id: id })
      }
      assert.equal(step, 6)
      assert.match(JSON.stringify(context), /STEERED_COMMAND_RESULT/)
      return answer('STEERING_AND_COMMAND_COMPLETE')
    })
    const pending = child.prompt('Start the owned command and retain the logical task.', {
      turnId: 'steered-logical-task'
    })
    try {
      await waiting
      await child.steer('CONTINUE_INDEPENDENT_WORK: release the owned command and read its result.')
      const result = await pending
      assert.equal(result.subTurnId, 'steered-logical-task')
      assert.equal(result.text, 'STEERING_AND_COMMAND_COMPLETE')
      assert.equal(calls, 6)
    } finally {
      await child.abort()
      await pending.catch(() => {})
    }
  }
)

test(
  'managed execution preserves native shell prefixes, environment and permission hooks',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, {
      sdk: {
        SettingsManager: {
          create: SettingsManager.create,
          fromStorage: SettingsManager.fromStorage,
          inMemory: (settings: object, options: Parameters<typeof SettingsManager.inMemory>[1]) =>
            SettingsManager.inMemory(
              {
                ...settings,
                compaction: { enabled: false },
                retry: { enabled: false },
                shellPath: '/bin/bash',
                shellCommandPrefix: 'export OWNED_COMMAND_PREFIX=expected-prefix'
              },
              options
            )
        }
      }
    })
    const extension = join(f.agentDir, 'deny-native-command.ts'),
      forbidden = join(f.cwd, 'must-not-exist')
    await writeFile(
      extension,
      "export default pi => pi.on('tool_call', event => { if (event.toolName === 'bash' && event.input.command.includes('OWNED_FORBIDDEN_EXECUTION')) return {block:true,reason:'OWNED_NATIVE_PERMISSION_DENIED'}; });"
    )
    const child = await f.child({ name: 'worker', tools: ['bash'], extensions: [extension] })
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write(process.env.OWNED_COMMAND_PREFIX)')}`
    let id = ''
    const previous = () => {
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
    f.script((step) => {
      if (step === 1) {
        return tool('bash_task', { action: 'start', command })
      }
      if (step === 2 || step === 5) {
        id = previous().command_id
        return answer('WAIT_FOR_NATIVE_RESULT')
      }
      if (step === 3 || step === 6) {
        return tool('bash_task', { action: 'output', command_id: id })
      }
      if (step === 4) {
        assert.equal(previous().output, 'expected-prefix')
        return tool('bash_task', {
          action: 'start',
          command: `printf OWNED_FORBIDDEN_EXECUTION > ${JSON.stringify(forbidden)}`
        })
      }
      assert.equal(step, 7)
      assert.equal(previous().status, 'failed')
      assert.match(previous().error.message, /OWNED_NATIVE_PERMISSION_DENIED/)
      return answer('PREFIX_AND_PERMISSION_CONFIRMED')
    })
    assert.equal(
      (await child.prompt('Use native prefix settings and respect the installed permission hook.'))
        .text,
      'PREFIX_AND_PERMISSION_CONFIRMED'
    )
    await assert.rejects(stat(forbidden), { code: 'ENOENT' })
  }
)

test('Explore and historical native ceilings cannot gain the private command surface', async (t) => {
  const f = await fixture(t)
  /* oxlint-disable no-await-in-loop -- Cases reuse the scripted runtime and current session; complete each case in order. */
  for (const [name, overrides] of [
    ['explore', {}],
    ['worker', { nativeToolSnapshot: ['bash'] }]
  ]) {
    await f.child(
      { name, tools: ['bash', 'bash_task'], ...overrides },
      join(f.root, `${name}.jsonl`)
    )
    assert.equal(f.session().getActiveToolNames().includes('bash_task'), false)
  }
  /* oxlint-enable no-await-in-loop */
})
