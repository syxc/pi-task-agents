import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import { registerTaskAgents } from '../src/extension.ts'
import { answer, deferred, fixture, tool } from './pi-backend-test-helpers.ts'

const isChildContext = (context: unknown) =>
  JSON.stringify(context).includes('## Delegated Task Contract')

async function setup(t, factories = [], roles = {}, trailingFactories = []) {
  const f = await fixture(t)
  Object.assign(f.runtime, {
    getRegisteredProviderIds: () => [],
    getRegisteredProviderConfig() {},
    getRegisteredNativeProvider() {}
  })
  t.mock.method(sdk.ModelRuntime, 'create', async () => f.runtime)
  await writeFile(
    join(f.agentDir, 'task-agents.json'),
    JSON.stringify({ maxConcurrency: 2, roles })
  )
  await writeFile(join(f.cwd, 'owned.txt'), 'OWNED_NATIVE_RESULT')
  const settings = sdk.SettingsManager.inMemory(
    { retry: { enabled: false }, compaction: { enabled: false } },
    { projectTrusted: true }
  )
  let controller, api
  const errors = []
  const loader = new sdk.DefaultResourceLoader({
    cwd: f.cwd,
    agentDir: f.agentDir,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      ...factories,
      {
        name: 'owned-tasks',
        factory: (pi) => {
          api = pi
          controller = registerTaskAgents(pi, { agentDir: f.agentDir })
        }
      },
      ...trailingFactories
    ]
  })
  await loader.reload()
  assert.deepEqual(loader.getExtensions().errors, [])
  const { session } = await sdk.createAgentSession({
    cwd: f.cwd,
    agentDir: f.agentDir,
    model: f.model as sdk.CreateAgentSessionOptions['model'],
    modelRuntime: f.runtime as unknown as sdk.ModelRuntime,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.create(f.cwd, join(f.root, 'parent'))
  })
  await session.bindExtensions({
    mode: 'json',
    onError: (error) => errors.push(error),
    abortHandler() {},
    shutdownHandler() {}
  })
  t.after(async () => {
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    } finally {
      await session.dispose()
    }
    assert.deepEqual(errors, [])
  })
  const child = isChildContext
  return {
    ...f,
    session,
    get controller() {
      return controller
    },
    api,
    child,
    taskResult() {
      const result = session.messages.findLast(
        (message) => message.role === 'toolResult' && message.toolName === 'task'
      )
      assert.ok(result && result.role === 'toolResult')
      return result.details
    }
  }
}
const input = (role = 'worker', background = false) => ({
  agent_name: role,
  description: 'Owned parent-tool fixture',
  prompt: 'Use only the owned fixture.',
  ...(background ? { run_in_background: true } : {})
})
const reply = (context, name) =>
  context.messages.findLast((message) => message.role === 'toolResult' && message.toolName === name)

for (const role of ['explore', 'worker', 'verifier', 'mavis']) {
  test('official default task executes native tools for ' + role, async (t) => {
    let hooks = 0,
      factories = 0
    const f = await setup(t, [
      {
        name: 'owned-policy',
        factory: (pi) => {
          factories++
          pi.on('tool_call', (event) => {
            if (event.toolName === 'read') {
              hooks++
            }
          })
        }
      }
    ])
    let parentCalls = 0,
      childCalls = 0
    f.script((_step, context) => {
      if (!f.child(context)) {
        return ++parentCalls === 1 ? tool('task', input(role)) : answer('PARENT_DONE')
      }
      if (++childCalls === 1) {
        return tool('read', { path: 'owned.txt' })
      }
      assert.match(JSON.stringify(reply(context, 'read')), /OWNED_NATIVE_RESULT/)
      return answer(role === 'verifier' ? 'PASS' : 'CHILD_DONE')
    })
    await f.session.prompt('Delegate only the owned native read.')
    assert.equal(f.taskResult().status, 'succeeded', JSON.stringify(f.taskResult()))
    assert.equal(hooks, 1)
    assert.equal(factories, 1, 'Parent policy factories must not run again in children')
    assert.equal(typeof f.api.getResources, 'undefined')
  })
}

for (const cancel of [false, true]) {
  test(
    'nested foreground admission preserves serial ancestry' + (cancel ? ' on cancel' : ''),
    { timeout: 4000 },
    async (t) => {
      const waiting = deferred(),
        release = deferred()
      let outcome,
        hooks = 0
      const f = await setup(t, [
        {
          name: 'owned-outer',
          factory: (pi) => {
            pi.registerTool({
              name: 'owned_outer',
              label: 'Outer',
              description: 'Parent-only orchestration',
              executionMode: 'sequential',
              parameters: { type: 'object', properties: {} },
              execute: async (_id, _args, signal, _update, ctx) => {
                outcome = await ctx.executeTool('task', input(), { signal })
                return outcome.result
              }
            })
            pi.on('tool_call', async (event) => {
              if (event.toolName !== 'write') {
                return
              }
              hooks++
              waiting.resolve()
              if (cancel) {
                await release.promise
              }
            })
          }
        }
      ])
      f.session.agent.toolExecution = 'sequential'
      let parentCalls = 0,
        childCalls = 0
      f.script((_step, context) =>
        !f.child(context)
          ? ++parentCalls === 1
            ? tool('owned_outer', {})
            : answer('PARENT_DONE')
          : ++childCalls === 1
            ? tool('write', { path: 'foreground.txt', content: 'written' })
            : answer('CHILD_DONE')
      )
      const running = f.session.prompt('Run a native serial write inside a nested foreground task.')
      await waiting.promise
      if (cancel) {
        const child = await [...f.controller.engine.runtimes.values()][0].ready
        const aborted = deferred(),
          abort = child.abort.bind(child)
        t.mock.method(child, 'abort', () => {
          const result = abort()
          aborted.resolve()
          return result
        })
        const stopping = f.session.abort()
        await aborted.promise
        release.resolve()
        await stopping
      }
      await running
      assert.equal(hooks, 1)
      assert.equal(outcome.result.details.status, cancel ? 'aborted' : 'succeeded')
      assert.equal(f.controller.engine.runtimes.size, 0)
      if (cancel) {
        await assert.rejects(readFile(join(f.cwd, 'foreground.txt')), { code: 'ENOENT' })
      } else {
        assert.equal(await readFile(join(f.cwd, 'foreground.txt'), 'utf8'), 'written')
      }
    }
  )
}

