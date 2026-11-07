import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createChildCommands } from '../src/child-commands.ts'

async function fixture(t: TestContext) {
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
        result: { content: [{ type: 'text', text: 'saved bytes' }] }
      }
    }
  }
  let calls = 0
  const call = async (input: object) => {
    const result = await definition.execute(
      'owned-control-' + ++calls,
      input,
      controller.signal,
      undefined,
      ctx
    )
    return JSON.parse(result.content[0].text)
  }
  t.after(async () => {
    release?.()
    await commands.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    commands,
    call,
    started,
    listeners,
    signal: () => signal,
    turn: (value: string) => {
      turn = value
    },
    release: () => release()
  }
}

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
