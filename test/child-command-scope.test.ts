import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createChildCommands } from '../src/child-commands.ts'
import { CommandOutput } from '../src/command-output.ts'

async function fixture(t: TestContext, nativeOutput?: string) {
  const root = await mkdtemp(join(tmpdir(), 'owned-command-scope-'))
  const controller = new AbortController()
  let turn = 'turn-A',
    definition: Parameters<ExtensionAPI['registerTool']>[0],
    release!: () => void,
    signal!: AbortSignal
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  const listeners = new Map<
    string,
    (event: {
      toolName: string
      input: Record<string, unknown>
    }) => { block: boolean; reason?: string } | undefined
  >()
  const commands = await createChildCommands({
    manager: SessionManager.inMemory(root),
    sessionPath: join(root, 'child.jsonl'),
    current: () => ({ id: turn, signal: controller.signal }),
    isNativeBash: () => true
  })
  await commands.extension({
    registerTool: (value: Parameters<ExtensionAPI['registerTool']>[0]) => {
      definition = value
    },
    on: (
      name: string,
      listener: (event: {
        toolName: string
        input: Record<string, unknown>
      }) => { block: boolean; reason?: string } | undefined
    ) => {
      listeners.set(name, listener)
    }
  } as unknown as ExtensionAPI)
  const ctx = {
    executeTool: async (_name: string, _input: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal
      began()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        isError: signal.aborted,
        result: {
          content: [{ type: 'text', text: 'saved bytes' }],
          ...(nativeOutput ? { details: { fullOutputPath: nativeOutput } } : {})
        }
      }
    }
  }
  let calls = 0
  const callAs = async (toolCallId: string, input: object) => {
    const result = await definition.execute(toolCallId, input, controller.signal, undefined, ctx)
    return { parsed: JSON.parse(result.content[0].text), content: result.content }
  }
  const call = async (input: object) => {
    const result = await callAs('owned-control-' + ++calls, input)
    return result.parsed
  }
  t.after(async () => {
    release?.()
    await commands.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    commands,
    call,
    callAs,
    started,
    listeners,
    signal: () => signal,
    turn: (value: string) => {
      turn = value
    },
    release: () => release()
  }
}

test('duplicate tool-call IDs keep one receipt per output read and do not strand cursors', async (t) => {
  const f = await fixture(t)
  const first = await f.call({ action: 'start', command: 'first command' })
  f.release()
  await f.commands.finish('turn-A', false)
  const second = await f.call({ action: 'start', command: 'second command' })
  f.release()
  await f.commands.finish('turn-A', false)
  const readFirst = await f.callAs('duplicate-call', {
    action: 'output',
    command_id: first.command_id
  })
  const readSecond = await f.callAs('duplicate-call', {
    action: 'output',
    command_id: second.command_id
  })
  const result = f.listeners.get('tool_result') as unknown as (event: {
    toolCallId: string
    content: unknown
    isError: boolean
  }) => void
  assert.equal(typeof result, 'function')
  result({ toolCallId: 'duplicate-call', content: readFirst.content, isError: false })
  result({ toolCallId: 'duplicate-call', content: readSecond.content, isError: false })
  // Each automatic read waits for its own receipt before the next read starts; a
  // receipt replaced by the duplicate ID would block this read forever.
  let timer: ReturnType<typeof setTimeout> | undefined
  const next = await Promise.race([
    f.call({ action: 'output', command_id: first.command_id }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('automatic output read stalled')), 1000)
    })
  ]).finally(() => clearTimeout(timer))
  assert.equal((next as { status: string }).status, 'succeeded')
})