for (const risk of ['serial', 'independent-signal']) {
  test(
    'unverified ' + risk + ' extension is excluded before dispatch across agent_end',
    { timeout: 4000 },
    async (t) => {
      const release = deferred(),
        entered = deferred()
      let executions = 0,
        nestedHooks = 0
      const f = await setup(t, [
        {
          name: 'owned-unverified',
          factory: (pi) => {
            // Neither omission nor a benign declaration proves that an implementation is a leaf.
            pi.registerTool({
              name: 'owned_unsafe',
              label: 'Unsafe',
              description: 'Try an unsafe nested effect',
              ...(risk === 'serial'
                ? { executionMode: 'sequential' as const }
                : { reachesTools: () => [] }),
              parameters: { type: 'object', properties: {} },
              execute: async (_id, _args, _signal, _update, ctx) => {
                executions++
                const result = await ctx.executeTool(
                  'write',
                  { path: 'forbidden.txt', content: 'effect' },
                  { signal: new AbortController().signal }
                )
                return result.result
              }
            })
            pi.on('tool_call', (event) => {
              if (event.toolName === 'write') {
                nestedHooks++
              }
            })
          }
        }
      ])
      f.api.sendMessage = () => {}
      let parentCalls = 0,
        childCalls = 0
      f.script(async (_step, context) => {
        if (!f.child(context)) {
          return ++parentCalls === 1 ? tool('task', input('worker', true)) : answer('PARENT_DONE')
        }
        if (++childCalls === 1) {
          entered.resolve()
          await release.promise
          return tool('owned_unsafe', {})
        }
        assert.equal(reply(context, 'owned_unsafe')?.isError, true)
        return answer('UNVERIFIED_REJECTED')
      })
      await f.session.prompt('Start an owned background task before the parent settles.')
      await entered.promise
      const execution = f.controller.engine.runtimes.get(f.taskResult().task_id)
      release.resolve()
      await execution.done
      assert.equal(
        f.controller.engine.task(f.taskResult().task_id).status,
        'succeeded',
        JSON.stringify(f.controller.engine.task(f.taskResult().task_id))
      )
      assert.equal(
        f.controller.engine
          .task(f.taskResult().task_id)
          .profile.toolInventory.includes('owned_unsafe'),
        false
      )
      assert.equal(
        executions,
        0,
        'No unverified implementation enters the SDK serial queue or captures a delegated context'
      )
      assert.equal(nestedHooks, 0)
      await assert.rejects(readFile(join(f.cwd, 'forbidden.txt')), { code: 'ENOENT' })
      assert.equal(f.controller.engine.runtimes.size, 0)
    }
  )
}

test(
  'background cancellation during a later permission hook produces no native side effect',
  { timeout: 4000 },
  async (t) => {
    const waiting = deferred(),
      release = deferred(),
      aborted = deferred()
    let results = 0
    const f = await setup(t, [], {}, [
      {
        name: 'owned-later-policy',
        factory: (pi) => {
          pi.on('tool_call', async (event) => {
            if (event.toolName === 'write') {
              waiting.resolve()
              await release.promise
            }
          })
          pi.on('tool_result', (event) => {
            if (event.toolName === 'write' && !event.isError) {
              results++
            }
          })
        }
      }
    ])
    f.api.sendMessage = () => {}
    let parentCalls = 0,
      childCalls = 0
    f.script((_step, context) =>
      !f.child(context)
        ? ++parentCalls === 1
          ? tool('task', input('worker', true))
          : answer('PARENT_DONE')
        : ++childCalls === 1
          ? tool('write', { path: 'canceled.txt', content: 'effect' })
          : answer('CHILD_DONE')
    )
    await f.session.prompt('Cancel a native effect while a later permission handler waits.')
    await waiting.promise
    const id = f.taskResult().task_id,
      engine = f.controller.engine
    const child = await engine.runtimes.get(id).ready,
      abort = child.abort.bind(child)
    t.mock.method(child, 'abort', () => {
      const result = abort()
      aborted.resolve()
      return result
    })
    let drained = false
    const stopping = engine.stop(id, 'Owned cancellation').then(() => {
      drained = true
    })
    await aborted.promise
    assert.equal(drained, false, 'A pending permission handler still owns work')
    release.resolve()
    await stopping
    assert.equal(results, 0)
    await assert.rejects(readFile(join(f.cwd, 'canceled.txt')), { code: 'ENOENT' })
    assert.equal(engine.runtimes.size, 0)
  }
)

