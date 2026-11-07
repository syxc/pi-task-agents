import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import { registerTaskAgents } from '../src/extension.ts'
import { answer, deferred, fixture, tool } from './pi-backend-test-helpers.ts'

const isChildContext = (context: unknown) =>
  JSON.stringify(context).includes('## Delegated Task Contract')

async function setup(t, cancel = false, maxConcurrency = 2) {
  const f = await fixture(t)
  Object.assign(f.runtime, {
    getRegisteredProviderIds: () => [],
    getRegisteredProviderConfig() {},
    getRegisteredNativeProvider() {}
  })
  t.mock.method(sdk.ModelRuntime, 'create', async () => f.runtime)
  await writeFile(join(f.agentDir, 'task-agents.json'), JSON.stringify({ maxConcurrency }))
  const waiting = deferred(),
    release = deferred(),
    writeStarted = deferred()
  const parents: { write?: string; send?: string; read?: string } = {}
  let controller, api
  const settings = sdk.SettingsManager.inMemory(
    { retry: { enabled: false }, compaction: { enabled: false } },
    { projectTrusted: true }
  )
  const errors = []
  const loader = new sdk.DefaultResourceLoader({
    cwd: f.cwd,
    agentDir: f.agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        pi.registerTool({
          name: 'owned_sender',
          label: 'Sender',
          description: 'Continue an idle retained child',
          executionMode: 'sequential',
          parameters: { type: 'object', properties: {} },
          execute: async (_id, _params, signal, _update, ctx) => {
            const result = await ctx.executeTool(
              'task_send',
              { task_id: target, content: 'RESUME_OWNED_CHILD' },
              { signal }
            )
            return { ...result.result, isError: result.isError }
          }
        })
        pi.on('tool_execution_start', (event) => {
          if (event.toolName === 'task_send') {
            parents.send = event.toolCallId
          }
          if (event.toolName === 'write') {
            parents.write = event.parentToolCallId
            writeStarted.resolve()
          }
          if (event.toolName === 'read') {
            parents.read = event.parentToolCallId
          }
        })
        pi.on('tool_call', async (event) => {
          if (event.toolName !== 'write') {
            return
          }
          waiting.resolve()
          if (cancel) {
            await release.promise
          }
        })
      },
      (pi) => {
        api = pi
        controller = registerTaskAgents(pi, { agentDir: f.agentDir })
      }
    ]
  })
  await loader.reload()
  assert.deepEqual(loader.getExtensions().errors, [])
  const { session } = await sdk.createAgentSession({
    cwd: f.cwd,
    agentDir: f.agentDir,
    resourceLoader: loader,
    settingsManager: settings,
    model: f.model as sdk.CreateAgentSessionOptions['model'],
    modelRuntime: f.runtime as unknown as sdk.ModelRuntime,
    sessionManager: sdk.SessionManager.create(f.cwd, join(f.root, 'parent'))
  })
  await session.bindExtensions({
    mode: 'json',
    onError: (error) => errors.push(error),
    abortHandler() {},
    shutdownHandler() {}
  })
  session.agent.toolExecution = 'sequential'
  t.after(async () => {
    release.resolve()
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    } finally {
      await session.dispose()
    }
    assert.deepEqual(errors, [])
  })
  api.sendMessage = () => {}
  const child = isChildContext
  let issued = false
  f.script((_step, context) =>
    child(context)
      ? answer('FIRST_CHILD_TURN')
      : !issued
        ? ((issued = true), action)
        : answer('PARENT_DONE')
  )
  const action = tool('task', {
    agent_name: 'worker',
    description: 'Retained child',
    prompt: 'INITIAL_OWNED_CHILD'
  })
  await session.prompt('Create one idle child.')
  const result = session.messages.findLast(
    (message) => message.role === 'toolResult' && message.toolName === 'task'
  )
  assert.ok(result && result.role === 'toolResult')
  const target = result.details.task_id
  assert.equal(controller.engine.task(target).status, 'succeeded')
  const sessionId = controller.engine.task(target).session_id
  const retained = controller.engine.sessions.get(sessionId).child
  return {
    ...f,
    session,
    controller,
    child,
    waiting,
    release,
    writeStarted,
    parents,
    retained,
    sessionId,
    target,
    async run(action, childScript) {
      let issued = false
      f.script((_step, context) =>
        child(context)
          ? childScript(context)
          : !issued
            ? ((issued = true), action)
            : answer('PARENT_DONE')
      )
      await session.prompt('Run the next owned parent action.')
    }
  }
}