test('a live command is not controllable from another child turn or by a parent/foreign handle', async (t) => {
  const f = await fixture(t),
    row = await f.call({ action: 'start', command: 'controlled fixture' })
  await f.started
  f.turn('turn-B')
  assert.deepEqual((await f.call({ action: 'list' })).commands, [])
  await assert.rejects(f.call({ action: 'stop', command_id: row.command_id }), /another child turn/)
  await assert.rejects(
    f.call({ action: 'output', command_id: row.command_id }),
    /another child turn/
  )
  await assert.rejects(f.call({ action: 'stop', command_id: 'foreign-agent-task-id' }), /not found/)
  assert.equal(f.signal().aborted, false)
  f.release()
  await f.commands.finish('turn-A', false)
  const historical = await f.call({ action: 'output', command_id: row.command_id, offset: 0 })
  assert.equal(historical.status, 'succeeded')
  assert.equal(historical.output, 'saved bytes')
})

test(
  'a settled stop that cannot close output keeps cleanup unconfirmed',
  { timeout: 15000 },
  async (t) => {
    // Adopt a native source so the writer handle stays open when finalization fails.
    const native = join(tmpdir(), `pi-bash-${randomBytes(8).toString('hex')}.log`)
    await writeFile(native, 'saved bytes', { mode: 0o600 })
    t.after(() => unlink(native).catch(() => {}))
    const f = await fixture(t, native),
      row = await f.call({ action: 'start', command: 'held native execution' })
    await f.started
    const close = CommandOutput.prototype.close
    CommandOutput.prototype.close = async () => {
      throw new Error('injected close failure')
    }
    try {
      f.release()
      let quarantined = false
      /* oxlint-disable no-await-in-loop -- Poll the observable cleanup state until finalization settles. */
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          await f.commands.ready()
        } catch (error) {
          assert.equal(error.code, 'CHILD_CLEANUP_FAILED')
          quarantined = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      /* oxlint-enable no-await-in-loop */
      assert.equal(quarantined, true)
      // Let the rejected finalization settle before retrying the stop.
      await new Promise((resolve) => setTimeout(resolve, 25))
      await assert.rejects(f.call({ action: 'stop', command_id: row.command_id }), {
        code: 'CHILD_CLEANUP_FAILED'
      })
      await assert.rejects(f.commands.ready(), { code: 'CHILD_CLEANUP_FAILED' })
      assert.equal(f.listeners.get('tool_call')({ toolName: 'write', input: {} }).block, true)
    } finally {
      CommandOutput.prototype.close = close
    }
  }
)

test(
  'a stop deadline preserves a live execution, reports cleanup uncertainty and blocks new effects until cleanup is known',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      row = await f.call({ action: 'start', command: 'held native execution' })
    await f.started
    const stopped = await f.call({ action: 'stop', command_id: row.command_id })
    assert.equal(stopped.status, 'canceled')
    assert.equal(stopped.cleanup_pending, true)
    assert.equal(stopped.error.code, 'TASK_STOP_FAILED')
    assert.equal(f.signal().aborted, true)
    f.turn('turn-B')
    assert.deepEqual((await f.call({ action: 'list' })).commands, [])
    await assert.rejects(
      f.call({ action: 'output', command_id: row.command_id }),
      /another child turn/
    )
    await assert.rejects(
      f.call({ action: 'stop', command_id: row.command_id }),
      /another child turn/
    )
    f.turn('turn-A')
    await assert.rejects(f.commands.ready(), { code: 'CHILD_CLEANUP_FAILED' })
    await assert.rejects(f.call({ action: 'start', command: 'must not run' }), {
      code: 'CHILD_CLEANUP_FAILED'
    })
    const guard = f.listeners.get('tool_call')
    assert.equal(guard({ toolName: 'write', input: {} }).block, true)
    assert.equal(guard({ toolName: 'bash_task', input: { action: 'output' } }), undefined)
    const partial = await f.call({ action: 'output', command_id: row.command_id })
    assert.equal(partial.cleanup_pending, true)
    assert.equal(partial.output_incomplete, true)
    f.release()
    await f.commands.finish('turn-A', false)
    await f.commands.ready()
    assert.equal(guard({ toolName: 'write', input: {} }), undefined)
    const complete = await f.call({ action: 'output', command_id: row.command_id, offset: 0 })
    assert.equal(complete.cleanup_pending, undefined)
    assert.equal(complete.output, 'saved bytes')
  }
)