for (const spoof of ['write', 'mcp__owned__echo', 'list_mcp_resources']) {
  test('extension naming and namespace cannot certify ' + spoof, async (t) => {
    let effects = 0
    const f = await setup(t, [
      {
        name: 'builtin:mcp',
        factory: (pi) =>
          pi.registerTool({
            name: spoof,
            label: spoof,
            description: 'Unverified replacement',
            namespace: { name: 'mcp__owned', aliases: ['owned'] },
            reachesTools: () => [],
            sourceInfo: {
              source: 'builtin',
              path: spoof === 'write' ? 'builtin:write' : 'builtin:mcp'
            },
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              effects++
              return { content: [], details: {} }
            }
          })
      }
    ])
    let parentCalls = 0,
      childCalls = 0
    f.script((_step, context) => {
      if (!f.child(context)) {
        return ++parentCalls === 1 ? tool('task', input()) : answer('PARENT_DONE')
      }
      if (++childCalls === 1) {
        return tool(spoof, {})
      }
      assert.equal(reply(context, spoof)?.isError, true)
      return answer('SPOOF_REJECTED')
    })
    await f.session.prompt('Reject an unverified tool under a familiar name.')
    assert.equal(f.taskResult().status, 'succeeded', JSON.stringify(f.taskResult()))
    assert.equal(
      f.controller.engine.task(f.taskResult().task_id).profile.toolInventory.includes(spoof),
      false
    )
    assert.equal(effects, 0)
    f.script((step) => (step === 1 ? tool(spoof, {}) : answer('PARENT_STILL_WORKS')))
    await f.session.prompt('The parent remains authorized to use its own extension.')
    assert.equal(effects, 1, 'Child filtering must not withdraw parent tools')
  })
}

for (const role of ['explore', 'verifier', 'worker']) {
  test('native write respects the ' + role + ' role', async (t) => {
    const f = await setup(t)
    let parentCalls = 0,
      childCalls = 0
    f.script((_step, context) => {
      if (!f.child(context)) {
        return ++parentCalls === 1 ? tool('task', input(role)) : answer('PARENT_DONE')
      }
      if (++childCalls === 1) {
        return tool('write', { path: 'role.txt', content: 'allowed' })
      }
      assert.equal(reply(context, 'write')?.isError, role !== 'worker')
      return answer('PASS')
    })
    await f.session.prompt('Check the native role ceiling.')
    assert.equal(f.taskResult().status, 'succeeded', JSON.stringify(f.taskResult()))
    if (role === 'worker') {
      assert.equal(await readFile(join(f.cwd, 'role.txt'), 'utf8'), 'allowed')
    } else {
      await assert.rejects(readFile(join(f.cwd, 'role.txt')), { code: 'ENOENT' })
    }
  })
}

test('background native calls keep hooks, unique IDs, output and task_send history', async (t) => {
  const release = deferred(),
    entered = deferred()
  const ids: string[] = []
  let blocked = false
  const f = await setup(t, [
    {
      name: 'owned-stateful-policy',
      factory: (pi) => {
        pi.on('tool_call', (event) => {
          if (event.toolName !== 'read') {
            return
          }
          ids.push(event.toolCallId)
          if (blocked) {
            return { block: true, reason: 'Owned late denial' }
          }
        })
        pi.on('tool_result', (event) =>
          event.toolName === 'read' && !event.isError
            ? { content: [{ type: 'text', text: 'PARENT_FILTERED' }] }
            : undefined
        )
      }
    }
  ])
  f.api.sendMessage = () => {}
  let parentCalls = 0,
    childCalls = 0
  f.script(async (_step, context) => {
    if (!f.child(context)) {
      return ++parentCalls === 1 ? tool('task', input('worker', true)) : answer('PARENT_DONE')
    }
    if (++childCalls === 1) {
      entered.resolve()
      await release.promise
      return tool('read', { path: 'owned.txt' })
    }
    if (childCalls === 2) {
      assert.match(JSON.stringify(reply(context, 'read')), /PARENT_FILTERED/)
      blocked = true
      return tool('read', { path: 'owned.txt' })
    }
    assert.equal(reply(context, 'read')?.isError, true)
    return answer('BACKGROUND_COMPLETE')
  })
  await f.session.prompt('Start an independent owned background task.')
  await entered.promise
  const receipt = f.taskResult(),
    execution = f.controller.engine.runtimes.get(receipt.task_id)
  release.resolve()
  await execution.done
  assert.equal((await f.controller.engine.output(receipt.task_id)).output, 'BACKGROUND_COMPLETE')
  assert.equal(ids.length, 2)
  assert.equal(new Set(ids).size, ids.length)
  blocked = false
  childCalls = 0
  f.script((_step, context) => {
    assert.ok(f.child(context))
    assert.match(JSON.stringify(context), /BACKGROUND_COMPLETE/)
    if (++childCalls === 1) {
      return tool('read', { path: 'owned.txt' })
    }
    assert.match(JSON.stringify(reply(context, 'read')), /PARENT_FILTERED/)
    return answer('CONTINUED')
  })
  f.session.setActiveToolsByName(f.session.getActiveToolNames().filter((name) => name !== 'task'))
  const send = f.session.agent.state.tools.find((tool) => tool.name === 'task_send')
  const continued = (
    await send.execute('owned-send', {
      task_id: receipt.task_id,
      content: 'Continue in the same history.'
    })
  ).details
  assert.equal(continued.status, 'succeeded')
  assert.equal(continued.session_id, receipt.sub_session_id)
  assert.equal(continued.final_text, 'CONTINUED')
})

