import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as sdk from '@earendil-works/pi-coding-agent'
import { registerTaskAgents } from '../src/extension.ts'
import { until } from './bounded.ts'
import { answer, deferred, fixture, tool } from './pi-backend-test-helpers.ts'

export const waitFor = (condition: () => unknown | Promise<unknown>, message?: string) =>
  until(condition, message ?? 'Expected state transition', 3000)

export const input = (prompt, background = false) => ({
  agent_name: 'worker',
  description: prompt,
  prompt,
  run_in_background: background
})
export const busy = (outcome) => {
  assert.equal(outcome.isError, true)
  assert.equal(outcome.result.details.code, 'TASK_FOREGROUND_BUSY')
  assert.equal(outcome.result.details.status, 409)
  assert.equal(outcome.result.details.retryable, true)
  assert.equal(outcome.result.details.admitted, false)
  assert.equal(outcome.result.details.task_id, undefined)
  assert.equal(outcome.result.details.accepted, undefined)
  assert.match(outcome.result.details.error_message, /parallel nested foreground/)
  assert.match(outcome.result.details.error_message, /run_in_background:true/)
}

const emptyOperation = async (_ctx, _signal) => ({ content: [], details: {} })
const emptyLeafHook = async (_event) => {}

export async function setup(t, mode, maxConcurrency = 4) {
  const f = await fixture(t)
  if (maxConcurrency !== 4) {
    await writeFile(join(f.agentDir, 'task-agents.json'), JSON.stringify({ maxConcurrency }))
  }
  await writeFile(join(f.cwd, 'seed.txt'), 'owned leaf')
  Object.assign(f.runtime, {
    getRegisteredProviderIds: () => [],
    getRegisteredProviderConfig() {},
    getRegisteredNativeProvider() {}
  })
  t.mock.method(sdk.ModelRuntime, 'create', async () => f.runtime)
  let controller,
    api,
    action,
    issued = false,
    phase = 0
  let operation = emptyOperation
  let leafHook = emptyLeafHook
  const handlers = new Map(),
    counts = new Map(),
    leaves = [],
    notifications = [],
    errors = []
  const releases = []
  const settings = sdk.SettingsManager.inMemory(
    { retry: { enabled: false }, compaction: { enabled: false } },
    { projectTrusted: true }
  )
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
          name: 'owned_call',
          label: 'Owned call',
          description: 'Parent-only nested invocation',
          executionMode: 'sequential',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' }, args: { type: 'object' } },
            required: ['name', 'args']
          },
          async execute(_id, params, signal, _update, ctx) {
            const result = await ctx.executeTool(params.name, params.args, { signal })
            return { ...result.result, isError: result.isError }
          }
        })
        pi.registerTool({
          name: 'owned_custom',
          label: 'Owned custom',
          description: 'Parent-only race fixture',
          parameters: { type: 'object', properties: {} },
          execute: (_id, _params, signal, _update, ctx) => operation(ctx, signal)
        })
        pi.on('tool_call', async (event) => {
          if (['write', 'read'].includes(event.toolName)) {
            leaves.push(event)
            await leafHook(event)
          }
        })
        pi.sendMessage = (message, options) => {
          notifications.push([message, options])
          // Persist the native receipt without starting an unrelated parent model turn.
          // A sink with no receipt would correctly trigger the controller's timed retry.
          session.sessionManager.appendCustomMessageEntry(
            message.customType,
            message.content,
            message.display,
            message.details
          )
        }
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
  session.agent.toolExecution = mode
  f.script((_step, context) => {
    if (!JSON.stringify(context).includes('## Delegated Task Contract')) {
      if (!issued) {
        issued = true
        return action
      }
      return answer('PARENT_DONE')
    }
    const names = new Set((context.tools ?? []).map((entry) => entry.name))
    for (const name of ['task', 'task_send', 'task_append', 'owned_call', 'owned_custom']) {
      assert.equal(names.has(name), false, 'Parent controls must not enter the child inventory')
    }
    const text = JSON.stringify(context.messages)
    const key = [...handlers.keys()].findLast((key) => text.includes(key))
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return handlers.get(key)?.(count, context) ?? answer('CHILD_DONE')
  })
  t.after(async () => {
    releases.forEach((release) => release())
    await session.abort()
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    await session.dispose()
    assert.deepEqual(errors, [])
  })
  async function run(name, args, id = `phase-${++phase}`) {
    action = tool(name, args)
    action.content[0].id = id
    issued = false
    await session.prompt('Run the next owned offline action.')
    const result = session.messages.findLast(
      (entry) => entry.role === 'toolResult' && entry.toolCallId === id
    )
    assert.ok(result)
    return { isError: result.isError, result, toolCallId: id }
  }
  return {
    ...f,
    api,
    session,
    controller,
    counts,
    leaves,
    notifications,
    run,
    handle(key, callback) {
      handlers.set(key, callback)
    },
    hook(callback) {
      leafHook = callback
    },
    custom(callback) {
      operation = callback
    },
    deferred() {
      const value = deferred()
      releases.push(value.resolve)
      return value
    },
    nested(name, args, id?) {
      return run('owned_call', { name, args }, id)
    },
    async drain() {
      await waitFor(() => controller.engine.runtimes.size === 0)
      // These run on real time and deliver several notices within a minute; reset
      // the burst window so drain observes every terminal task without waiting.
      controller.burstStartedAt = Date.now() - 60_000
      await controller.flush()
      await controller.flush()
    },
    async saturate(count = maxConcurrency, prefix = 'CHILD_BG') {
      const release = deferred(),
        entered = new Set(),
        tasks = []
      releases.push(release.resolve)
      /* oxlint-disable no-await-in-loop -- Create and observe one native background admission at a time. */
      for (let i = 0; i < count; i++) {
        const key = `${prefix}_${i}`
        handlers.set(key, async (step) => {
          if (step !== 1) {
            return answer(key + '_DONE')
          }
          entered.add(key)
          await release.promise
          return tool('write', { path: key + '.txt', content: key })
        })
        const result = await run('task', input(key, true))
        tasks.push(result.result.details)
      }
      /* oxlint-enable no-await-in-loop */
      await waitFor(() => entered.size === count)
      assert.equal(controller.engine.runtimes.size, count)
      return { release: release.resolve, tasks }
    }
  }
}