for (const cancel of [false, true]) {
  test(
    'retained child uses the current nested task_send ancestry' +
      (cancel ? ' during cancellation' : ''),
    { timeout: 4000 },
    async (t) => {
      const f = await setup(t, cancel)
      let childCalls = 0
      const running = f.run(tool('owned_sender', {}), (context) => {
        assert.match(JSON.stringify(context), /FIRST_CHILD_TURN/)
        return ++childCalls === 1
          ? tool('write', { path: 'continued.txt', content: 'continued' })
          : answer('CONTINUED_CHILD')
      })
      await f.writeStarted.promise
      // A synthetic caller here would already be waiting on its own task_send queue
      // entry. The permission hook has not yet run in that failing case.
      assert.equal(f.parents.write, f.parents.send)
      await f.waiting.promise
      assert.equal(
        f.controller.engine.sessions.get(f.sessionId).child,
        f.retained,
        'The SDK child must actually be reused'
      )
      if (cancel) {
        const aborted = deferred(),
          abort = f.retained.abort.bind(f.retained)
        t.mock.method(f.retained, 'abort', () => {
          const result = abort()
          aborted.resolve()
          return result
        })
        const stopping = f.session.abort()
        await aborted.promise
        assert.equal(
          f.controller.engine.runtimes.size,
          1,
          'Cancellation must not report drain while a hook is waiting'
        )
        f.release.resolve()
        await stopping
      }
      await running
      const result = f.session.messages.findLast(
        (message) => message.role === 'toolResult' && message.toolName === 'owned_sender'
      )
      assert.ok(result && result.role === 'toolResult')
      assert.equal(result.details.status, cancel ? 'canceled' : 'succeeded')
      assert.equal(f.controller.engine.runtimes.size, 0)
      if (cancel) {
        await assert.rejects(readFile(join(f.cwd, 'continued.txt')), { code: 'ENOENT' })
      } else {
        assert.equal(await readFile(join(f.cwd, 'continued.txt'), 'utf8'), 'continued')
      }
    }
  )
}

test(
  'direct queued retained-child continuation restores its own admission binding after a background task frees capacity',
  { timeout: 4000 },
  async (t) => {
    const f = await setup(t, false, 1)
    const backgroundEntered = deferred(),
      releaseBackground = deferred()
    const start = tool('task', {
      agent_name: 'worker',
      description: 'Capacity holder',
      prompt: 'HOLD_BACKGROUND',
      run_in_background: true
    })
    start.content[0].id += '-background'
    await f.run(start, async () => {
      backgroundEntered.resolve()
      await releaseBackground.promise
      return answer('BACKGROUND_DONE')
    })
    await backgroundEntered.promise
    const background = [...f.controller.engine.runtimes.values()][0]
    let childCalls = 0
    const running = f.run(
      tool('task_send', { task_id: f.target, content: 'RESUME_OWNED_CHILD' }),
      () =>
        ++childCalls === 1
          ? tool('write', { path: 'queued-continuation.txt', content: 'continued' })
          : answer('QUEUED_CHILD_DONE')
    )
    assert.equal(
      await f.controller.engine.waitUntil(
        () =>
          f.controller.engine.state.tasks.some(
            (task) => task.session_id === f.sessionId && task.status === 'queued'
          ),
        1000
      ),
      true
    )
    releaseBackground.resolve()
    await running
    await background.done
    assert.equal(
      f.parents.write,
      f.parents.send,
      'Pump must not inherit the completing background task context'
    )
    assert.equal(f.controller.engine.sessions.get(f.sessionId).child, f.retained)
    assert.equal(await readFile(join(f.cwd, 'queued-continuation.txt'), 'utf8'), 'continued')
    assert.equal(f.controller.engine.runtimes.size, 0)
  }
)