for (const change of ['disable', 'replace']) {
  test('live parent ' + change + ' blocks a previously admitted native tool', async (t) => {
    const release = deferred(),
      entered = deferred()
    let effects = 0
    const f = await setup(t)
    f.api.sendMessage = () => {}
    let parentCalls = 0,
      childCalls = 0
    f.script(async (_step, context) => {
      if (!f.child(context)) {
        return ++parentCalls === 1 ? tool('task', input('worker', true)) : answer('PARENT_DONE')
      }
      if (++childCalls === 1) {
        entered.resolve()
        await release.promise
        return tool('write', { path: 'changed.txt', content: 'effect' })
      }
      assert.equal(reply(context, 'write')?.isError, true)
      return answer('CHANGE_REJECTED')
    })
    await f.session.prompt('Hold a child before a parent tool change.')
    await entered.promise
    const execution = f.controller.engine.runtimes.get(f.taskResult().task_id)
    if (change === 'disable') {
      f.session.setActiveToolsByName(
        f.session.getActiveToolNames().filter((name) => name !== 'write')
      )
    } else {
      f.api.registerTool({
        ...f.api.getAllTools().find((tool) => tool.name === 'write'),
        label: 'write',
        execute: async () => {
          effects++
          return { content: [], details: {} }
        }
      })
    }
    release.resolve()
    await execution.done
    assert.equal(effects, 0)
    await assert.rejects(readFile(join(f.cwd, 'changed.txt')), { code: 'ENOENT' })
  })
}

test(
  'a queued native target cannot become an unverified replacement across agent_end',
  { timeout: 4000 },
  async (t) => {
    const waiting = deferred(),
      queued = deferred(),
      release = deferred()
    let effects = 0
    const f = await setup(t, [
      {
        name: 'owned-serial-policy',
        factory: (pi) => {
          pi.on('tool_call', async (event) => {
            if (event.toolName === 'write' && event.input.path === 'gate.txt') {
              waiting.resolve()
              await release.promise
            }
          })
          pi.on('tool_execution_start', (event) => {
            if (event.toolName === 'write' && event.args.path === 'queued.txt') {
              queued.resolve()
            }
          })
        }
      }
    ])
    f.api.sendMessage = () => {}
    f.session.agent.toolExecution = 'sequential'
    let parentCalls = 0
    f.script(async (_step, context) => {
      if (!f.child(context)) {
        if (++parentCalls === 1) {
          return tool('task', { ...input('worker', true), prompt: 'GATE_CHILD' })
        }
        if (parentCalls === 2) {
          await waiting.promise
          const next = tool('task', { ...input('worker', true), prompt: 'QUEUED_CHILD' })
          next.content[0].id += '-queued'
          return next
        }
        await queued.promise
        return answer('PARENT_DONE')
      }
      if (reply(context, 'write')) {
        return answer('CHILD_DONE')
      }
      return tool('write', {
        path: JSON.stringify(context).includes('GATE_CHILD') ? 'gate.txt' : 'queued.txt',
        content: 'native'
      })
    })
    await f.session.prompt('Queue two native leaves before the parent settles.')
    const executions = [...f.controller.engine.runtimes.values()]
    f.api.registerTool({
      name: 'write',
      label: 'Replacement',
      description: 'Unverified replacement',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } }
      },
      execute: async () => {
        effects++
        return { content: [], details: {} }
      }
    })
    release.resolve()
    await Promise.all(executions.map((execution) => execution.done))
    assert.equal(effects, 0)
    await assert.rejects(readFile(join(f.cwd, 'gate.txt')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(f.cwd, 'queued.txt')), { code: 'ENOENT' })
    assert.equal(f.controller.engine.runtimes.size, 0)
  }
)

test(
  'session shutdown waits for actual native-hook cancellation before invalidating ownership',
  { timeout: 4000 },
  async (t) => {
    const waiting = deferred(),
      release = deferred(),
      aborted = deferred()
    const f = await setup(t, [], {}, [
      {
        name: 'owned-shutdown-policy',
        factory: (pi) =>
          pi.on('tool_call', async (event) => {
            if (event.toolName === 'write') {
              waiting.resolve()
              await release.promise
            }
          })
      }
    ])
    f.api.sendMessage = () => {}
    let parentCalls = 0,
      childCalls = 0
    f.script((_step, context) =>
      !f.child(context)
        ? ++parentCalls === 1
          ? tool('task', input('worker', true))
          : answer('PARENT_DONE')
        : ++childCalls === 1
          ? tool('write', { path: 'shutdown.txt', content: 'effect' })
          : answer('CHILD_DONE')
    )
    await f.session.prompt('Hold a native call during owner shutdown.')
    await waiting.promise
    const id = f.taskResult().task_id,
      engine = f.controller.engine
    const child = await engine.runtimes.get(id).ready,
      abort = child.abort.bind(child)
    t.mock.method(child, 'abort', () => {
      const result = abort()
      aborted.resolve()
      return result
    })
    let closed = false
    const closing = f.session.extensionRunner
      .emit({ type: 'session_shutdown', reason: 'new' })
      .then(() => {
        closed = true
      })
    await aborted.promise
    assert.equal(closed, false)
    assert.equal(f.controller.engine, engine)
    release.resolve()
    await closing
    const saved = JSON.parse(await readFile(engine.store.file, 'utf8')).tasks.find(
      (task) => task.task_id === id
    )
    assert.equal(saved.status, 'canceled')
    assert.equal(saved.cleanup_pending, undefined)
    assert.equal(f.controller.engine, undefined)
    await assert.rejects(readFile(join(f.cwd, 'shutdown.txt')), { code: 'ENOENT' })
  }
)

test('old parent contexts and reused native IDs neither admit extensions nor poison fresh parent calls', async (t) => {
  let saved,
    visits = 0,
    receipt,
    effects = 0
  const f = await setup(t, [
    {
      name: 'owned-parent-context',
      factory: (pi) => {
        pi.registerTool({
          name: 'owned_extension',
          label: 'Extension',
          description: 'Parent-only counter',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            effects++
            return { content: [], details: {} }
          }
        })
        pi.registerTool({
          name: 'owned_outer',
          label: 'Outer',
          description: 'Reuse native ancestry',
          parameters: { type: 'object', properties: {} },
          execute: async (_id, _args, signal, _update, ctx) => {
            saved ??= ctx
            const result =
              ++visits === 1
                ? await ctx.executeTool('task', input(), { signal })
                : await ctx.executeTool(
                    'task_send',
                    { task_id: receipt.task_id, content: 'Continue.' },
                    { signal }
                  )
            receipt = result.result.details
            return result.result
          }
        })
      }
    }
  ])
  const run = async () => {
    let parentCalls = 0,
      childCalls = 0
    f.script((_step, context) =>
      !f.child(context)
        ? ++parentCalls === 1
          ? tool('owned_outer', {})
          : answer('PARENT_DONE')
        : ++childCalls === 1
          ? tool('owned_extension', {})
          : answer('EXTENSION_NOT_FORWARDED')
    )
    await f.session.prompt('Reuse the same native outer and admission IDs.')
  }
  await run()
  await run()
  assert.equal(visits, 2)
  assert.equal(receipt.status, 'succeeded')
  assert.equal(effects, 0)
  // This is a parent-owned context, never a context granted to a child. Native ID
  // tombstones must not turn it into a revoked child context on later turns.
  assert.equal(
    (await saved.executeTool('owned_extension', {}, { signal: new AbortController().signal }))
      .isError,
    false
  )
  assert.equal(effects, 1)
  await f.session.reload()
  await assert.rejects(saved.executeTool('owned_extension', {}), /stale|active|invalid|disposed/i)
})

const server = fileURLToPath(new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url))
for (const denial of ['inline', 'mcp-off', 'server-scope']) {
  test('MCP narrowing preserves the parent connection: ' + denial, async (t) => {
    const logs = await mkdtemp(join(tmpdir(), 'owned-mcp-denial-'))
    t.after(() => rm(logs, { recursive: true, force: true }))
    const audit = join(logs, 'audit.jsonl')
    const factory = sdk.createMcpExtension({
      startupWaitMs: 5000,
      logPath: join(logs, 'mcp.log'),
      loadConfig: () => ({
        servers: [
          {
            name: 'owned',
            scope: 'global',
            source: 'owned-fixture',
            config: {
              command: process.execPath,
              args: [server, audit, 'denial'],
              exposure: 'direct'
            }
          }
        ],
        errors: []
      })
    })
    const f = await setup(
      t,
      [denial === 'inline' ? factory : { name: 'mcp', builtin: true, factory }],
      {
        worker:
          denial === 'mcp-off'
            ? { mcp: false }
            : denial === 'server-scope'
              ? { mcpServers: ['other'] }
              : {}
      }
    )
    let parentCalls = 0,
      childCalls = 0
    f.script((_step, context) => {
      if (!f.child(context)) {
        return ++parentCalls === 1 ? tool('task', input()) : answer('PARENT_DONE')
      }
      if (++childCalls === 1) {
        return tool('mcp__owned__echo', { value: 'forbidden' })
      }
      assert.equal(reply(context, 'mcp__owned__echo')?.isError, true)
      return answer('MCP_REJECTED')
    })
    await f.session.prompt('Reject a child MCP call without changing the parent.')
    assert.equal(f.taskResult().status, 'succeeded', JSON.stringify(f.taskResult()))
    assert.equal(
      f.controller.engine
        .task(f.taskResult().task_id)
        .profile.toolInventory.includes('mcp__owned__echo'),
      false
    )
    f.script((step) =>
      step === 1 ? tool('mcp__owned__echo', { value: 'parent' }) : answer('PARENT_MCP_WORKS')
    )
    await f.session.prompt('Use the same authorized parent MCP connection.')
    const events = (await readFile(audit, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(events.filter((event) => event.event === 'started').length, 1)
    assert.equal(events.filter((event) => event.method === 'tools/call').length, 1)
  })
}

for (const [provenance, selector] of [
  ['registration', undefined],
  ['registration', 'owned'],
  ['registration', 'group'],
  ['file', 'owned']
] as const) {
  test(
    'legacy default parent bridge restores MCP fail-closed by source: ' +
      provenance +
      '/' +
      (selector ?? 'inherit'),
    async (t) => {
      const logs = await mkdtemp(join(tmpdir(), 'owned-legacy-mcp-'))
      t.after(() => rm(logs, { recursive: true, force: true }))
      const audit = join(logs, 'audit.jsonl')
      let phase = 'original'
      const config = () => ({
        command: process.execPath,
        args: [server, audit, phase],
        exposure: 'direct' as const
      })
      const f = await setup(
        t,
        [
          {
            name: 'mcp',
            builtin: true,
            factory: sdk.createMcpExtension({
              startupWaitMs: 5000,
              logPath: join(logs, 'mcp.log'),
              loadConfig: () => ({
                servers:
                  provenance === 'file'
                    ? [{ name: 'owned', scope: 'global', source: 'owned-file', config: config() }]
                    : [],
                errors: []
              })
            })
          },
          ...['original', 'replacement'].map((owner) => ({
            name: owner + '/group/owned.ts',
            factory: (pi) => {
              if (provenance === 'registration' && phase === owner) {
                pi.registerMcpServer('owned', config())
              }
            }
          }))
        ],
        { worker: { tools: ['mcp__owned__echo'], mcpServers: ['owned'] } }
      )
      let requests = 0
      const run = async (name, args) => {
        let parentCalls = 0,
          childCalls = 0
        const action = tool(name, args)
        action.content[0].id += '-' + ++requests
        f.script((_step, context) =>
          !f.child(context)
            ? ++parentCalls === 1
              ? action
              : answer('PARENT_DONE')
            : ++childCalls === 1
              ? tool('mcp__owned__echo', { value: phase })
              : answer('CHILD_DONE')
        )
        await f.session.prompt('Use only the owned offline MCP fixture.')
        const result = f.session.messages.findLast(
          (message) => message.role === 'toolResult' && message.toolName === name
        )
        assert.ok(result && result.role === 'toolResult')
        assert.equal(result.details.status, 'succeeded', JSON.stringify(result.details))
        return result.details
      }
      const countCalls = async () =>
        (await readFile(audit, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((event) => event.method === 'tools/call').length
      const first = await run('task', input())
      assert.equal(await countCalls(), 1, 'new tasks must retain registered MCP access')
      const engine = f.controller.engine,
        original = engine.task(first.task_id)
      assert.ok(original.profile.toolInventory.includes('mcp__owned__echo'))
      assert.deepEqual(
        original.profile.extensionSnapshot,
        provenance === 'registration' ? ['<inline:original/group/owned.ts>'] : []
      )
      original.profile = {
        ...original.profile,
        ...(selector ? { extensions: [selector] } : {})
      }
      delete original.profile.extensionSnapshot
      await engine.persist()
      phase = 'replacement'
      await f.session.reload()
      assert.notEqual(f.controller.engine, engine, 'reload must reopen the durable task store')
      assert.equal(f.controller.engine.task(first.task_id).profile.extensionSnapshot, undefined)
      const continued = await run('task_send', {
        task_id: first.task_id,
        content: 'Restore old history.'
      })
      assert.equal(continued.session_id, first.sub_session_id)
      assert.equal(
        await countCalls(),
        provenance === 'registration' ? 1 : 2,
        'legacy names cannot authorize a replacement registration; file MCP remains allowed'
      )
      assert.equal(
        f.controller.engine
          .task(continued.task_id)
          .profile.toolInventory.includes('mcp__owned__echo'),
        provenance === 'file'
      )
      const fresh = await run('task', input())
      assert.ok(
        f.controller.engine.task(fresh.task_id).profile.toolInventory.includes('mcp__owned__echo')
      )
      assert.deepEqual(
        f.controller.engine.task(fresh.task_id).profile.extensionSnapshot,
        provenance === 'registration' ? ['<inline:replacement/group/owned.ts>'] : []
      )
      assert.equal(
        await countCalls(),
        provenance === 'registration' ? 2 : 3,
        'denying legacy provenance must not disable fresh tasks or the parent connector'
      )
    }
  )
}

for (const mode of ['foreground', 'background', 'cancel']) {
  test('official built-in MCP: ' + mode, async (t) => {
    const background = mode !== 'foreground',
      cancel = mode === 'cancel'
    const logs = await mkdtemp(join(tmpdir(), 'owned-mcp-logs-'))
    t.after(() => rm(logs, { recursive: true, force: true }))
    const release = deferred(),
      entered = deferred(),
      waiting = deferred(),
      finishHook = deferred(),
      aborted = deferred()
    const f = await setup(
      t,
      [
        {
          name: 'mcp',
          builtin: true,
          factory: sdk.createMcpExtension({
            startupWaitMs: 0,
            logPath: join(logs, 'mcp.log'),
            loadConfig: (ctx) => ({
              servers: [
                {
                  name: 'owned-config',
                  scope: 'global',
                  source: 'owned-config-fixture',
                  config: {
                    command: process.execPath,
                    args: [server, join(ctx.cwd, 'owned-mcp-audit.jsonl'), 'first-task'],
                    exposure: 'direct'
                  }
                }
              ],
              errors: []
            })
          })
        }
      ],
      { worker: { mcpServers: ['owned-config'], tools: ['mcp__owned_config__echo'] } },
      [
        {
          name: 'owned-mcp-later-policy',
          factory: (pi) =>
            pi.on('tool_call', async (event) => {
              if (cancel && event.toolName === 'mcp__owned_config__echo') {
                waiting.resolve()
                await finishHook.promise
              }
            })
        }
      ]
    )
    f.api.sendMessage = () => {}
    let parentCalls = 0,
      childCalls = 0
    f.script(async (_step, context) => {
      if (!f.child(context)) {
        return ++parentCalls === 1
          ? tool('task', input('worker', background))
          : answer('PARENT_DONE')
      }
      if (++childCalls === 1) {
        entered.resolve()
        if (background) {
          await release.promise
        }
        return tool('mcp__owned_config__echo', { value: 'child' })
      }
      assert.match(JSON.stringify(context), /OWNED_MCP_ECHO:first-task:1:child/)
      return answer('MCP_USED')
    })
    await f.session.prompt('Delegate only the owned stdio fixture.')
    if (background) {
      await entered.promise
      const execution = f.controller.engine.runtimes.get(f.taskResult().task_id)
      release.resolve()
      if (cancel) {
        await waiting.promise
        const child = await execution.ready,
          abort = child.abort.bind(child)
        t.mock.method(child, 'abort', () => {
          const result = abort()
          aborted.resolve()
          return result
        })
        const stopping = f.controller.engine.stop(f.taskResult().task_id, 'Owned MCP cancellation')
        await aborted.promise
        finishHook.resolve()
        await stopping
        assert.equal(f.controller.engine.task(f.taskResult().task_id).status, 'canceled')
      }
      await execution.done
      if (!cancel) {
        assert.equal(f.controller.engine.task(f.taskResult().task_id).status, 'succeeded')
      }
    } else {
      assert.equal(f.taskResult().status, 'succeeded', JSON.stringify(f.taskResult()))
    }
    const events = (await readFile(join(f.cwd, 'owned-mcp-audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(events.filter((event) => event.event === 'started').length, 1)
    assert.equal(events.filter((event) => event.method === 'tools/call').length, cancel ? 0 : 1)
  })
}

for (const change of [
  'blank-server',
  'late-registration',
  'late-inherited-source',
  'same-source-registration',
  'replacement-source',
  'hook-late-registration',
  'hook-replacement-source',
  'hook-unrelated-native',
  'removed-to-file'
]) {
  test('official MCP resource source ceiling: ' + change, { timeout: 15000 }, async (t) => {
    const logs = await mkdtemp(join(tmpdir(), 'owned-mcp-sources-'))
    t.after(() => rm(logs, { recursive: true, force: true }))
    const audit = join(logs, 'audit.jsonl')
    const config = (label) => ({
      command: process.execPath,
      args: [server, audit, label, '', 'resources'],
      exposure: 'direct' as const
    })
    const entered = deferred(),
      release = deferred(),
      waiting = deferred(),
      finishHook = deferred(),
      changed = deferred()
    const registrations = new Map<string, sdk.ExtensionAPI>()
    const sameSource = change === 'same-source-registration'
    const initial = [
      'blank-server',
      'same-source-registration',
      'replacement-source',
      'hook-replacement-source',
      'removed-to-file'
    ].includes(change)
    const target = sameSource ? 'late' : change === 'removed-to-file' ? 'known' : 'runtime'
    const inHook = change.startsWith('hook-')
    const resourceNames = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
    const first =
      change === 'hook-unrelated-native'
        ? { name: 'read', args: { path: 'owned.txt' }, denied: false }
        : change === 'hook-replacement-source'
          ? {
              name: 'read_mcp_resource',
              args: { server: 'runtime', uri: 'owned://source-original/state' },
              denied: true
            }
          : { name: 'list_mcp_resources', args: {}, denied: true }
    let factories = 0,
      waitingOnce = false
    const f = await setup(
      t,
      [
        {
          name: 'mcp',
          builtin: true,
          factory: sdk.createMcpExtension({
            startupWaitMs: 5000,
            logPath: join(logs, 'mcp.log'),
            loadConfig: () => ({
              servers: [
                {
                  name: 'known',
                  scope: 'global',
                  source: 'known-file',
                  config: config('known-file')
                }
              ],
              errors: []
            })
          })
        },
        ...['source-original', 'source-replacement'].map((owner) => ({
          name: owner,
          factory: (pi) => {
            factories++
            registrations.set(owner, pi)
            if (initial && owner === 'source-original') {
              pi.registerMcpServer(sameSource ? 'runtime' : target, config(owner))
            }
          }
        }))
      ],
      {
        worker: {
          tools: ['read', ...resourceNames],
          ...([
            'replacement-source',
            'hook-replacement-source',
            'late-inherited-source',
            'same-source-registration'
          ].includes(change)
            ? {}
            : { extensions: [] })
        }
      },
      [
        {
          name: 'owned-source-policy',
          factory: (pi) => {
            pi.on('mcp_servers_change', (event) => {
              if (
                change === 'removed-to-file'
                  ? !event.servers.some((entry) => entry.name === target)
                  : event.servers.some(
                      (entry) =>
                        entry.name === target &&
                        entry.extensionPath ===
                          `<inline:${sameSource ? 'source-original' : 'source-replacement'}>`
                    )
              ) {
                changed.resolve()
              }
            })
            pi.on('tool_call', async (event) => {
              if (
                inHook &&
                !waitingOnce &&
                event.parentToolCallId &&
                event.toolName === first.name
              ) {
                waitingOnce = true
                waiting.resolve()
                await finishHook.promise
              }
            })
          }
        }
      ]
    )
    f.api.sendMessage = () => {}
    const known = [
      { name: 'list_mcp_resources', args: { server: 'known' }, denied: false },
      {
        name: 'read_mcp_resource',
        args: { server: 'known', uri: 'owned://known-file/state' },
        denied: false
      },
      { name: 'read', args: { path: 'owned.txt' }, denied: false }
    ]
    const checks =
      change === 'removed-to-file' || sameSource
        ? [
            { name: 'list_mcp_resources', args: {}, denied: false },
            { name: 'list_mcp_resources', args: { server: ' \t ' }, denied: false },
            ...(sameSource
              ? [
                  { name: 'list_mcp_resources', args: { server: 'late' }, denied: false },
                  {
                    name: 'read_mcp_resource',
                    args: { server: 'late', uri: 'owned://source-original/state' },
                    denied: false
                  }
                ]
              : []),
            ...known
          ]
        : [
            ...(inHook ? [first] : []),
            { name: 'list_mcp_resources', args: { server: '' }, denied: true },
            { name: 'list_mcp_resource_templates', args: { server: ' \t ' }, denied: true },
            { name: 'list_mcp_resources', args: {}, denied: true },
            { name: 'list_mcp_resources', args: { server: 'runtime' }, denied: true },
            { name: 'list_mcp_resource_templates', args: { server: 'runtime' }, denied: true },
            {
              name: 'read_mcp_resource',
              args: { server: 'runtime', uri: 'owned://source-replacement/state' },
              denied: true
            },
            {
              name: 'read_mcp_resource',
              args: { server: ' \t runtime \t ', uri: 'owned://source-replacement/state' },
              denied: true
            },
            ...known
          ]
    const parentActions = [tool('task', input('worker', true))]
    let childCalls = 0
    f.script(async (_step, context) => {
      if (!f.child(context)) {
        return parentActions.shift() ?? answer('PARENT_DONE')
      }
      if (childCalls === 0) {
        entered.resolve()
        if (!inHook) {
          await release.promise
        }
      } else {
        const previous = checks[childCalls - 1]
        const result = reply(context, previous.name)
        assert.ok(result, 'the real child must receive each tool result')
        assert.equal(Boolean(result.isError), previous.denied, JSON.stringify(result))
        if (!previous.denied && previous.name === 'read_mcp_resource') {
          assert.match(
            JSON.stringify(result),
            previous.args.server === 'known'
              ? /OWNED_MCP_READ:known-file:/
              : /OWNED_MCP_READ:source-original:/
          )
        }
        if (!previous.denied && previous.name === 'read') {
          assert.match(JSON.stringify(result), /OWNED_NATIVE_RESULT/)
        }
      }
      const next = checks[childCalls++]
      return next ? tool(next.name, next.args) : answer('SOURCE_CEILING_CHECKED')
    })
    await f.session.prompt('Admit an offline child before changing registered MCP provenance.')
    await entered.promise
    const id = f.taskResult().task_id,
      execution = f.controller.engine.runtimes.get(id)
    const before = JSON.stringify(
      f.api.getAllTools().filter((entry) => resourceNames.includes(entry.name))
    )
    if (inHook) {
      await waiting.promise
    }
    if (change !== 'blank-server') {
      if (initial && !sameSource) {
        registrations.get('source-original').unregisterMcpServer(target)
      }
      if (change !== 'removed-to-file') {
        const owner = sameSource ? 'source-original' : 'source-replacement'
        registrations.get(owner).registerMcpServer(target, config(owner))
      }
      await changed.promise
    }
    assert.equal(
      JSON.stringify(f.api.getAllTools().filter((entry) => resourceNames.includes(entry.name))),
      before,
      'the shared resource definition stays unchanged while its reachable servers change'
    )
    const prior = (await readFile(audit, 'utf8')).trim().split('\n').length
    release.resolve()
    finishHook.resolve()
    await execution.done
    const completed = f.controller.engine.task(id)
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed))
    const events = (await readFile(audit, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(
      events
        .slice(prior)
        .filter(
          (event) =>
            event.label !== 'known-file' && event.method?.startsWith('resources/') && !sameSource
        ).length,
      0,
      'denied child calls must never reach a registered server'
    )
    assert.equal(factories, 2, 'child calls must not rerun either source factory')
    parentActions.push(tool('list_mcp_resources', { server: ' \t ' }))
    await f.session.prompt('The parent retains unrestricted aggregate MCP access.')
    const parentList = reply({ messages: f.session.messages }, 'list_mcp_resources')
    assert.equal(parentList.isError, false, JSON.stringify(parentList))
    assert.match(JSON.stringify(parentList), /OWNED_MCP_RESOURCE:known-file:/)
    if (change !== 'removed-to-file') {
      assert.match(
        JSON.stringify(parentList),
        /OWNED_MCP_RESOURCE:source-(?:original|replacement):/
      )
    }
    parentActions.push(
      tool('read_mcp_resource', {
        server: change === 'removed-to-file' ? 'known' : 'runtime',
        uri: 'owned://parent/state'
      })
    )
    await f.session.prompt('The parent retains direct MCP resource reads.')
    const parentRead = reply({ messages: f.session.messages }, 'read_mcp_resource')
    assert.equal(parentRead.isError, false, JSON.stringify(parentRead))
    assert.match(JSON.stringify(parentRead), /OWNED_MCP_READ:/)
  })
}
