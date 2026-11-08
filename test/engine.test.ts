import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { TaskEngine } from '../src/engine.ts'
import { TaskDomain } from '../src/task-domain.ts'
import { taskIdFromTurnId, taskTurnId } from '../src/vendor/mcode-adapters/task-turn-id.ts'
import {
  toTerminalProjection,
  type TaskTerminalOutcome,
  type TaskRunOutcome
} from '../src/engine-terminal.ts'
import { isTerminalTaskStatus } from '../src/vendor/mcode-background-task/status.ts'
import { normalizeTaskError } from '../src/vendor/mcode-background-task/errors.ts'
import type {
  BackgroundTask,
  BackgroundTaskPatch
} from '../src/vendor/mcode-background-task/types.ts'
import type {
  AgentProfile,
  ChildResult,
  CreateChildOptions,
  TaskEngineOptions,
  TaskInput,
  TaskRecord,
  TaskSummary
} from '../src/types.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

interface MockCall extends Deferred<ChildResult> {
  text: string
  turnId?: string
}

interface MockChild extends CreateChildOptions {
  calls: MockCall[]
  steers: string[]
  disposed: boolean
  prompt(text: string, options?: { turnId?: string }): Promise<ChildResult>
  steer(text: string): Promise<void>
  abort(): Promise<void>
  dispose(): Promise<void>
}

const profile: AgentProfile = Object.freeze({
  name: 'worker',
  model: 'test/model',
  thinking: 'medium',
  instructions: 'Work',
  tools: [],
  extensions: [],
  skills: [],
  mcp: false,
  timeoutMs: 0
})
const input = (prompt = 'hello'): TaskInput => ({
  agent_name: 'worker',
  description: 'test',
  prompt,
  run_in_background: true
})
const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
function terminalResult(status: 'succeeded' | 'failed' | 'aborted', text: string) {
  return { outcome: { kind: 'returned' as const, status }, text }
}
function settleResult(
  call: MockCall,
  status: 'succeeded' | 'failed' | 'aborted',
  text: string,
  errorMessage?: string
): void {
  const result = terminalResult(status, text)
  if (errorMessage === undefined) {
    call.resolve(result)
  } else {
    call.reject(Object.assign(new Error(errorMessage), { partialResult: result }))
  }
}

function holdNextPersistence(engine: TaskEngine): { entered: Promise<void>; release: () => void } {
  const original = engine.persist
  const entered = deferred()
  const release = deferred()
  let held = false
  engine.persist = function () {
    if (!held) {
      held = true
      entered.resolve()
      return release.promise.then(() => original.call(this))
    }
    return original.call(this)
  }
  return { entered: entered.promise, release: release.resolve }
}

interface SetupResult {
  engine: TaskEngine
  children: MockChild[]
  rootDir: string
  createChild: (args: CreateChildOptions) => Promise<MockChild>
}

async function setup(
  t: TestContext,
  options: Partial<TaskEngineOptions> = {}
): Promise<SetupResult> {
  const rootDir = await mkdtemp(fileURLToPath(new URL('../.engine-test-', import.meta.url)))
  const children: MockChild[] = []
  const createChild = async (args: CreateChildOptions): Promise<MockChild> => {
    const child: MockChild = {
      ...args,
      calls: [],
      steers: [],
      disposed: false,
      prompt(text: string, options?: { turnId?: string }): Promise<ChildResult> {
        const call = deferred<ChildResult>()
        this.calls.push({ text, turnId: options?.turnId, ...call })
        return call.promise
      },
      async steer(text: string): Promise<void> {
        this.steers.push(text)
      },
      async abort(): Promise<void> {
        const call = this.calls.at(-1)
        if (call) {
          settleResult(call, 'aborted', '', 'Aborted')
        }
      },
      async dispose(): Promise<void> {
        this.disposed = true
      }
    }
    children.push(child)
    return child
  }
  const engine = new TaskEngine({
    rootDir,
    parentId: 'parent',
    cwd: rootDir,
    createChild,
    ...options
  })
  await engine.init()
  t.after(async () => {
    for (const child of children) {
      for (const call of child.calls) {
        call.resolve({ text: 'cleanup' })
      }
    }
    await engine.close()
    await rm(rootDir, { recursive: true, force: true })
  })
  return { engine, children, rootDir, createChild }
}

async function waitFor(fn: () => unknown | Promise<unknown>): Promise<void> {
  /* oxlint-disable no-await-in-loop -- Poll one state transition at a time; the delay bounds retries. */
  for (let i = 0; i < 600; i++) {
    if (await fn()) {
      return
    }
    await delay(5)
  }
  /* oxlint-enable no-await-in-loop */
  assert.fail('Condition did not become true')
}

async function finish(engine: TaskEngine, child: MockChild, text = 'done'): Promise<void> {
  const task = (await engine.query()).findLast(
    (entry) => entry.childSessionPath === child.sessionPath
  )
  assert.ok(task)
  child.calls.at(-1).resolve({ text, usage: { tokens: 1 } })
  await waitFor(async () => (await engine.query({ task_id: task.task_id })).status === 'succeeded')
  await engine.runtimes.get(task.task_id)?.done
}

test('ACK, bounded admission, duplicate starts and frozen effective profiles', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  const [a, duplicate] = await Promise.all([
    engine.start({ ...input(), model: 'other/id', effort: 'high' }, profile, { requestId: 'one' }),
    engine.start(input(), profile, { requestId: 'one' })
  ])
  assert.equal(a.task_id, duplicate.task_id)
  const b = await engine.start(input('second'), profile)
  assert.equal(b.status, 'queued')
  await waitFor(() => children[0]?.calls.length === 1)
  assert.equal(children.length, 1)
  assert.equal(children[0].profile.model, 'other/id')
  assert.equal(children[0].profile.effort, 'high')
  assert.equal(children[0].profile.thinking, undefined)
  assert.ok(Object.isFrozen(children[0].profile.tools))
  await finish(engine, children[0])
  await waitFor(() => children[1]?.calls.length === 1)
  assert.equal((await engine.query({ task_id: a.task_id })).status, 'succeeded')
  await engine.stop(b.task_id)
})

test('finishing a task does not wait for an already running queued successor', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  const a = await engine.start(input(), profile)
  const b = await engine.start(input('queued successor'), profile)
  await waitFor(() => children[0]?.calls.length === 1)
  children[0].calls[0].resolve({ text: 'first complete' })
  await waitFor(() => children[1]?.calls.length === 1)
  await finish(engine, children[0])
  assert.equal((await engine.query({ task_id: a.task_id })).status, 'succeeded')
  assert.equal((await engine.query({ task_id: b.task_id })).status, 'running')
  await engine.stop(b.task_id)
})

test('running append steers once, idle append creates a task and reuses session history', async (t) => {
  const { engine, children } = await setup(t)
  const a = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const [one, two] = await Promise.all([
    engine.append(a.task_id, 'more', { requestId: 'x' }),
    engine.append(a.task_id, 'more', { requestId: 'x' })
  ])
  assert.equal(one.task_id, a.task_id)
  assert.equal(two.task_id, a.task_id)
  assert.equal(one.mode, 'steered')
  assert.equal(two.mode, 'duplicate')
  assert.equal(one.accepted, true)
  assert.equal(two.accepted, true)
  assert.deepEqual(children[0].steers, ['more'])
  await finish(engine, children[0])
  const b = await engine.append(a.task_id, 'continue')
  assert.notEqual(b.task_id, a.task_id)
  assert.equal(b.mode, 'activated')
  assert.equal(b.accepted, true)
  assert.equal(b.session_id, a.session_id)
  assert.equal(b.childSessionPath, a.childSessionPath)
  await waitFor(() => children[0].calls.length === 2)
  assert.equal(children.length, 1)
  assert.equal(children[0].calls[1].text, 'continue')
})

test('cancel waits for abort and prompt settlement before admitting another task', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  const a = await engine.start(input(), profile)
  const b = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const releaseAbort = deferred()
  children[0].abort = () => releaseAbort.promise
  let stopped = false
  const stopping = engine.stop(a.task_id).then(() => {
    stopped = true
  })
  await waitFor(async () => (await engine.query({ task_id: a.task_id })).status === 'stopping')
  children[0].calls[0].reject(new Error('Interrupted'))
  await tick()
  assert.equal(children.length, 1)
  assert.equal(stopped, false)
  releaseAbort.resolve()
  await stopping
  await waitFor(() => children[1]?.calls.length)
  assert.equal((await engine.query({ task_id: a.task_id })).status, 'canceled')
  assert.deepEqual(await engine.pendingNotifications(), [])
  await engine.stop(b.task_id)
})

test('UTF-8 byte output, automatic cursor, waiting, failure output, notification ack independence', async (t) => {
  const notifications: TaskSummary[] = []
  const { engine, children } = await setup(t, {
    notify: (value) => {
      notifications.push(value)
      throw new Error('delivery failed')
    }
  })
  const a = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  let returned = false
  const waiting = engine.output(a.task_id, { wait_ms: 30000, limitBytes: 8 }).then((value) => {
    returned = true
    return value
  })
  children[0].onOutput('assistant draft 中🙂x and tool status')
  await tick()
  assert.equal(returned, false)
  assert.equal((await engine.output(a.task_id, { offset: 0 })).output, '')
  settleResult(children[0].calls[0], 'failed', '中🙂x', 'boom')
  const first = await waiting
  assert.equal(first.output, '中🙂x')
  assert.equal(first.next_offset, 8)
  assert.equal(first.truncated, true)
  assert.equal((await engine.output(a.task_id)).output, '\n\n[failed] boom')
  assert.equal((await engine.output(a.task_id)).output, '')
  assert.equal((await engine.output(a.task_id, { offset: 0, limitBytes: 1 })).output, '中')
  assert.equal((await engine.output(a.task_id, { offset: 4, limitBytes: 1 })).output, 'x')
  await assert.rejects(engine.output(a.task_id, { offset: 1000 }), {
    code: 'TASK_OUTPUT_OFFSET_OUT_OF_RANGE',
    status: 416
  })
  await assert.rejects(engine.output(a.task_id, { offset: -1 }), {
    code: 'TASK_OUTPUT_INVALID',
    status: 400
  })
  await assert.rejects(engine.output(a.task_id, { limitBytes: 0 }), {
    code: 'TASK_OUTPUT_INVALID',
    status: 400
  })
  await waitFor(() => notifications.length === 1)
  assert.equal((await engine.output(a.task_id, { offset: 0 })).output, '中🙂x\n\n[failed] boom')
  assert.equal((await engine.query({ task_id: a.task_id })).status, 'failed')
  assert.equal((await engine.pendingNotifications()).length, 1)
  await engine.ackNotification(a.task_id)
  assert.deepEqual(await engine.pendingNotifications(), [])
})

test('foreground shares state machine; pre-aborted start and append do not dispatch', async (t) => {
  const { engine, children } = await setup(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(engine.start(input(), profile, { signal: controller.signal }), {
    name: 'AbortError'
  })
  assert.equal((await engine.query()).length, 0)
  const foreground = engine.start({ ...input(), run_in_background: false }, profile)
  await waitFor(() => children[0]?.calls.length)
  const [task] = await engine.query()
  await assert.rejects(engine.append(task.task_id, 'no', { signal: controller.signal }), {
    name: 'AbortError'
  })
  assert.deepEqual(children[0].steers, [])
  children[0].calls[0].resolve({ text: 'answer' })
  const result = await foreground
  assert.equal(result.status, 'succeeded')
  assert.equal(result.final_text, 'answer')
})

test('parent lock, isolation and same-process owner changes preserve runtime cursors and durable receipts', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const a = await engine.start(input(), profile, { requestId: 'stable' })
  await waitFor(() => children[0]?.calls.length)
  await finish(engine, children[0], 'saved')
  await waitFor(async () => (await engine.pendingNotifications()).length === 1)
  await engine.output(a.task_id, { limitBytes: 2 })
  const competitor = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await assert.rejects(competitor.init(), /active task owner/)
  const foreign = new TaskEngine({ rootDir, parentId: 'other', cwd: rootDir, createChild })
  await foreign.init()
  await assert.rejects(foreign.query({ task_id: a.task_id }), {
    code: 'TASK_NOT_FOUND',
    status: 404,
    message: `Local background task not found: ${a.task_id}`
  })
  await foreign.close()
  assert.equal((await stat(engine.store.file)).mode & 0o777, 0o600)
  assert.equal((await stat(engine.store.dir)).mode & 0o777, 0o700)
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(saved.tasks[0].profile.name, 'worker')
  await engine.close()
  assert.equal(children[0].disposed, true)
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    assert.equal(
      (await restored.start(input(), profile, { requestId: 'stable' })).task_id,
      a.task_id
    )
    assert.equal((await restored.output(a.task_id)).output, 'ved')
    assert.equal((await restored.pendingNotifications()).length, 1)
    const b = await restored.append(a.task_id, 'resume')
    await waitFor(() => children[1]?.calls.length)
    assert.equal(children[1].sessionPath, a.childSessionPath)
    await restored.stop(b.task_id)
  } finally {
    await restored.close()
  }
})

test('dead owner pending task becomes lost and can resume the same child JSONL path', async (t) => {
  const { engine, rootDir, createChild, children } = await setup(t)
  await engine.close()
  const script = `
    import { TaskEngine } from ${JSON.stringify(new URL('../src/engine.ts', import.meta.url).href)};
    const engine = new TaskEngine({rootDir: process.argv[1], parentId:'parent', cwd:process.argv[1],
      createChild: async ({sessionPath}) => ({sessionPath, prompt:()=>new Promise(()=>{}), abort:async()=>{}, dispose:async()=>{}})});
    await engine.init();
    await engine.start({agent_name:'worker',description:'crash',prompt:'run',run_in_background:true}, ${JSON.stringify(profile)}, {requestId:'crash'});
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, rootDir], {
    encoding: 'utf8'
  })
  assert.equal(child.status, 0, child.stderr)
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const [lost] = await restored.query()
    assert.equal(lost.status, 'lost')
    assert.equal((await restored.pendingNotifications()).length, 1)
    const next = await restored.append(lost.task_id, 'recover')
    await waitFor(() => children[0]?.calls.length)
    assert.equal(next.session_id, lost.session_id)
    assert.equal(children[0].sessionPath, lost.childSessionPath)
    await restored.stop(next.task_id)
  } finally {
    await restored.close()
  }
})

test('foreground abort waits for child stop; background tool signal does not cancel', async (t) => {
  const notifications: TaskSummary[] = []
  const { engine, children } = await setup(t, {
    notify: (task) => {
      notifications.push(task)
    }
  })
  const controller = new AbortController()
  let returned = false
  const foreground = engine
    .start({ ...input(), run_in_background: false }, profile, { signal: controller.signal })
    .then((value) => {
      returned = true
      return value
    })
  await waitFor(() => children[0]?.calls.length)
  const release = deferred()
  children[0].abort = () => release.promise
  controller.abort()
  children[0].calls[0].reject(new Error('Interrupted'))
  await tick()
  assert.equal(returned, false)
  release.resolve()
  const canceled = await foreground
  assert.equal(canceled.status, 'canceled')
  assert.equal(returned, true)
  assert.deepEqual(await engine.pendingNotifications(), [])
  assert.deepEqual(notifications, [])
  const backgroundController = new AbortController()
  const background = await engine.start(input(), profile, { signal: backgroundController.signal })
  await waitFor(() => children[1]?.calls.length)
  backgroundController.abort()
  await tick()
  assert.equal((await engine.query({ task_id: background.task_id })).status, 'running')
  await engine.stop(background.task_id)
})

test('foreground stopping-write failure rejects even when abort failure publishes a terminal status first', async (t) => {
  const { engine, children } = await setup(t)
  const controller = new AbortController()
  const starting = engine.start({ ...input(), run_in_background: false }, profile, {
    signal: controller.signal
  })
  await waitFor(() => children[0]?.calls.length)
  const task = engine.state!.tasks[0],
    runtime = engine.runtimes.get(task.task_id)!
  const save = engine.store.save.bind(engine.store)
  const failure = new Error('first running stop write failed')
  const writing = deferred()
  const abort = children[0].abort
  children[0].abort = async () => {
    throw new Error('native abort failed')
  }
  engine.store.save = async (state) => {
    if (state.tasks.some((item) => item.status === 'stopping')) {
      await writing.promise
    }
    await save(state)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    controller.abort()
    await waitFor(() => task.status === 'canceled' && engine.waiters.size === 0)
    writing.reject(failure)
    await assert.rejects(
      Promise.race([
        starting,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('foreground remained pending')), 1500)
        })
      ]),
      (error) => error === failure
    )
    assert.equal(engine.runtimes.get(task.task_id), runtime)
  } finally {
    clearTimeout(timer)
    writing.resolve()
    engine.store.save = save
    children[0].abort = abort
    children[0].calls[0].resolve({ text: 'owned cleanup' })
    await runtime.done
  }
})

test('foreground success never queues a parent wakeup', async (t) => {
  const notifications: TaskSummary[] = []
  const { engine, children } = await setup(t, { notify: (task) => notifications.push(task) })
  const foreground = engine.start({ ...input(), run_in_background: false }, profile)
  await waitFor(() => children[0]?.calls.length)
  children[0].calls[0].resolve({ text: 'answer' })
  assert.equal((await foreground).final_text, 'answer')
  assert.deepEqual(notifications, [])
  assert.deepEqual(await engine.pendingNotifications(), [])
})

test('append waits for prompt dispatch and cancellation during child creation skips prompt', async (t) => {
  let factoryArgs: CreateChildOptions | undefined
  const releaseFactory = deferred()
  const prompt = deferred<ChildResult>()
  const calls: string[][] = []
  const child = {
    sessionPath: '',
    async prompt(text: string): Promise<ChildResult> {
      calls.push(['prompt', text])
      return prompt.promise
    },
    async steer(text: string): Promise<void> {
      calls.push(['steer', text])
    },
    async abort(): Promise<void> {
      calls.push(['abort'])
      prompt.reject(new Error('Aborted'))
    },
    async dispose(): Promise<void> {}
  }
  const { engine } = await setup(t, {
    createChild: async (args) => {
      factoryArgs = args
      await releaseFactory.promise
      return child
    }
  })
  const task = await engine.start(input(), profile)
  const appending = engine.append(task.task_id, 'more')
  await waitFor(() => factoryArgs)
  assert.deepEqual(calls, [])
  releaseFactory.resolve()
  await appending
  assert.deepEqual(calls.slice(0, 2), [
    ['prompt', 'hello'],
    ['steer', 'more']
  ])
  await engine.stop(task.task_id)

  const releaseSecond = deferred()
  let factoryEntered = false
  let prompts = 0
  engine.createChild = async () => {
    factoryEntered = true
    await releaseSecond.promise
    return {
      sessionPath: '',
      async prompt(): Promise<ChildResult> {
        prompts++
        return { text: '' }
      },
      async steer(): Promise<void> {},
      async abort(): Promise<void> {},
      async dispose(): Promise<void> {}
    }
  }
  const second = await engine.start(input(), profile)
  await waitFor(() => factoryEntered)
  const stopping = engine.stop(second.task_id)
  releaseSecond.resolve()
  await stopping
  assert.equal(prompts, 0)
  assert.equal((await engine.query({ task_id: second.task_id })).status, 'canceled')
})

test('regression: close awaiting append admission prevents the first prompt after child initialization', async (t) => {
  const releaseFactory = deferred()
  const factoryEntered = deferred()
  const { engine, children, createChild } = await setup(t)
  engine.createChild = async (args) => {
    factoryEntered.resolve()
    await releaseFactory.promise
    const child = await createChild(args)
    const prompt = child.prompt.bind(child)
    child.prompt = (text, options) => {
      const result = prompt(text, options)
      child.calls.at(-1)!.resolve({ text: 'unexpected first prompt' })
      return result
    }
    return child
  }
  const task = await engine.start(input(), profile, { requestId: 'close-before-prompt' })
  await factoryEntered.promise
  const appending = engine.append(task.task_id, 'never delivered', { requestId: 'held-append' })
  const rejectedAppend = assert.rejects(appending)
  await waitFor(() => Boolean(engine.runtimes.get(task.task_id)?.delivery))
  const closing = engine.close()
  releaseFactory.resolve()
  await Promise.all([closing, rejectedAppend])
  assert.equal(children.length, 1)
  assert.equal(children[0].calls.length, 0, 'close request must fence the first prompt')
  assert.deepEqual(children[0].steers, [])
  assert.equal(children[0].disposed, true)
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(saved.tasks[0].status, 'canceled')
  assert.equal(saved.requests['start:close-before-prompt'], task.task_id)
  assert.equal(saved.requests[`append:${task.task_id}:held-append`], undefined)
})

test('regression: running persistence failure cannot leave child initialization behind close', async (t) => {
  const { engine, children, createChild } = await setup(t)
  const runningWrite = deferred()
  const writeEntered = deferred()
  const releaseFactory = deferred()
  const save = engine.store.save.bind(engine.store)
  const fault = new Error('running row write failed')
  let failRunning = true
  let factoryCalls = 0
  engine.store.save = async (state) => {
    if (failRunning && state.tasks.some((task) => task.status === 'running')) {
      failRunning = false
      writeEntered.resolve()
      await runningWrite.promise
      throw fault
    }
    return save(state)
  }
  engine.createChild = async (args) => {
    factoryCalls++
    await releaseFactory.promise
    return createChild(args)
  }
  const task = await engine.start(input(), profile, { requestId: 'running-write-failure' })
  await writeEntered.promise
  const done = engine.runtimes.get(task.task_id)!.done
  runningWrite.resolve()
  await done
  try {
    await engine.close()
  } finally {
    releaseFactory.resolve()
  }
  await tick()
  assert.equal(factoryCalls, 0, 'child creation must wait for the durable running row')
  assert.equal(children.length, 0, 'no child may appear after close releases ownership')
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(saved.requests['start:running-write-failure'], task.task_id)
  assert.equal(saved.tasks[0].status, 'failed')
  assert.equal(saved.tasks[0].error, fault.message)
})

test('regression: queued cancel retries a failed terminal write without repeating its output', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  await engine.start(input('blocker'), profile)
  const queued = await engine.start(input('never dispatched'), profile, {
    requestId: 'queued-stop'
  })
  await waitFor(() => children[0]?.calls.length)
  const save = engine.store.save.bind(engine.store)
  const fault = new Error('queued cancel write failed')
  let attempts = 0
  engine.store.save = async (state) => {
    if (state.tasks.find((task) => task.task_id === queued.task_id)?.status === 'canceled') {
      attempts++
      if (attempts === 1) {
        throw fault
      }
    }
    return save(state)
  }
  await assert.rejects(engine.stop(queued.task_id, 'first stop reason'), fault)
  const beforeRetry = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(beforeRetry.tasks[1].status, 'queued')
  const stopped = await engine.stop(queued.task_id, 'must not replace the first reason')
  assert.equal(stopped.status, 'canceled')
  assert.equal(attempts, 2, 'terminal in-memory status is not a durable cancellation receipt')
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(saved.tasks[1].status, 'canceled')
  assert.equal(saved.tasks[1].cancel_reason, 'first stop reason')
  assert.equal(saved.tasks[1].output, '\n\n[aborted] first stop reason')
  assert.equal(saved.requests['start:queued-stop'], queued.task_id)
  assert.equal(children.length, 1)
})

test('regression: an unconfirmed queued cancellation rejects its foreground waiter with a defined error', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  await engine.start(input('blocker'), profile)
  const foreground = engine.start(
    { ...input('blocked foreground'), run_in_background: false },
    profile
  )
  await waitFor(() => children[0]?.calls.length)
  const queued = (await engine.query()).find((task) => task.status === 'queued')
  assert.ok(queued)
  const save = engine.store.save.bind(engine.store)
  const fault = new Error('queued cancel write failed')
  engine.store.save = async () => {
    throw fault
  }
  const rejected = assert.rejects(foreground, (error) => {
    assert.ok(
      error instanceof Error,
      'an unconfirmed terminal write must not reject with undefined'
    )
    assert.match(error.message, /unconfirmed/)
    return true
  })
  await assert.rejects(engine.stop(queued.task_id, 'stop queued'), fault)
  engine.changed(engine.task(queued.task_id))
  await rejected
  engine.store.save = save
  await engine.close()
})

test('regression: close retries uncertain queued cancellations and retains ownership on another write failure', async (t) => {
  /* oxlint-disable no-await-in-loop -- Each case owns a separate store and completes its close retries before cleanup. */
  for (const committed of [false, true]) {
    await t.test(committed ? 'post-commit rejection' : 'pre-commit rejection', async (t) => {
      const { engine, children } = await setup(t)
      engine.pump = () => {}
      const queued = await engine.start(input(), profile, { requestId: 'close-retry-stop' })
      const save = engine.store.save.bind(engine.store)
      const fault = new Error('uncertain queued cancellation')
      let fail = true
      let attempts = 0
      engine.store.save = async (state) => {
        attempts++
        if (fail) {
          if (committed) {
            await save(state)
          }
          throw fault
        }
        return save(state)
      }
      await assert.rejects(engine.stop(queued.task_id, 'original cancellation'), fault)
      assert.equal(
        JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0].status,
        committed ? 'canceled' : 'queued'
      )
      await assert.rejects(engine.close(), fault)
      assert.equal(attempts, 2, 'close must retry even an in-memory terminal cancellation')
      assert.equal((await engine.query({ task_id: queued.task_id })).status, 'canceled')
      const other = new TaskEngine({
        rootDir: engine.store.rootDir,
        parentId: engine.parentId,
        cwd: engine.cwd,
        createChild: engine.createChild
      })
      await assert.rejects(other.init(), /locked|owner/i)
      fail = false
      await engine.close()
      assert.equal(attempts, 3)
      const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
      assert.equal(saved.tasks[0].status, 'canceled')
      assert.equal(saved.tasks[0].cancel_reason, 'original cancellation')
      assert.equal(saved.tasks[0].output, '\n\n[aborted] original cancellation')
      assert.equal(saved.requests['start:close-retry-stop'], queued.task_id)
      assert.equal(children.length, 0)
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('regression: foreground terminal write failures reject without rewriting execution facts', async (t) => {
  /* oxlint-disable no-await-in-loop -- Each case checks one owner's disk state and close retries before releasing its store. */
  for (const operation of ['start', 'send'] as const) {
    for (const committed of [false, true]) {
      await t.test(`${operation}: ${committed ? 'post' : 'pre'}-commit rejection`, async (t) => {
        const { engine, children, rootDir, createChild } = await setup(t)
        let previous: TaskSummary | undefined
        if (operation === 'send') {
          previous = await engine.start(input('previous turn'), profile)
          await waitFor(() => children[0]?.calls.length)
          await finish(engine, children[0], 'previous result')
        }
        const requestId = 'foreground-terminal-failure'
        const foreground = previous
          ? engine.send(previous.session_id, 'new turn', { requestId })
          : engine.start({ ...input('new turn'), run_in_background: false }, profile, {
              requestId
            })
        const receipt = foreground.then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error })
        )
        await waitFor(() => children[0]?.calls.length === (previous ? 2 : 1))
        const task = engine.state!.tasks.at(-1)!
        const done = engine.runtimes.get(task.task_id)!.done
        const save = engine.store.save.bind(engine.store)
        const fault = Object.assign(new Error('terminal snapshot was not acknowledged'), {
          code: 'EIO'
        })
        let fail = true
        let attempts = 0
        engine.store.save = async (state) => {
          if (state.tasks.find((row) => row.task_id === task.task_id)?.status === 'succeeded') {
            attempts++
            if (fail) {
              if (committed) {
                await save(state)
              }
              throw fault
            }
          }
          return save(state)
        }
        t.after(() => {
          engine.store.save = save
        })
        children[0].calls.at(-1)!.resolve(terminalResult('succeeded', 'side effect completed'))
        await done
        const response = await receipt
        assert.equal(task.status, 'succeeded')
        assert.equal(task.final_text, 'side effect completed')
        assert.equal(task.output, 'side effect completed')
        assert.equal(task.error, undefined)
        assert.equal(task.notification_pending, false)
        assert.equal(engine.waiters.size, 0)
        assert.equal(engine.runtimes.size, 0)
        const requestKey = previous
          ? `send:${previous.session_id}:${requestId}`
          : `start:${requestId}`
        const disk = JSON.parse(await readFile(engine.store.file, 'utf8'))
        assert.equal(disk.requests[requestKey], task.task_id)
        assert.equal(disk.tasks.at(-1).status, committed ? 'succeeded' : 'running')
        assert.equal(disk.tasks.at(-1).output, committed ? task.output : '')
        await assert.rejects(engine.query({ task_id: task.task_id }), (error) => error === fault)
        await assert.rejects(engine.close(), (error) => error === fault)
        assert.equal(attempts, 2)
        assert.equal(children[0].disposed, false, 'failed close must retain the child owner')
        const restored = new TaskEngine({
          rootDir,
          parentId: engine.parentId,
          cwd: rootDir,
          createChild
        })
        await assert.rejects(restored.init(), /locked|owner/i)
        fail = false
        await engine.close()
        assert.equal(attempts, 3)
        assert.equal(children[0].disposed, true)
        await restored.init()
        try {
          const recovered = await restored.query({ task_id: task.task_id })
          assert.equal(recovered.status, 'succeeded')
          assert.equal(recovered.final_text, 'side effect completed')
          assert.equal((await restored.output(task.task_id)).output, task.output)
          const duplicate = previous
            ? await restored.send(previous.session_id, 'do not repeat', { requestId })
            : await restored.start({ ...input(), run_in_background: false }, profile, {
                requestId
              })
          assert.equal(duplicate.task_id, task.task_id)
          assert.equal(duplicate.status, 'succeeded')
          assert.equal(children.length, 1)
          assert.equal(children[0].calls.length, previous ? 2 : 1)
        } finally {
          await restored.close()
        }
        assert.equal(response.result, undefined, 'unconfirmed persistence is not a success receipt')
        assert.equal(response.error, fault, 'preserve the original storage error and its code')
      })
    }
  }
  /* oxlint-enable no-await-in-loop */
})

test('regression: falsy terminal persistence rejections poison the owner with a usable error', async (t) => {
  /* oxlint-disable no-await-in-loop -- Each rejection value owns a separate store and close retry. */
  for (const value of [undefined, null, false, 0, Number.NaN, '', 0n]) {
    await t.test(`${typeof value}: ${String(value)}`, async (t) => {
      const { engine, children } = await setup(t)
      const foreground = engine.start({ ...input(), run_in_background: false }, profile)
      const receipt = foreground.then(
        (result) => ({ status: 'fulfilled', result, reason: undefined }),
        (reason: unknown) => ({ status: 'rejected', result: undefined, reason })
      )
      await waitFor(() => children[0]?.calls.length)
      const task = engine.state!.tasks[0]
      const done = engine.runtimes.get(task.task_id)!.done
      const save = engine.store.save.bind(engine.store)
      engine.store.save = async () => Promise.reject(value)
      t.after(() => {
        engine.store.save = save
      })
      children[0].calls[0].resolve({ text: 'completed side effect' })
      await done
      const response = await receipt
      const disk = JSON.parse(await readFile(engine.store.file, 'utf8'))
      assert.equal(disk.tasks[0].status, 'running')
      assert.equal(disk.tasks[0].output, '')
      assert.equal(task.status, 'succeeded')
      assert.equal(task.final_text, 'completed side effect')
      assert.equal(task.error, undefined)
      const query = await engine.query({ task_id: task.task_id }).then(
        (result) => ({ status: 'fulfilled', result, reason: undefined }),
        (reason: unknown) => ({ status: 'rejected', result: undefined, reason })
      )
      assert.equal(query.status, 'rejected', 'unconfirmed disk state must poison reads')
      assert.equal(response.status, 'rejected')
      assert.ok(response.reason instanceof Error)
      assert.match(response.reason.message, /persistence failed/i)
      assert.equal(response.reason.cause, value)
      assert.equal(query.reason, response.reason)
      await assert.rejects(engine.output(task.task_id), (error) => error === response.reason)
      await assert.rejects(engine.start(input(), profile), (error) => error === response.reason)
      await assert.rejects(
        engine.send(task.task_id, 'do not replay'),
        (error) => error === response.reason
      )
      await assert.rejects(engine.append(task.task_id, 'do not replay'), (error) => {
        assert.ok(error instanceof Error && 'code' in error)
        assert.equal(error.code, 'TASK_APPEND_PERSIST_FAILED')
        assert.equal(error.cause, response.reason)
        return true
      })
      await assert.rejects(engine.close(), (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.cause, value)
        return true
      })
      await assert.rejects(engine.query(), (error) => error === response.reason)
      assert.equal(children[0].disposed, false)
      const other = new TaskEngine({
        rootDir: engine.store.rootDir,
        parentId: engine.parentId,
        cwd: engine.cwd,
        createChild: engine.createChild
      })
      await assert.rejects(other.init(), /locked|owner/i)
      engine.store.save = save
      await engine.close()
      assert.equal(children[0].disposed, true)
      const recovered = JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0]
      assert.equal(recovered.status, 'succeeded')
      assert.equal(recovered.output, 'completed side effect')
      assert.equal(engine.waiters.size, 0)
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('regression: falsy close rejection does not replace the original storage error', async (t) => {
  const { engine, children } = await setup(t)
  const original = Object.assign(new Error('original terminal write failure'), { code: 'EIO' })
  const foreground = engine.start({ ...input(), run_in_background: false }, profile)
  const receipt = assert.rejects(foreground, (error) => error === original)
  await waitFor(() => children[0]?.calls.length)
  const save = engine.store.save.bind(engine.store)
  engine.store.save = async () => Promise.reject(original)
  t.after(() => {
    engine.store.save = save
  })
  children[0].calls[0].resolve({ text: 'completed' })
  await receipt
  engine.store.save = async () => Promise.reject(null)
  await assert.rejects(engine.close(), (error) => {
    assert.ok(error instanceof Error)
    assert.equal(error.cause, null)
    return true
  })
  await assert.rejects(engine.query(), (error) => error === original)
  assert.equal(children[0].disposed, false)
  engine.store.save = save
  await engine.close()
  assert.equal(JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0].output, 'completed')
})

for (const stage of ['admission', 'running'] as const) {
  test(`regression: in-flight ${stage} failure cannot replace the first terminal storage error`, async (t) => {
    /* oxlint-disable no-await-in-loop -- Each first-error value needs its own controlled write race and owner recovery. */
    for (const initial of [new Error('first terminal write failure'), undefined]) {
      await t.test(initial ? 'Error first' : 'undefined first', async (t) => {
        const { engine, children, rootDir, createChild } = await setup(t, {
          maxConcurrency: stage === 'admission' ? 1 : 2
        })
        const foreground = engine.start({ ...input('A'), run_in_background: false }, profile, {
          requestId: 'first-error-A'
        })
        const firstReceipt = foreground.then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error })
        )
        await waitFor(() => children[0]?.calls.length)
        const a = engine.state!.tasks[0]
        const aDone = engine.runtimes.get(a.task_id)!.done
        let queued: TaskSummary
        if (stage === 'admission') {
          queued = await engine.start(input('queued for close'), profile)
        }
        const entered = deferred()
        const release = deferred()
        const save = engine.store.save.bind(engine.store)
        const later = Object.assign(new Error(`later ${stage} write failure`), { code: 'ENOSPC' })
        let held = false
        let failFirst = true
        engine.store.save = async (state) => {
          const b = state.tasks.find((task) => task.input.prompt === 'B')
          if (!held && b?.status === (stage === 'admission' ? 'queued' : 'running')) {
            held = true
            entered.resolve()
            await release.promise
            throw later
          }
          if (failFirst && a.status === 'succeeded') {
            failFirst = false
            throw initial
          }
          return save(state)
        }
        t.after(() => {
          engine.store.save = save
          release.resolve()
        })
        const bReceipt = engine.start(input('B'), profile, { requestId: 'later-error-B' }).then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error })
        )
        await entered.promise
        const b = engine.state!.tasks.find((task) => task.input.prompt === 'B')!
        const bDone = engine.runtimes.get(b.task_id)?.done
        if (stage === 'running') {
          queued = await engine.start(input('queued for close'), profile)
        }
        children[0].calls[0].resolve({ text: 'A side effect completed' })
        await aDone
        const first = await firstReceipt
        assert.ok(first.error instanceof Error)
        if (initial) {
          assert.equal(first.error, initial)
        } else {
          assert.match(first.error.message, /persistence failed/i)
          assert.equal(first.error.cause, undefined)
        }
        await assert.rejects(engine.query(), (error) => error === first.error)
        release.resolve()
        const second = await bReceipt
        await bDone
        if (stage === 'admission') {
          assert.equal(second.error, later, 'the failing operation keeps its own error')
          assert.equal(engine.state!.tasks.includes(b), false)
          assert.equal(engine.state!.requests['start:later-error-B'], undefined)
        } else {
          assert.ok(second.result)
          assert.equal(b.status, 'failed')
          assert.equal(
            b.error,
            later.message,
            'runner failure must not be rewritten as the first error'
          )
        }
        await assert.rejects(engine.query(), (error) => error === first.error)
        await assert.rejects(engine.output(a.task_id), (error) => error === first.error)
        await assert.rejects(engine.start(input(), profile), (error) => error === first.error)
        assert.equal(engine.task(queued!.task_id).status, 'queued')
        assert.equal(
          children.length,
          1,
          'neither B nor queued work may create a child after poisoning'
        )
        assert.equal(a.status, 'succeeded')
        assert.equal(a.error, undefined)
        engine.store.save = save
        await engine.close()
        assert.equal(children[0].disposed, true)
        const restored = new TaskEngine({
          rootDir,
          parentId: engine.parentId,
          cwd: rootDir,
          createChild
        })
        await restored.init()
        try {
          const recovered = await restored.start(
            { ...input('A'), run_in_background: false },
            profile,
            {
              requestId: 'first-error-A'
            }
          )
          assert.equal(recovered.task_id, a.task_id)
          assert.equal(recovered.status, 'succeeded')
          assert.equal((await restored.output(a.task_id)).output, 'A side effect completed')
          const canceled = await restored.query({ task_id: queued!.task_id })
          assert.equal(canceled.status, 'canceled')
          assert.equal(canceled.cancel_reason, 'Parent closed')
          assert.equal(
            (await restored.output(canceled.task_id)).output,
            '\n\n[aborted] Parent closed'
          )
          const fresh = restored.start({ ...input('fresh'), run_in_background: false }, profile)
          await waitFor(() => children[1]?.calls.length)
          children[1].calls[0].resolve({ text: 'fresh success' })
          assert.equal((await fresh).status, 'succeeded')
          const toStop = await restored.start(input('cancel safely'), profile)
          await waitFor(() => children[2]?.calls.length)
          assert.equal((await restored.stop(toStop.task_id)).status, 'canceled')
          assert.equal(engine.waiters.size, 0)
        } finally {
          await restored.close()
        }
      })
    }
    /* oxlint-enable no-await-in-loop */
  })
}

test('regression: unconfirmed foreground failure preserves runner error classification and output', async (t) => {
  /* oxlint-disable no-await-in-loop -- Each outcome needs its own poisoned owner and terminal write retry. */
  for (const outcome of ['failed', 'aborted', 'exception'] as const) {
    await t.test(outcome, async (t) => {
      const { engine, children } = await setup(t)
      const foreground = engine.start({ ...input(), run_in_background: false }, profile)
      const receipt = assert.rejects(foreground, (error) => error === storageFault)
      await waitFor(() => children[0]?.calls.length)
      const task = engine.state!.tasks[0]
      const done = engine.runtimes.get(task.task_id)!.done
      const save = engine.store.save.bind(engine.store)
      const storageFault = new Error('terminal storage failure')
      const runnerFault = new Error('runner failure')
      engine.store.save = async () => {
        throw storageFault
      }
      t.after(() => {
        engine.store.save = save
      })
      if (outcome === 'exception') {
        children[0].calls[0].reject(runnerFault)
      } else {
        settleResult(children[0].calls[0], outcome, 'partial result', runnerFault.message)
      }
      await receipt
      await done
      assert.equal(task.status, outcome === 'aborted' ? 'canceled' : 'failed')
      assert.equal(task.error, runnerFault.message)
      assert.equal(task.final_text, outcome === 'exception' ? undefined : 'partial result')
      const output = `${outcome === 'exception' ? '' : 'partial result'}\n\n[${outcome === 'aborted' ? 'aborted' : 'failed'}] runner failure`
      assert.equal(task.output, output)
      assert.equal(engine.summary(task).error, runnerFault.message)
      assert.equal(engine.waiters.size, 0)
      engine.store.save = save
      await engine.close()
      const disk = JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0]
      assert.equal(disk.status, task.status)
      assert.equal(disk.error, runnerFault.message)
      assert.equal(disk.output, output, 'retry must not append a second terminal projection')
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('regression: a confirmed foreground terminal is not rejected for another task storage failure', async (t) => {
  const { engine, children } = await setup(t)
  const fault = new Error('other task terminal storage failure')
  const unconfirmed = engine.start({ ...input('unconfirmed'), run_in_background: false }, profile)
  const rejected = assert.rejects(unconfirmed, (error) => error === fault)
  const confirmed = engine.start({ ...input('confirmed'), run_in_background: false }, profile)
  await waitFor(() => children.length === 2 && children.every((child) => child.calls.length))
  const save = engine.store.save.bind(engine.store)
  let fail = true
  engine.store.save = async (state) => {
    if (fail && state.tasks[0].status === 'succeeded') {
      fail = false
      throw fault
    }
    return save(state)
  }
  children[0].calls[0].resolve({ text: 'first result' })
  await rejected
  children[1].calls[0].resolve({ text: 'second result' })
  const result = await confirmed
  assert.equal(result.status, 'succeeded')
  assert.equal(result.final_text, 'second result')
  const disk = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(disk.tasks[1].status, 'succeeded')
  assert.equal(disk.tasks[1].final_text, 'second result')
})

test('regression: microtask stop after prompt completion retains the slot until abort settles', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  const a = await engine.start(input('A'), profile)
  await engine.start(input('B'), profile)
  await waitFor(() => children[0]?.calls.length)
  engine.persist = async () => {}
  const releaseAbort = deferred()
  let aborts = 0
  children[0].abort = async () => {
    aborts++
    await releaseAbort.promise
  }
  let stopping: Promise<TaskSummary> | undefined
  children[0].calls[0].resolve({ text: 'A done' })
  queueMicrotask(() => {
    stopping = engine.stop(a.task_id)
  })
  try {
    await tick()
    if (aborts) {
      assert.equal(children.length, 1, 'B must not start while A abort is pending')
      assert.equal((await engine.query({ task_id: a.task_id })).status, 'stopping')
    } else {
      assert.equal((await engine.query({ task_id: a.task_id })).status, 'succeeded')
    }
  } finally {
    releaseAbort.resolve()
    await stopping
  }
})

test('regression: running append is delivered when prompt finishes during persistence', async (t) => {
  const { engine, children } = await setup(t)
  const a = await engine.start(input('A'), profile)
  await waitFor(() => children[0]?.calls.length)
  engine.persist = async () => {}
  const barrier = holdNextPersistence(engine)
  const appending = engine.append(a.task_id, 'append-race')
  await barrier.entered
  children[0].calls[0].resolve({ text: 'A done' })
  await tick()
  barrier.release()
  const result = await appending
  await engine.runtimes.get(result.task_id)?.started
  const delivered =
    children[0].steers.filter((text) => text === 'append-race').length +
    children[0].calls.filter((call) => call.text === 'append-race').length
  assert.equal(delivered, 1, 'successful append must deliver content exactly once')
})

test('regression: queued append promoted during persistence is not also steered', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  await engine.start(input('A'), profile)
  const b = await engine.start(input('B'), profile)
  await waitFor(() => children[0]?.calls.length)
  engine.persist = async () => {}
  const barrier = holdNextPersistence(engine)
  const appending = engine.append(b.task_id, 'queued-race')
  await barrier.entered
  children[0].calls[0].resolve({ text: 'A done' })
  await tick()
  barrier.release()
  await appending
  await waitFor(() => children[1]?.calls.length)
  const delivered =
    children[1].steers.filter((text) => text === 'queued-race').length +
    children[1].calls.filter((call) => call.text.includes('queued-race')).length
  assert.equal(delivered, 1, 'queued content must not be in both prompt and steer')
})

test('regression: rejected steer can retry the same requestId without losing content', async (t) => {
  const { engine, children } = await setup(t)
  const task = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  let attempts = 0
  children[0].steer = async (text) => {
    if (++attempts === 1) {
      throw Object.assign(new Error('Not accepted'), { steerAccepted: false })
    }
    children[0].steers.push(text)
  }
  await assert.rejects(
    engine.append(task.task_id, 'retry-content', { requestId: 'retry' }),
    /Not accepted/
  )
  await engine.append(task.task_id, 'retry-content', { requestId: 'retry' })
  assert.equal(attempts, 2)
  assert.deepEqual(children[0].steers, ['retry-content'])
})

test('regression: settled SDK steer rejection resumes a new task and deduplicates its ACK', async (t) => {
  const { engine, children } = await setup(t)
  const a = await engine.start(input('A'), profile)
  await waitFor(() => children[0]?.calls.length)
  children[0].steer = async () => {
    children[0].calls[0].resolve({ text: 'settled' })
    throw Object.assign(new Error('Current prompt already settled'), { steerAccepted: false })
  }
  const b = await engine.append(a.task_id, 'followup', { requestId: 'settled' })
  assert.notEqual(b.task_id, a.task_id)
  assert.equal(b.session_id, a.session_id)
  await waitFor(() => children[0].calls.length === 2)
  assert.equal(children[0].calls[1].text, 'followup')
  assert.equal(
    (await engine.append(a.task_id, 'followup', { requestId: 'settled' })).task_id,
    b.task_id
  )
  let aborts = 0
  const originalAbort = children[0].abort
  children[0].abort = async function () {
    aborts++
    await originalAbort.call(this)
  }
  await engine.stop(a.task_id)
  assert.equal(aborts, 0, 'stopping the old task cannot abort its reused child')
  assert.equal((await engine.query({ task_id: b.task_id })).status, 'running')
})

test('MCode completion seals cancellation and retains admission until its update settles', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  const first = await engine.start(input('A'), profile)
  await engine.start(input('B'), profile)
  await waitFor(() => children[0]?.calls.length)
  const entered = deferred()
  const release = deferred()
  const originalFinish = TaskDomain.prototype.finish
  TaskDomain.prototype.finish = async function (
    this: TaskDomain,
    task: TaskRecord,
    status: 'succeeded' | 'failed' | 'canceled'
  ): Promise<void> {
    if (task.task_id === first.task_id) {
      entered.resolve()
      await release.promise
    }
    await originalFinish.call(this, task, status)
  }
  let aborts = 0
  const originalAbort = children[0].abort
  children[0].abort = async () => {
    aborts++
    await originalAbort.call(children[0])
  }
  try {
    children[0].calls[0].resolve({ text: 'A done' })
    await entered.promise
    const stopping = engine.stop(first.task_id)
    await tick()
    assert.equal(aborts, 0)
    assert.equal(children.length, 1)
    release.resolve()
    assert.equal((await stopping).status, 'succeeded')
    await waitFor(() => children[1]?.calls.length)
  } finally {
    release.resolve()
    TaskDomain.prototype.finish = originalFinish
  }
})

test('timeout fails without notifying cancellation; close cancels queued and running tasks', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  const timed = await engine.start(input(), { ...profile, timeoutMs: 10 })
  await waitFor(async () => (await engine.query({ task_id: timed.task_id })).status === 'failed')
  assert.match((await engine.query({ task_id: timed.task_id })).error, /timed out/)
  const running = await engine.start(input(), profile)
  const queued = await engine.start(input(), profile)
  // The first task may now time out before its factory is called.
  await waitFor(() =>
    children.some((child) => child.sessionPath === running.childSessionPath && child.calls.length)
  )
  await engine.close()
  const tasks = JSON.parse(await readFile(engine.store.file, 'utf8')).tasks
  for (const id of [running.task_id, queued.task_id]) {
    const task = tasks.find((item) => item.task_id === id)
    assert.equal(task.status, 'canceled')
    assert.equal(task.notification_pending, false)
  }
  assert.ok(children.every((child) => child.disposed))
})

test('regression: omitted background flag waits and never emits a background notification', async (t) => {
  const { engine, children } = await setup(t)
  let returned = false
  const foreground = engine
    .start({ ...input('  work  '), run_in_background: undefined }, profile)
    .then((result) => {
      returned = true
      return result
    })
  await waitFor(() => children[0]?.calls.length)
  assert.equal(returned, false)
  assert.equal(children[0].calls[0].text, '  work  ')
  children[0].calls[0].resolve({ text: 'answer' })
  assert.equal((await foreground).final_text, 'answer')
  assert.deepEqual(await engine.pendingNotifications(), [])
  assert.equal(engine.waiters.size, 0)
})

test('regression: model override clears inherited thinking and optional selection survives restart', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const selected = await engine.start(
    { ...input(), model: '  other/model  ' },
    { ...profile, effort: 'low' }
  )
  await waitFor(() => children[0]?.calls.length)
  assert.equal(children[0].profile.model, 'other/model')
  assert.equal(children[0].profile.thinking, undefined)
  assert.equal(children[0].profile.effort, undefined)
  const effortOnly = await engine.start({ ...input(), effort: 'high' }, profile)
  await waitFor(() => children[1]?.calls.length)
  assert.equal(children[1].profile.model, profile.model)
  assert.equal(children[1].profile.effort, 'high')
  assert.equal(children[1].profile.thinking, undefined)
  const inherited = await engine.start(input(), {
    ...profile,
    model: undefined,
    thinking: undefined,
    extensions: undefined,
    skills: undefined,
    mcp: undefined,
    mcpServers: ['trusted'],
    disallowedTools: ['trusted:write']
  })
  await waitFor(() => children[2]?.calls.length)
  assert.equal(children[2].profile.model, undefined)
  assert.equal(children[2].profile.thinking, undefined)
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const child of children) {
    await finish(engine, child)
  }
  /* oxlint-enable no-await-in-loop */
  await engine.close()
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
    for (const id of [selected.task_id, effortOnly.task_id, inherited.task_id]) {
      assert.equal((await restored.query({ task_id: id })).status, 'succeeded')
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(restored.task(selected.task_id).profile.thinking, undefined)
    assert.equal(restored.task(inherited.task_id).profile.model, undefined)
    assert.equal(restored.task(inherited.task_id).profile.skills, undefined)
    assert.equal(restored.task(inherited.task_id).profile.mcp, undefined)
    assert.deepEqual(restored.task(inherited.task_id).profile.mcpServers, ['trusted'])
    assert.deepEqual(restored.task(inherited.task_id).profile.disallowedTools, ['trusted:write'])
  } finally {
    await restored.close()
  }
})

test('regression: shared input boundary normalizes Unicode titles and rejects invalid content', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const description of ['', ' \n\t', '🙂'.repeat(51)]) {
    await assert.rejects(engine.start({ ...input(), description }, profile), /1-50 Unicode/)
  }
  /* oxlint-enable no-await-in-loop */
  await assert.rejects(
    engine.start({ ...input(), description: undefined }, profile),
    /1-50 Unicode/
  )
  await assert.rejects(
    engine.start({ ...input(), prompt: 123 as unknown as string }, profile),
    /prompt must be a string/
  )
  await assert.rejects(
    engine.start({ ...input(), model: '  ' }, profile),
    /model must not be blank/
  )
  assert.equal((await engine.query()).length, 0)
  const running = await engine.start({ ...input(), description: '  title\n\t second  ' }, profile)
  const queued = await engine.start({ ...input(), description: '🙂'.repeat(50) }, profile)
  assert.equal(running.description, 'title second')
  assert.equal(queued.description, '🙂'.repeat(50))
  await waitFor(() => children[0]?.calls.length)
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const id of [running.task_id, queued.task_id]) {
    await assert.rejects(engine.append(id, ' \n\t '), /empty after trimming/)
  }
  /* oxlint-enable no-await-in-loop */
  const receipt = await engine.append(` ${queued.task_id} `, '  queued addition  ', {
    requestId: 'queued'
  })
  assert.equal(receipt.mode, 'steered')
  assert.equal(receipt.accepted, true)
  await finish(engine, children[0])
  await assert.rejects(engine.append(running.task_id, '  '), /empty after trimming/)
  await waitFor(() => children[1]?.calls.length)
  assert.equal(children[1].calls[0].text, 'hello\nqueued addition')
  assert.equal(
    (await engine.append(queued.task_id, 'queued addition', { requestId: 'queued' })).mode,
    'duplicate'
  )
  assert.deepEqual(children[1].steers, [])
})

test('regression: append receipt survives reload and never redelivers an admitted append', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  await finish(engine, children[0])
  const activated = await engine.append(first.task_id, '  next  ', { requestId: 'durable' })
  assert.equal(activated.mode, 'activated')
  await waitFor(() => children[0].calls.length === 2)
  assert.equal(children[0].calls[1].text, 'next')
  await finish(engine, children[0])
  await engine.close()
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const duplicate = await restored.append(first.task_id, 'next', { requestId: 'durable' })
    assert.equal(duplicate.task_id, activated.task_id)
    assert.equal(duplicate.mode, 'duplicate')
    assert.equal(duplicate.accepted, true)
    assert.equal(children.length, 1)
    assert.equal((await restored.query()).length, 2)
  } finally {
    await restored.close()
  }
})

test('regression: idle send has no background notification and replays before checking session busy', async (t) => {
  const notifications: TaskSummary[] = []
  const { engine, children } = await setup(t, {
    notify: (task) => {
      notifications.push(task)
    }
  })
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  await finish(engine, children[0])
  assert.deepEqual(
    notifications.map((task) => task.task_id),
    [first.task_id]
  )

  let activatedReturned = false
  const activated = engine
    .send(first.session_id, '  next synchronous turn  ', { requestId: 'send' })
    .then((result) => {
      activatedReturned = true
      return result
    })
  await waitFor(() => children[0].calls.length === 2)
  const inFlightReplay = engine.send(first.task_id, 'next synchronous turn', { requestId: 'send' })
  assert.equal(activatedReturned, false)
  const next = (await engine.query()).at(-1)!
  assert.notEqual(next.task_id, first.task_id)
  assert.equal(next.session_id, first.session_id)
  assert.equal(next.notify_completion, false)
  assert.equal(children[0].calls[1].text, 'next synchronous turn')
  await assert.rejects(engine.send(first.session_id, 'different send', { requestId: 'other' }), {
    code: 'local_session_busy',
    status: 409
  })
  children[0].calls[1].resolve({ text: 'synchronous answer' })
  const result = await activated
  assert.equal(result.task_id, next.task_id)
  assert.equal(result.mode, 'activated')
  assert.equal(result.accepted, true)
  assert.equal(result.final_text, 'synchronous answer')
  assert.equal((await inFlightReplay).mode, 'duplicate')
  assert.deepEqual(
    notifications.map((task) => task.task_id),
    [first.task_id]
  )
  assert.deepEqual(
    (await engine.pendingNotifications()).map((task) => task.task_id),
    [first.task_id]
  )

  const background = await engine.append(first.task_id, 'new background turn')
  await waitFor(() => children[0].calls.length === 3)
  const duplicate = await engine.send(first.session_id, 'next synchronous turn', {
    requestId: 'send'
  })
  assert.equal(duplicate.task_id, next.task_id)
  assert.equal(duplicate.mode, 'duplicate')
  assert.equal(children[0].calls.length, 3)
  assert.deepEqual(children[0].steers, [])
  assert.equal((await engine.query({ task_id: background.task_id })).status, 'running')
  assert.equal(engine.waiters.size, 0)
  await assert.rejects(engine.send('foreign-session', 'no'), {
    code: 'TASK_NOT_FOUND',
    status: 404,
    message: 'Local background task not found: foreign-session'
  })
})

test('regression: send rejects busy queued and running sessions without mutating or canceling background work', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  const first = await engine.start(input('first'), profile)
  const queued = await engine.start(input('queued'), profile)
  await waitFor(() => children[0]?.calls.length)
  const busy = { code: 'local_session_busy', status: 409 }
  const rejectedController = new AbortController()
  await assert.rejects(
    engine.send(first.task_id, 'no steer', { signal: rejectedController.signal }),
    busy
  )
  await assert.rejects(engine.send(queued.session_id, 'no merge', { requestId: 'retry' }), busy)
  rejectedController.abort()
  assert.equal(engine.task(queued.task_id).input.prompt, 'queued')
  assert.equal(engine.task(queued.task_id).notify_completion, true)
  assert.equal((await engine.query({ task_id: first.task_id })).status, 'running')
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'queued')
  assert.deepEqual(children[0].steers, [])
  await engine.stop(first.task_id)
  await waitFor(() => children[1]?.calls.length)
  assert.equal(children[1].calls[0].text, 'queued')
  await assert.rejects(engine.send(queued.task_id, 'still busy'), busy)
  await finish(engine, children[1])

  const controller = new AbortController()
  const continuation = engine.send(queued.session_id, 'cancel me', {
    requestId: 'retry',
    signal: controller.signal
  })
  await waitFor(() => children[1].calls.length === 2)
  const releaseAbort = deferred()
  children[1].abort = () => releaseAbort.promise
  controller.abort()
  children[1].calls[1].reject(new Error('interrupted'))
  const next = (await engine.query()).at(-1)!
  await waitFor(async () => (await engine.query({ task_id: next.task_id })).status === 'stopping')
  await assert.rejects(engine.send(queued.session_id, 'stopping is busy'), busy)
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'succeeded')
  releaseAbort.resolve()
  assert.equal((await continuation).status, 'canceled')
  assert.equal(
    (await engine.send(queued.task_id, 'cancel me', { requestId: 'retry' })).task_id,
    next.task_id
  )
  const before = children[1].calls.length
  await assert.rejects(
    engine.send(queued.session_id, 'not admitted', { signal: controller.signal }),
    { name: 'AbortError' }
  )
  assert.equal(children[1].calls.length, before)
})

test('regression: output wait cancellation removes listeners without canceling work or consuming bytes', async (t) => {
  const { engine, children } = await setup(t)
  const task = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const controller = new AbortController()
  const waiting = engine.output(task.task_id, { wait_ms: 30000, signal: controller.signal })
  await waitFor(() => engine.waiters.size === 1)
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(engine.waiters.size, 0)
  assert.equal((await engine.query({ task_id: task.task_id })).status, 'running')
  children[0].onOutput('not public streaming content')
  await assert.rejects(engine.output(task.task_id, { signal: controller.signal }), {
    name: 'AbortError'
  })
  assert.equal((await engine.output(task.task_id)).output, '')
  await finish(engine, children[0], 'available')
  assert.equal((await engine.output(task.task_id)).output, 'available')

  const originalWait = engine.waitUntil
  let timeout: number | undefined
  engine.waitUntil = async (_predicate, capped) => {
    timeout = capped
    return false
  }
  try {
    assert.equal(
      (await engine.output(task.task_id, { wait_ms: Number.MAX_SAFE_INTEGER })).output,
      ''
    )
    assert.equal(timeout, 30000)
  } finally {
    engine.waitUntil = originalWait
  }

  const barrier = holdNextPersistence(engine)
  const ack = engine.ackNotification(task.task_id)
  await barrier.entered
  const late = new AbortController()
  const blocked = engine.output(task.task_id, { offset: 0, signal: late.signal })
  late.abort()
  barrier.release()
  await ack
  await assert.rejects(blocked, { name: 'AbortError' })
  assert.equal(
    engine.task(task.task_id).cursor,
    0,
    'legacy persisted cursor is not the runtime read cursor'
  )
  assert.equal((await engine.output(task.task_id)).offset, 9)
})

test('regression: upstream failed stop returns canceled + TASK_STOP_FAILED while retaining admission until settlement', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t, { maxConcurrency: 1 })
  const first = await engine.start(input(), profile)
  const queued = await engine.start(input('successor'), profile)
  await waitFor(() => children[0]?.calls.length)
  children[0].abort = async () => {
    throw new Error('cannot stop child')
  }
  const stopped = await engine.stop(first.task_id)
  assert.equal(stopped.status, 'canceled')
  assert.deepEqual(stopped.stopError, { code: 'TASK_STOP_FAILED', message: 'cannot stop child' })
  assert.equal(stopped.error, 'cannot stop child')
  assert.equal(children.length, 1)
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'queued')
  assert.deepEqual((await engine.stop(first.task_id)).stopError, stopped.stopError)
  children[0].onOutput('uncommitted late stream after failed stop')
  assert.equal((await engine.output(first.task_id)).output, '')
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.deepEqual(saved.tasks[0].stopError, stopped.stopError)
  children[0].calls[0].resolve(terminalResult('succeeded', 'late output after failed stop'))
  await waitFor(() => children[1]?.calls.length)
  assert.equal((await engine.query({ task_id: first.task_id })).status, 'canceled')
  assert.equal((await engine.output(first.task_id)).output, 'late output after failed stop')
  await engine.stop(queued.task_id)
  await engine.close()
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const record = await restored.query({ task_id: first.task_id })
    assert.equal(record.status, 'canceled')
    assert.deepEqual(record.stopError, stopped.stopError)
  } finally {
    await restored.close()
  }
})

test('regression: failed admission cannot dispatch on a later start and retry requires reopening', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const fault = new Error('admission write failed')
  const save = engine.store.save.bind(engine.store)
  engine.store.save = async () => {
    throw fault
  }
  await assert.rejects(engine.start(input('A'), profile, { requestId: 'failed' }), fault)
  engine.store.save = save
  await assert.rejects(engine.start(input('B'), profile), fault)
  await assert.rejects(engine.start(input('A'), profile, { requestId: 'failed' }), fault)
  engine.pump()
  await tick()
  assert.equal(children.length, 0)
  assert.deepEqual(engine.state?.tasks, [])
  assert.deepEqual(engine.state?.requests, {})
  const persisted = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.deepEqual(persisted.tasks, [])
  assert.deepEqual(persisted.requests, {})
  await engine.close()
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const retry = await restored.start(input('A'), profile, { requestId: 'failed' })
    await waitFor(() => children[0]?.calls.length)
    assert.equal(children[0].calls[0].text, 'A')
    assert.equal(
      (await restored.start(input('A'), profile, { requestId: 'failed' })).task_id,
      retry.task_id
    )
    assert.equal(children.length, 1)
    await restored.stop(retry.task_id)
  } finally {
    await restored.close()
  }
})

test('regression: uncommitted admission is invisible to completion pump and ambiguous durable receipts restore lost', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t, { maxConcurrency: 1 })
  const blocker = await engine.start(input('blocker'), profile)
  await waitFor(() => children[0]?.calls.length)
  const save = engine.store.save.bind(engine.store)
  const entered = deferred()
  const release = deferred()
  const fault = new Error('admission result uncertain')
  let held = false
  engine.store.save = async (state) => {
    if (!held) {
      held = true
      entered.resolve()
      await release.promise
      throw fault
    }
    return save(state)
  }
  const admission = engine.start(input('must not dispatch'), profile, { requestId: 'uncertain' })
  const rejected = assert.rejects(admission, fault)
  await entered.promise
  const candidate = engine.state!.tasks.at(-1)!
  try {
    children[0].calls[0].resolve({ text: 'blocker done' })
    await waitFor(
      async () =>
        (await engine.query({ task_id: blocker.task_id })).status === 'succeeded' &&
        !engine.runtimes.has(blocker.task_id)
    )
    assert.equal(
      children.length,
      1,
      'completion pump cannot dispatch an admission awaiting persistence'
    )
    const persisted = JSON.parse(await readFile(engine.store.file, 'utf8'))
    assert.equal(persisted.requests['start:uncertain'], candidate.task_id)
    assert.equal(persisted.tasks.at(-1).status, 'queued')
  } finally {
    release.resolve()
    await rejected
  }
  engine.store.save = save
  assert.equal(
    engine.state!.tasks.some((task) => task.task_id === candidate.task_id),
    false
  )
  assert.equal(engine.state!.requests['start:uncertain'], undefined)
  await assert.rejects(engine.start(input('later'), profile), fault)
  engine.pump()
  assert.equal(children.length, 1)
  await engine.close()
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const replay = await restored.start(input('must not dispatch'), profile, {
      requestId: 'uncertain'
    })
    assert.equal(replay.task_id, candidate.task_id)
    assert.equal(replay.status, 'lost')
    assert.equal(children.length, 1, 'uncertain durable admission never restarts automatically')
    const recovery = await restored.append(replay.task_id, 'explicit recovery')
    await waitFor(() => children[1]?.calls.length)
    assert.equal(children[1].calls[0].text, 'explicit recovery')
    await restored.stop(recovery.task_id)
  } finally {
    await restored.close()
  }
})

test('regression: durable send replay returns its original terminal result even while a later background turn runs', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  await finish(engine, children[0])
  const sending = engine.send(first.task_id, 'durable synchronous reply', {
    requestId: 'send-reload'
  })
  await waitFor(() => children[0].calls.length === 2)
  children[0].calls[1].resolve({ text: 'saved reply' })
  const original = await sending
  await engine.close()
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const later = await restored.append(first.task_id, 'later background work')
    await waitFor(() => children[1]?.calls.length)
    const replay = await restored.send(first.session_id, 'durable synchronous reply', {
      requestId: 'send-reload'
    })
    assert.equal(replay.task_id, original.task_id)
    assert.equal(replay.final_text, 'saved reply')
    assert.equal(replay.mode, 'duplicate')
    assert.equal(replay.notify_completion, false)
    assert.equal(children[1].calls.length, 1)
    assert.deepEqual(children[1].steers, [])
    assert.deepEqual(
      (await restored.pendingNotifications()).map((task) => task.task_id),
      [first.task_id]
    )
    assert.equal((await restored.query({ task_id: later.task_id })).status, 'running')
    await restored.stop(later.task_id)
  } finally {
    await restored.close()
  }
})

test('regression: real engine accepts empty and whitespace prompts verbatim in foreground and background', async (t) => {
  const { engine, children } = await setup(t)
  const foreground = engine.start({ ...input(''), run_in_background: false }, profile)
  await waitFor(() => children[0]?.calls.length)
  assert.equal(children[0].calls[0].text, '')
  children[0].calls[0].resolve({ text: 'empty accepted' })
  assert.equal((await foreground).status, 'succeeded')
  const background = await engine.start(input(' \n\t '), profile)
  await waitFor(() => children[1]?.calls.length)
  assert.equal(children[1].calls[0].text, ' \n\t ')
  await engine.stop(background.task_id)
})

test('regression: resolved profile snapshot must be durable before prompt and never drifts across continuation or reload', async (t) => {
  /* oxlint-disable no-await-in-loop -- Subtests share SDK mocks and process state; finish each case before the next. */
  for (const initialSkills of [[], ['initial-skill']]) {
    await t.test(
      initialSkills.length ? 'named inherited skills' : 'empty inherited skills',
      async (t) => {
        const { engine, children, rootDir, createChild } = await setup(t)
        const save = engine.store.save.bind(engine.store)
        const entered = deferred()
        const release = deferred()
        let held = false
        engine.store.save = async (state) => {
          if (!held && state.tasks.some((task) => task.profile.skills !== undefined)) {
            held = true
            entered.resolve()
            await release.promise
          }
          return save(state)
        }
        let availableSkills = [...initialSkills]
        const factoryProfiles: AgentProfile[] = []
        const resolvedProfiles: AgentProfile[] = []
        const factory = async (args: CreateChildOptions): Promise<MockChild> => {
          factoryProfiles.push(args.profile)
          const skills = [...(args.profile.skillSnapshot ?? args.profile.skills ?? availableSkills)]
          const resolved = { ...args.profile, skills, skillSnapshot: skills }
          resolvedProfiles.push(resolved)
          assert.ok(args.onProfileResolved)
          await args.onProfileResolved(resolved)
          const persisted = JSON.parse(await readFile(engine.store.file, 'utf8'))
          assert.deepEqual(persisted.tasks.at(-1).profile.skills, resolved.skills)
          return createChild({ ...args, profile: resolved })
        }
        engine.createChild = factory
        const first = await engine.start(
          input(),
          { ...profile, skills: undefined },
          { requestId: 'snapshot-start' }
        )
        await entered.promise
        try {
          assert.equal(children.length, 0, 'prompt cannot run before profile snapshot persistence')
          const pending = JSON.parse(await readFile(engine.store.file, 'utf8'))
          assert.equal(pending.tasks[0].profile.skills, undefined)
        } finally {
          release.resolve()
        }
        await waitFor(() => children[0]?.calls.length)
        assert.deepEqual(engine.task(first.task_id).profile.skills, initialSkills)
        assert.ok(Object.isFrozen(engine.task(first.task_id).profile))
        assert.ok(Object.isFrozen(engine.task(first.task_id).profile.skills))
        ;(resolvedProfiles[0].skills as string[]).push('mutation-after-callback')
        assert.deepEqual(engine.task(first.task_id).profile.skills, initialSkills)
        await finish(engine, children[0])

        availableSkills = [...initialSkills, 'newly-installed-skill']
        const continuation = await engine.append(first.task_id, 'same session')
        await waitFor(() => children[0].calls.length === 2)
        assert.equal(
          factoryProfiles.length,
          1,
          'live session is reused without resolving inheritance again'
        )
        assert.deepEqual(engine.task(continuation.task_id).profile.skills, initialSkills)
        await finish(engine, children[0])
        await engine.close()

        const restored = new TaskEngine({
          rootDir,
          parentId: 'parent',
          cwd: rootDir,
          createChild: factory
        })
        await restored.init()
        try {
          assert.deepEqual(restored.task(continuation.task_id).profile.skills, initialSkills)
          const resumed = await restored.append(first.task_id, 'reload same session')
          await waitFor(() => children[1]?.calls.length)
          assert.equal(resumed.session_id, first.session_id)
          assert.equal(children[1].sessionPath, first.childSessionPath)
          assert.deepEqual(factoryProfiles[1].skills, initialSkills)
          assert.deepEqual(restored.task(resumed.task_id).profile.skills, initialSkills)
          assert.equal(
            restored.task(resumed.task_id).profile.skills?.includes('newly-installed-skill'),
            false
          )
          assert.equal(
            (await restored.start(input(), profile, { requestId: 'snapshot-start' })).task_id,
            first.task_id
          )
          await restored.stop(resumed.task_id)
        } finally {
          await restored.close()
        }
      }
    )
  }
  /* oxlint-enable no-await-in-loop */
})

test('regression: profile snapshot persistence failure never prompts and seals the owner without losing request receipts', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t, { maxConcurrency: 1 })
  const readyToResolve = deferred()
  const save = engine.store.save.bind(engine.store)
  const fault = new Error('resolved profile snapshot write failed')
  let failSnapshot = true
  let factoryCalls = 0
  engine.store.save = async (state) => {
    if (
      failSnapshot &&
      state.tasks.some((task) => task.profile.skills?.includes('resolved-skill'))
    ) {
      failSnapshot = false
      throw fault
    }
    return save(state)
  }
  engine.createChild = async (args) => {
    factoryCalls++
    await readyToResolve.promise
    assert.ok(args.onProfileResolved)
    await args.onProfileResolved({
      ...args.profile,
      skills: ['resolved-skill'],
      skillSnapshot: ['resolved-skill']
    })
    return createChild(args)
  }
  const first = await engine.start(
    input(),
    { ...profile, skills: undefined },
    { requestId: 'snapshot-failure' }
  )
  const queued = await engine.start(input('queued task'), profile, {
    requestId: 'queued-after-snapshot'
  })
  assert.equal(queued.status, 'queued')
  readyToResolve.resolve()
  await waitFor(() => !engine.runtimes.has(first.task_id))
  assert.equal(engine.task(first.task_id).status, 'failed')
  assert.equal(engine.task(first.task_id).error, fault.message)
  assert.equal(engine.task(queued.task_id).status, 'queued')
  assert.equal(children.length, 0)
  assert.equal(factoryCalls, 1)
  await assert.rejects(engine.start(input(), profile, { requestId: 'snapshot-failure' }), fault)
  await assert.rejects(engine.append(first.task_id, 'must not retry on poisoned owner'), fault)
  engine.pump()
  assert.equal(factoryCalls, 1)
  const persisted = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(persisted.requests['start:snapshot-failure'], first.task_id)
  assert.equal(persisted.requests['start:queued-after-snapshot'], queued.task_id)
  assert.deepEqual(persisted.tasks[0].profile.skills, ['resolved-skill'])
  await engine.close()

  let recoveredProfile: AgentProfile | undefined
  const restored = new TaskEngine({
    rootDir,
    parentId: 'parent',
    cwd: rootDir,
    createChild: async (args) => {
      recoveredProfile = args.profile
      await args.onProfileResolved?.(args.profile)
      return createChild(args)
    }
  })
  await restored.init()
  try {
    const duplicate = await restored.start(input(), profile, { requestId: 'snapshot-failure' })
    assert.equal(duplicate.task_id, first.task_id)
    assert.equal(duplicate.status, 'failed')
    assert.equal(children.length, 0)
    const recovery = await restored.append(first.task_id, 'explicit retry')
    await waitFor(() => children[0]?.calls.length)
    assert.deepEqual(recoveredProfile?.skills, ['resolved-skill'])
    await restored.stop(recovery.task_id)
  } finally {
    await restored.close()
  }
})

test(
  'regression: foreground snapshot failure still settles when terminal persistence also fails',
  { timeout: 2000 },
  async (t) => {
    const { engine, children, createChild } = await setup(t)
    const save = engine.store.save.bind(engine.store)
    const fault = new Error('persistent profile snapshot storage failure')
    engine.store.save = async (state) => {
      if (state.tasks.some((task) => task.profile.skills?.includes('resolved-skill'))) {
        throw fault
      }
      return save(state)
    }
    engine.createChild = async (args) => {
      await args.onProfileResolved?.({
        ...args.profile,
        skills: ['resolved-skill'],
        skillSnapshot: ['resolved-skill']
      })
      return createChild(args)
    }
    await assert.rejects(
      engine.start({ ...input(), run_in_background: false }, { ...profile, skills: undefined }),
      (error) => error === fault
    )
    assert.equal(engine.state!.tasks[0].status, 'failed')
    assert.equal(engine.state!.tasks[0].error, fault.message)
    assert.equal(children.length, 0)
    assert.equal(engine.waiters.size, 0)
    await assert.rejects(engine.start(input(), profile), fault)
    try {
      await assert.rejects(engine.close(), fault)
    } finally {
      engine.store.save = save
    }
    await engine.close()
  }
)

test('regression: restore rejects malformed skillSnapshot bounds and preserves valid snapshots', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start(input(), { ...profile, skillSnapshot: ['allowed-skill'] })
  await waitFor(() => children[0]?.calls.length)
  await finish(engine, children[0])
  await engine.close()
  const saved = await readFile(engine.store.file, 'utf8')
  /* oxlint-disable no-await-in-loop -- Cases reuse one task store; finish validation and cleanup before overwriting it. */
  for (const skillSnapshot of [
    null,
    'allowed-skill',
    {},
    1,
    [1],
    ['allowed-skill', null],
    ['allowed-skill', {}]
  ]) {
    const invalid = JSON.parse(saved)
    invalid.tasks[0].profile.skillSnapshot = skillSnapshot
    await writeFile(engine.store.file, JSON.stringify(invalid))
    const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
    try {
      await assert.rejects(restored.init(), /Invalid task store state/)
      assert.equal(children.length, 1, 'invalid resource bounds must fail before child creation')
    } finally {
      await restored.close()
    }
  }
  /* oxlint-enable no-await-in-loop */
  /* oxlint-disable no-await-in-loop -- Cases reuse one task store; finish validation and cleanup before overwriting it. */
  for (const skillSnapshot of [undefined, [], ['allowed-skill']]) {
    const valid = JSON.parse(saved)
    valid.tasks[0].profile.skillSnapshot = skillSnapshot
    await writeFile(engine.store.file, JSON.stringify(valid))
    const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
    await restored.init()
    try {
      assert.deepEqual(restored.task(first.task_id).profile.skillSnapshot, skillSnapshot)
      assert.equal(children.length, 1)
    } finally {
      await restored.close()
    }
  }
  /* oxlint-enable no-await-in-loop */
})

test('regression: cleanup failure retains the slot and quarantines dispatch without hiding query or output', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t, { maxConcurrency: 1 })
  const first = await engine.start(input('A'), profile, { requestId: 'cleanup-A' })
  const queued = await engine.start(input('B'), profile, { requestId: 'cleanup-B' })
  await waitFor(() => children[0]?.calls.length)
  children[0].onOutput('cleanup evidence')
  const failure = Object.assign(new Error('descendants are still alive'), {
    code: 'CHILD_CLEANUP_FAILED'
  })
  let disposalAttempts = 0
  let cleanupSucceeds = false
  children[0].dispose = async () => {
    disposalAttempts++
    if (!cleanupSucceeds) {
      throw failure
    }
    children[0].disposed = true
  }
  const runtime = engine.runtimes.get(first.task_id)!
  children[0].calls[0].reject(failure)
  await runtime.done
  assert.equal(
    engine.runtimes.get(first.task_id),
    runtime,
    'model settlement is not descendant cleanup'
  )
  assert.equal(engine.runtimes.size, 1)
  assert.equal(children.length, 1)
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'queued')
  const failed = await engine.query({ task_id: first.task_id })
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.stopError, { code: 'CHILD_CLEANUP_FAILED', message: failure.message })
  assert.equal(
    (await engine.output(first.task_id, { offset: 0 })).output,
    'Background task failed: descendants are still alive'
  )
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const operation of [
    () => engine.start(input('C'), profile),
    () => engine.append(queued.task_id, 'must not merge'),
    () => engine.send(first.session_id, 'must not dispatch')
  ]) {
    await assert.rejects(operation(), { code: 'CHILD_CLEANUP_FAILED' })
  }
  /* oxlint-enable no-await-in-loop */
  engine.pump()
  assert.equal(children.length, 1)
  assert.equal(engine.task(queued.task_id).input.prompt, 'B')
  assert.equal(
    (await engine.stop(first.task_id)).status,
    'failed',
    'stop cannot claim the live descendants were canceled'
  )

  await assert.rejects(engine.close(), { code: 'CHILD_CLEANUP_FAILED' })
  assert.equal(disposalAttempts, 1)
  assert.equal(engine.runtimes.get(first.task_id), runtime)
  assert.equal((await engine.query({ task_id: first.task_id })).status, 'failed')
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'canceled')
  assert.equal(
    (await engine.output(first.task_id, { offset: 0 })).output,
    'Background task failed: descendants are still alive'
  )
  const competitor = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await assert.rejects(competitor.init(), /active task owner/)
  cleanupSucceeds = true
  await engine.close()
  assert.equal(disposalAttempts, 2)
  assert.equal(engine.runtimes.size, 0)
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(saved.tasks[0].status, 'failed')
  assert.deepEqual(saved.tasks[0].stopError, failed.stopError)
  assert.deepEqual(saved.cleanupConfirmed, [first.task_id])
  assert.equal(saved.requests['start:cleanup-A'], first.task_id)
  assert.equal(saved.requests['start:cleanup-B'], queued.task_id)
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const next = await restored.start(input('safe after proven cleanup'), profile)
    await waitFor(() => children[1]?.calls.length)
    await restored.stop(next.task_id)
  } finally {
    await restored.close()
  }
})

test('regression: cleanup quarantine preserves upstream canceled + stopError without releasing live capacity', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  const first = await engine.start(input(), profile)
  const queued = await engine.start(input('queued'), profile)
  await waitFor(() => children[0]?.calls.length)
  const failure = Object.assign(new Error('abort left descendants alive'), {
    code: 'CHILD_CLEANUP_FAILED'
  })
  children[0].abort = async () => {
    children[0].calls[0].reject(failure)
    throw failure
  }
  const stopping = engine.stop(first.task_id)
  await engine.runtimes.get(first.task_id)!.done
  assert.equal((await stopping).stopError?.code, 'TASK_STOP_FAILED')
  assert.equal((await engine.query({ task_id: first.task_id })).status, 'canceled')
  assert.equal(engine.task(first.task_id).stopError?.code, 'CHILD_CLEANUP_FAILED')
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'queued')
  assert.equal(engine.runtimes.size, 1)
  assert.equal(children.length, 1)
  await engine.close()
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(saved.tasks[0].status, 'canceled')
  assert.equal(saved.tasks[0].stopError.code, 'CHILD_CLEANUP_FAILED')
  assert.deepEqual(saved.cleanupConfirmed, [first.task_id])
})

test('regression: a new owner preserves unresolved cleanup quarantine instead of restarting orphaned work', async (t) => {
  const { engine, rootDir, children, createChild } = await setup(t)
  await engine.close()
  const script = `
    import { TaskEngine } from ${JSON.stringify(new URL('../src/engine.ts', import.meta.url).href)};
    const engine = new TaskEngine({ rootDir: process.argv[1], parentId: 'parent', cwd: process.argv[1],
      createChild: async (args) => ({ sessionPath: args.sessionPath,
        prompt: async () => { args.onOutput?.('orphan evidence');
          throw Object.assign(new Error('unverified descendants'), { code: 'CHILD_CLEANUP_FAILED' }); },
        abort: async () => {}, dispose: async () => {} }) });
    await engine.init();
    const task = await engine.start({ description: 'crash', prompt: 'A', run_in_background: true },
      ${JSON.stringify(profile)}, { requestId: 'orphan' });
    await engine.runtimes.get(task.task_id).done;
  `
  const exited = spawnSync(process.execPath, ['--input-type=module', '-e', script, rootDir], {
    encoding: 'utf8'
  })
  assert.equal(exited.status, 0, exited.stderr)
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const [orphan] = await restored.query()
    assert.equal(orphan.status, 'failed')
    assert.equal(orphan.stopError?.code, 'CHILD_CLEANUP_FAILED')
    assert.equal(
      (await restored.output(orphan.task_id, { offset: 0 })).output,
      'Background task failed: unverified descendants'
    )
    assert.equal(
      (await restored.start(input(), profile, { requestId: 'orphan' })).task_id,
      orphan.task_id
    )
    await assert.rejects(restored.start(input('new'), profile), { code: 'CHILD_CLEANUP_FAILED' })
    await assert.rejects(restored.append(orphan.task_id, 'retry'), { code: 'CHILD_CLEANUP_FAILED' })
    await assert.rejects(restored.send(orphan.session_id, 'retry'), {
      code: 'CHILD_CLEANUP_FAILED'
    })
    assert.equal(children.length, 0)
    await assert.rejects(restored.close(), { code: 'CHILD_CLEANUP_FAILED' })
    assert.equal(
      (await restored.query({ task_id: orphan.task_id })).stopError?.code,
      'CHILD_CLEANUP_FAILED'
    )
  } finally {
    // This fixture has no real descendants or live cleanup handle. Release only its test-store lock.
    await restored.store.close()
  }
})

test('regression: restored legacy selectors with an unknown historical bound reject continuation before child creation', async (t) => {
  /* oxlint-disable no-await-in-loop -- Subtests share SDK mocks and process state; finish each case before the next. */
  for (const skills of [undefined, ['/trusted/legacy-skills'], ['old-skill-name']]) {
    await t.test(skills?.[0] ?? 'inherited skills', async (t) => {
      const { engine, children, rootDir, createChild } = await setup(t)
      const first = await engine.start(
        input('legacy task'),
        { ...profile, skills },
        { requestId: 'legacy' }
      )
      await waitFor(() => children[0]?.calls.length)
      await finish(engine, children[0], 'historical output')
      await engine.close()
      let factoryCalls = 0
      const restored = new TaskEngine({
        rootDir,
        parentId: 'parent',
        cwd: rootDir,
        createChild: async (args) => {
          factoryCalls++
          // A directory or inherited selector could now discover a newly installed Skill, without a callback.
          return createChild({
            ...args,
            profile: { ...args.profile, skills: ['old-skill-name', 'new-skill'] }
          })
        }
      })
      await restored.init()
      try {
        const legacy = { code: 'LEGACY_RESOURCE_SNAPSHOT_REQUIRED' }
        await assert.rejects(
          restored.append(first.task_id, 'resume', { requestId: 'blocked' }),
          legacy
        )
        await assert.rejects(
          restored.send(first.session_id, 'resume', { requestId: 'blocked' }),
          legacy
        )
        assert.equal(factoryCalls, 0)
        assert.equal(children.length, 1)
        assert.equal((await restored.query()).length, 1)
        assert.equal(
          (await restored.output(first.task_id, { offset: 0 })).output,
          'historical output'
        )
        assert.equal(
          (await restored.start(input(), profile, { requestId: 'legacy' })).task_id,
          first.task_id
        )
        assert.equal(restored.task(first.task_id).profile.skillSnapshot, undefined)
        assert.equal(restored.state!.requests[`append:${first.task_id}:blocked`], undefined)
        assert.equal(restored.state!.requests[`send:${first.session_id}:blocked`], undefined)
        const independent = await restored.start(input('fresh task is allowed'), {
          ...profile,
          skills: undefined
        })
        await waitFor(() => children[1]?.calls.length)
        assert.equal(factoryCalls, 1)
        await restored.stop(independent.task_id)
      } finally {
        await restored.close()
      }
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('regression: an explicit legacy empty selector safely bootstraps a durable empty bound without a backend callback', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start(input(), { ...profile, skills: [] })
  await waitFor(() => children[0]?.calls.length)
  await finish(engine, children[0])
  await engine.close()
  let factoryCalls = 0
  const factory = async (args: CreateChildOptions): Promise<MockChild> => {
    factoryCalls++
    assert.deepEqual(args.profile.skills, [])
    assert.deepEqual(args.profile.skillSnapshot, [])
    const durable = JSON.parse(await readFile(engine.store.file, 'utf8'))
    assert.deepEqual(durable.tasks.at(-1).profile.skillSnapshot, [])
    return createChild(args)
  }
  const restored = new TaskEngine({
    rootDir,
    parentId: 'parent',
    cwd: rootDir,
    createChild: factory
  })
  await restored.init()
  try {
    const resumed = await restored.append(first.task_id, 'safe empty continuation')
    await waitFor(() => children[1]?.calls.length)
    assert.deepEqual(restored.task(first.task_id).profile.skillSnapshot, [])
    assert.deepEqual(restored.task(resumed.task_id).profile.skillSnapshot, [])
    await finish(restored, children[1])
  } finally {
    await restored.close()
  }
  const reloaded = new TaskEngine({
    rootDir,
    parentId: 'parent',
    cwd: rootDir,
    createChild: factory
  })
  await reloaded.init()
  try {
    const sending = reloaded.send(first.session_id, 'empty bound still applies')
    await waitFor(() => children[2]?.calls.length)
    children[2].calls[0].resolve({ text: 'safe' })
    assert.equal((await sending).status, 'succeeded')
    assert.equal(factoryCalls, 2)
  } finally {
    await reloaded.close()
  }
})

test('regression: internal cleanup confirmation rejects malformed or unrelated proof without changing public failure facts', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const failure = Object.assign(new Error('descendant cleanup failed'), {
    code: 'CHILD_CLEANUP_FAILED'
  })
  children[0].calls[0].reject(failure)
  await engine.runtimes.get(first.task_id)!.done
  const before = await engine.query({ task_id: first.task_id })
  await engine.close()
  const saved = await readFile(engine.store.file, 'utf8')
  /* oxlint-disable no-await-in-loop -- Cases reuse one task store; finish validation and cleanup before overwriting it. */
  for (const cleanupConfirmed of [
    null,
    {},
    first.task_id,
    [1],
    ['unknown-task'],
    [first.task_id, first.task_id]
  ]) {
    const invalid = JSON.parse(saved)
    invalid.cleanupConfirmed = cleanupConfirmed
    await writeFile(engine.store.file, JSON.stringify(invalid))
    const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
    try {
      await assert.rejects(restored.init(), /Invalid task store state/)
    } finally {
      await restored.close()
    }
  }
  /* oxlint-enable no-await-in-loop */
  await writeFile(engine.store.file, saved)
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const { cleanup_pending, ...historicalFailure } = before
    assert.equal(cleanup_pending, true)
    const current = await restored.query({ task_id: first.task_id })
    assert.deepEqual(current, historicalFailure)
    assert.equal(current.cleanup_pending, undefined)
    assert.equal('cleanupConfirmed' in (await restored.query({ task_id: first.task_id })), false)
    const next = await restored.start(input('confirmed clean owner'), profile)
    await waitFor(() => children[1]?.calls.length)
    await restored.stop(next.task_id)
  } finally {
    await restored.close()
  }
})

test('default concurrency runs four tasks per owner and queues the fifth until capacity is released', async (t) => {
  const { engine, children } = await setup(t)
  const tasks = await Promise.all(
    Array.from({ length: 5 }, (_, index) => engine.start(input(`independent ${index}`), profile))
  )
  await waitFor(() => children.length === 4 && children.every((child) => child.calls.length === 1))
  assert.equal(engine.maxConcurrency, 4)
  assert.equal(engine.runtimes.size, 4)
  assert.equal(new Set(tasks.map((task) => task.session_id)).size, 5)
  assert.deepEqual(
    (await engine.query()).map((task) => task.status),
    ['running', 'running', 'running', 'running', 'queued']
  )
  const queued = tasks[4]
  assert.equal(queued.status, 'queued')
  assert.equal(
    children.some((child) => child.sessionPath === queued.childSessionPath),
    false
  )

  const other = await setup(t, { parentId: 'another-owner' })
  await other.engine.start(input('independent owner capacity'), profile)
  await waitFor(() => other.children[0]?.calls.length === 1)
  assert.equal(engine.runtimes.size, 4)
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'queued')

  const saved = await readFile(engine.store.file, 'utf8')
  assert.doesNotMatch(saved, /maxConcurrency|Infinity/)
  assert.equal(JSON.parse(saved).tasks.length, 5)
  await finish(engine, children[0])
  await waitFor(() => children[4]?.calls.length === 1)
  assert.equal(children.length, 5)
  assert.equal(engine.runtimes.size, 4)
  assert.equal(children[4].sessionPath, queued.childSessionPath)
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'running')
})

test('maximum concurrency runs ten tasks, queues the eleventh, cancels queued work and fills a freed slot', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 10 })
  const tasks = await Promise.all(
    Array.from({ length: 12 }, (_, index) => engine.start(input(`maximum ${index}`), profile))
  )
  await waitFor(() => children.length === 10 && children.every((child) => child.calls.length === 1))
  assert.equal(engine.maxConcurrency, 10)
  assert.equal(engine.runtimes.size, 10)
  assert.deepEqual(
    (await engine.query()).map((task) => task.status),
    [...Array.from({ length: 10 }, () => 'running'), 'queued', 'queued']
  )
  const queued = tasks[10]
  const canceled = tasks[11]
  assert.equal(queued.status, 'queued')
  assert.equal((await engine.stop(canceled.task_id)).status, 'canceled')
  assert.equal(children.length, 10)
  assert.equal(engine.runtimes.size, 10)
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'queued')

  await finish(engine, children[0])
  await waitFor(() => children[10]?.calls.length === 1)
  assert.equal(children.length, 11)
  assert.equal(engine.runtimes.size, 10)
  assert.equal(children[10].sessionPath, queued.childSessionPath)
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'running')
  assert.equal((await engine.query({ task_id: canceled.task_id })).status, 'canceled')
  assert.equal(
    children.some((child) => child.sessionPath === canceled.childSessionPath),
    false
  )
})

test('maximum concurrency retains a stopping task slot until cleanup settles', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 10 })
  const tasks = await Promise.all(
    Array.from({ length: 11 }, (_, index) => engine.start(input(`cleanup ${index}`), profile))
  )
  await waitFor(() => children.length === 10 && children.every((child) => child.calls.length === 1))
  const first = tasks[0]
  const queued = tasks[10]
  const runtime = engine.runtimes.get(first.task_id)
  const releaseAbort = deferred()
  children[0].abort = () => releaseAbort.promise
  const stopping = engine.stop(first.task_id)
  try {
    await waitFor(
      async () => (await engine.query({ task_id: first.task_id })).status === 'stopping'
    )
    settleResult(children[0].calls[0], 'aborted', '', 'Interrupted')
    await tick()
    engine.pump()
    assert.equal(engine.runtimes.get(first.task_id), runtime)
    assert.equal(engine.runtimes.size, 10)
    assert.equal(children.length, 10)
    assert.equal((await engine.query({ task_id: queued.task_id })).status, 'queued')
  } finally {
    releaseAbort.resolve()
    await stopping
  }
  await waitFor(() => children[10]?.calls.length === 1)
  assert.equal((await engine.query({ task_id: first.task_id })).status, 'canceled')
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'running')
  assert.equal(children[10].sessionPath, queued.childSessionPath)
  assert.equal(engine.runtimes.has(first.task_id), false)
  assert.equal(engine.runtimes.size, 10)
})

test('direct engine concurrency accepts 1 and 10 and rejects invalid or unsafe values', async (t) => {
  const { engine, rootDir, createChild } = await setup(t, { maxConcurrency: 1 })
  assert.equal(engine.maxConcurrency, 1)
  for (const value of [
    0,
    -1,
    1.5,
    11,
    64,
    65,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Infinity,
    -Infinity,
    '4',
    null,
    true
  ]) {
    assert.throws(
      () =>
        new TaskEngine({
          rootDir,
          parentId: 'invalid',
          cwd: rootDir,
          createChild,
          maxConcurrency: value as number
        }),
      /Invalid maxConcurrency: expected an integer from 1 to 10/
    )
  }
  const explicit = new TaskEngine({
    rootDir,
    parentId: 'host-policy',
    cwd: rootDir,
    createChild,
    maxConcurrency: 10
  })
  assert.equal(explicit.maxConcurrency, 10)
  await explicit.close()
})

test('regression: default capacity does not bypass cleanup quarantine or release its retained runtime', async (t) => {
  const { engine, children } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const runtime = engine.runtimes.get(first.task_id)!
  children[0].calls[0].reject(
    Object.assign(new Error('unproven descendant cleanup'), { code: 'CHILD_CLEANUP_FAILED' })
  )
  await runtime.done
  assert.equal(engine.maxConcurrency, 4)
  assert.equal(engine.runtimes.get(first.task_id), runtime)
  await assert.rejects(engine.start(input('another session'), profile), {
    code: 'CHILD_CLEANUP_FAILED'
  })
  await assert.rejects(engine.append(first.task_id, 'follow-up'), { code: 'CHILD_CLEANUP_FAILED' })
  await assert.rejects(engine.send(first.session_id, 'follow-up'), { code: 'CHILD_CLEANUP_FAILED' })
  engine.pump()
  assert.equal(children.length, 1)
  assert.equal((await engine.query({ task_id: first.task_id })).status, 'failed')
  await engine.close()
})

test('regression: store restores raw effort labels without treating Pi enums as provider validation', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start({ ...input(), effort: 'on' }, profile)
  await waitFor(() => children[0]?.calls.length)
  assert.equal(children[0].profile.effort, 'on')
  assert.equal(children[0].profile.thinking, undefined)
  await finish(engine, children[0])
  await engine.close()
  const saved = await readFile(engine.store.file, 'utf8')
  /* oxlint-disable no-await-in-loop -- Cases reuse one task store; finish validation and cleanup before overwriting it. */
  for (const label of ['on', 'off', 'provider-specific-effort']) {
    const valid = JSON.parse(saved)
    valid.tasks[0].profile.thinking = label
    valid.tasks[0].profile.effort = label
    valid.tasks[0].input.effort = label
    await writeFile(engine.store.file, JSON.stringify(valid))
    const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
    await restored.init()
    try {
      assert.equal(restored.task(first.task_id).profile.thinking, label)
      assert.equal(restored.task(first.task_id).profile.effort, label)
      assert.equal(restored.task(first.task_id).input.effort, label)
      assert.equal(
        children.length,
        1,
        'store validation does not call a provider or validate model compatibility'
      )
    } finally {
      await restored.close()
    }
  }
  /* oxlint-enable no-await-in-loop */
  /* oxlint-disable no-await-in-loop -- Cases reuse one task store; finish validation and cleanup before overwriting it. */
  for (const [record, field] of [
    ['profile', 'thinking'],
    ['profile', 'effort'],
    ['input', 'effort']
  ]) {
    for (const label of ['', ' \t\n', null, 1, ['on'], {}]) {
      const invalid = JSON.parse(saved)
      invalid.tasks[0][record][field] = label
      await writeFile(engine.store.file, JSON.stringify(invalid))
      const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
      try {
        await assert.rejects(restored.init(), /Invalid task store state/)
      } finally {
        await restored.close()
      }
    }
  }
  /* oxlint-enable no-await-in-loop */
  await writeFile(engine.store.file, saved)
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const resumed = await restored.append(first.task_id, 'raw effort continuation')
    await waitFor(() => children[1]?.calls.length)
    assert.equal(children[1].profile.effort, 'on')
    assert.equal(children[1].profile.thinking, undefined)
    await restored.stop(resumed.task_id)
  } finally {
    await restored.close()
  }
})

test('regression: process restart resets automatic cursors while a same-process owner/module reload retains them', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  await finish(engine, children[0], 'abcdef')
  assert.equal((await engine.output(first.task_id, { limitBytes: 2 })).output, 'ab')
  assert.equal((await engine.output(first.task_id, { offset: 0, limitBytes: 1 })).output, 'a')
  engine.task(first.task_id).cursor = 5
  await engine.persist()
  await engine.close()
  const script = `
    import { TaskEngine } from ${JSON.stringify(new URL('../src/engine.ts', import.meta.url).href)};
    const engine = new TaskEngine({ rootDir: process.argv[1], parentId: 'parent', cwd: process.argv[1],
      createChild: async () => { throw new Error('Terminal output must not create a child'); } });
    await engine.init();
    const output = await engine.output(process.argv[2], { limitBytes: 3 });
    process.stdout.write(JSON.stringify({ output, notifications: (await engine.pendingNotifications()).length }));
    await engine.close();
  `
  const processRead = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, rootDir, first.task_id],
    { encoding: 'utf8' }
  )
  assert.equal(processRead.status, 0, processRead.stderr)
  const restarted = JSON.parse(processRead.stdout)
  assert.equal(restarted.output.output, 'abc')
  assert.equal(restarted.output.offset, 0)
  assert.equal(restarted.output.next_offset, 3)
  assert.equal(restarted.notifications, 1)
  assert.equal(JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0].cursor, 5)

  const reloadedModule = await import(`../src/engine.ts?output-reload=${first.task_id}`)
  const restored: TaskEngine = new reloadedModule.TaskEngine({
    rootDir,
    parentId: 'parent',
    cwd: rootDir,
    createChild
  })
  await restored.init()
  try {
    const continued = await restored.output(first.task_id)
    assert.equal(continued.output, 'cdef')
    assert.equal(continued.offset, 2, 'the other process read must not mutate this process cursor')
    assert.equal(
      restored.task(first.task_id).cursor,
      5,
      'legacy disk cursor is retained but not used'
    )
    assert.equal(
      (await restored.pendingNotifications()).length,
      1,
      'output does not acknowledge completion delivery'
    )
  } finally {
    await restored.close()
  }
})

test('regression: queued-to-running status changes do not finish a positive output wait', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  await engine.start(input('blocker'), profile)
  const queued = await engine.start(input('queued'), profile)
  await waitFor(() => children[0]?.calls.length)
  let returned = false
  const waiting = engine
    .output(queued.task_id, { wait_ms: 30000, limitBytes: 3 })
    .then((output) => {
      returned = true
      return output
    })
  await waitFor(() => engine.waiters.size === 1)
  await finish(engine, children[0])
  await waitFor(() => children[1]?.calls.length)
  await tick()
  assert.equal(returned, false)
  assert.equal(engine.waiters.size, 1)
  children[1].onOutput('B data is not yet committed')
  await tick()
  assert.equal(returned, false)
  assert.equal(engine.task(queued.task_id).output, '')
  children[1].calls[0].resolve(terminalResult('succeeded', 'B data'))
  const output = await waiting
  assert.equal(output.status, 'succeeded')
  assert.equal(output.output, 'B d')
  assert.equal(output.timed_out, false)
  assert.equal(output.truncated, true)
  assert.equal(output.has_more, true)
  const remaining = await engine.output(queued.task_id, { wait_ms: 30000 })
  assert.equal(remaining.output, 'ata')
  assert.equal(remaining.timed_out, false)
  assert.equal(remaining.truncated, false)
})

test('regression: output timeout, zero-wait, terminal and cursor-advance facts match upstream', async (t) => {
  const { engine, children } = await setup(t)
  const task = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const immediate = await engine.output(task.task_id)
  assert.equal('timed_out' in immediate, false)
  assert.equal(immediate.truncated, false)
  const timeout = await engine.output(task.task_id, { wait_ms: 20 })
  assert.equal(timeout.timed_out, true)
  assert.equal(timeout.output, '')
  assert.equal(timeout.status, 'running')
  assert.equal(timeout.truncated, false)
  assert.equal(engine.waiters.size, 0)
  children[0].onOutput('uncommitted 中')
  assert.equal((await engine.output(task.task_id)).output, '')
  await finish(engine, children[0], '中')
  const advance = await engine.output(task.task_id, { offset: 1, wait_ms: 30000 })
  assert.equal(advance.output, '')
  assert.equal(advance.next_offset, 3)
  assert.equal(advance.timed_out, false)
  assert.equal(advance.truncated, false)
  await engine.output(task.task_id)
  const terminal = await engine.output(task.task_id, { wait_ms: 30000 })
  assert.equal(terminal.status, 'succeeded')
  assert.equal(terminal.output, '')
  assert.equal(terminal.timed_out, false)
  assert.equal(terminal.truncated, false)
  assert.equal((await engine.pendingNotifications()).length, 1)

  const failed = await engine.start(input('failure'), profile)
  await waitFor(() => children[1]?.calls.length)
  const failureWait = engine.output(failed.task_id, { wait_ms: 30000 })
  await waitFor(() => engine.waiters.size === 1)
  children[1].calls[0].reject(new Error('failed without output'))
  const failure = await failureWait
  assert.equal(failure.status, 'failed')
  assert.equal(failure.timed_out, false)
  assert.equal(failure.output, 'Background task failed: failed without output')
  assert.equal(failure.truncated, false)
})

test('regression: automatic reads serialize the wait and cursor update rather than returning empty after a competing read', async (t) => {
  const { engine, children } = await setup(t)
  const task = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  let firstReturned = false
  const first = engine.output(task.task_id, { wait_ms: 30000, limitBytes: 5 }).then((output) => {
    firstReturned = true
    return output
  })
  let secondReturned = false
  const second = engine.output(task.task_id, { wait_ms: 30000 }).then((output) => {
    secondReturned = true
    return output
  })
  await waitFor(() => engine.waiters.size === 1)
  children[0].onOutput('first draft')
  children[0].onOutput('second draft')
  await tick()
  assert.equal(firstReturned, false)
  assert.equal(secondReturned, false)
  children[0].calls[0].resolve(terminalResult('succeeded', 'firstsecond'))
  assert.equal((await first).output, 'first')
  const output = await second
  assert.equal(output.output, 'second')
  assert.equal(output.offset, 5)
  assert.equal(output.next_offset, 11)
  assert.equal(output.timed_out, false)
  assert.equal(engine.waiters.size, 0)
})

test(
  'canceling a queued automatic output read leaves the task and cursor intact',
  { timeout: 10000 },
  async (t) => {
    const { engine, children } = await setup(t)
    const task = await engine.start(input(), profile)
    await waitFor(() => children[0]?.calls.length)
    const first = engine.output(task.task_id, { wait_ms: 30000 })
    await waitFor(() => engine.waiters.size === 1)
    const controller = new AbortController()
    const canceled = engine.output(task.task_id, { wait_ms: 30000, signal: controller.signal })
    controller.abort()
    await assert.rejects(canceled, { name: 'AbortError' })
    assert.equal((await engine.query({ task_id: task.task_id })).status, 'running')
    children[0].calls[0].resolve(terminalResult('succeeded', 'hello'))
    const output = await first
    assert.equal(output.output, 'hello')
    assert.equal(output.next_offset, 5)
    const next = await engine.output(task.task_id)
    assert.equal(next.offset, 5)
    assert.equal(next.output, '')
  }
)

test('regression: reversible task turn IDs are durable before prompt, stable on replay and change with an idle continuation', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  engine.createChild = async (args) => {
    const resolved = { ...args.profile, name: 'actual-worker', skills: [], skillSnapshot: [] }
    await args.onProfileResolved?.(resolved)
    const child = await createChild({ ...args, profile: resolved })
    const prompt = child.prompt.bind(child)
    child.prompt = async (text, options) => {
      const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
      const current = saved.tasks.at(-1)
      assert.equal(current.sub_turn_id, options?.turnId)
      assert.equal(current.requested_agent_name, 'worker-alias')
      assert.equal(current.resolved_agent_name, 'actual-worker')
      return prompt(text, options)
    }
    return child
  }
  const first = await engine.start({ ...input(), agent_name: '  worker-alias  ' }, profile, {
    requestId: 'turn-start'
  })
  assert.equal(first.sub_turn_id, taskTurnId(first.task_id))
  assert.notEqual(first.sub_turn_id, first.task_id)
  assert.equal(taskIdFromTurnId(first.sub_turn_id!), first.task_id)
  assert.equal(first.requested_agent_name, 'worker-alias')
  assert.equal(
    first.resolved_agent_name,
    profile.name,
    'admission uses the resolved profile, not the request alias'
  )
  await waitFor(() => children[0]?.calls.length)
  assert.equal(children[0].calls[0].turnId, first.sub_turn_id)
  assert.equal(
    (await engine.query({ task_id: first.task_id })).resolved_agent_name,
    'actual-worker'
  )
  const steer = await engine.append(first.task_id, 'same turn', { requestId: 'turn-steer' })
  assert.equal(steer.sub_turn_id, first.sub_turn_id)
  assert.equal(steer.mode, 'steered')
  children[0].calls[0].resolve({
    text: 'first answer',
    eventCount: 7,
    subTurnId: first.sub_turn_id,
    resolvedAgentName: 'actual-worker'
  })
  await engine.runtimes.get(first.task_id)!.done
  assert.equal((await engine.query({ task_id: first.task_id })).event_count, 7)
  const next = await engine.append(first.task_id, 'new turn', { requestId: 'turn-idle' })
  assert.notEqual(next.sub_turn_id, first.sub_turn_id)
  assert.notEqual(next.sub_turn_id, next.task_id)
  assert.equal(next.sub_turn_id, taskTurnId(next.task_id))
  assert.equal(taskIdFromTurnId(next.sub_turn_id!), next.task_id)
  assert.equal(next.session_id, first.session_id)
  assert.equal(next.event_count, undefined)
  assert.equal(next.resolved_agent_name, 'actual-worker')
  await waitFor(() => children[0].calls.length === 2)
  assert.equal(children[0].calls[1].turnId, next.sub_turn_id)
  children[0].calls[1].resolve({
    text: 'second answer',
    eventCount: 0,
    subTurnId: next.sub_turn_id,
    resolvedAgentName: 'actual-worker'
  })
  await engine.runtimes.get(next.task_id)!.done
  await engine.close()
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const duplicateStart = await restored.start(input(), profile, { requestId: 'turn-start' })
    const duplicateAppend = await restored.append(first.task_id, 'new turn', {
      requestId: 'turn-idle'
    })
    assert.equal(duplicateStart.sub_turn_id, first.sub_turn_id)
    assert.equal(duplicateAppend.sub_turn_id, next.sub_turn_id)
    assert.equal(duplicateAppend.mode, 'duplicate')
    assert.equal(duplicateAppend.event_count, 0)
    assert.equal(duplicateAppend.resolved_agent_name, 'actual-worker')
    assert.equal(children.length, 1)
    assert.equal(children[0].calls.length, 2)
  } finally {
    await restored.close()
  }
})

test('regression: failure facts come only from backend partial results, never trace output or guessed counters', async (t) => {
  const { engine, children } = await setup(t)
  const first = engine.start({ ...input(), run_in_background: false }, profile)
  await waitFor(() => children[0]?.calls.length)
  const [task] = await engine.query()
  children[0].onOutput('[tool_execution_end] trace only')
  children[0].calls[0].reject(
    Object.assign(new Error('backend failed'), {
      partialResult: {
        eventCount: 4,
        subTurnId: task.sub_turn_id,
        resolvedAgentName: 'observed-worker',
        usage: { tokens: 3 }
      }
    })
  )
  const failed = await first
  assert.equal(failed.status, 'failed')
  assert.equal(failed.final_text, undefined)
  assert.equal(failed.event_count, 4)
  assert.equal(failed.resolved_agent_name, 'observed-worker')
  assert.deepEqual(failed.usage, { tokens: 3 })
  assert.equal((await engine.output(task.task_id)).output, '\n\n[failed] backend failed')

  const second = engine.start({ ...input(), run_in_background: false }, profile)
  await waitFor(() => children[1]?.calls.length)
  const current = (await engine.query()).at(-1)!
  assert.equal(current.event_count, undefined)
  assert.equal(current.resolved_agent_name, profile.name)
  children[1].onOutput('another tool trace')
  children[1].calls[0].reject(
    Object.assign(new Error('partial response failed'), {
      partialResult: {
        text: 'actual partial assistant text',
        eventCount: 0,
        subTurnId: current.sub_turn_id
      }
    })
  )
  assert.equal((await second).final_text, 'actual partial assistant text')
  assert.equal(engine.task(current.task_id).event_count, 0)
  assert.equal(engine.task(current.task_id).output, '\n\n[failed] partial response failed')

  const third = engine.start(
    { description: 'no guessed identity', prompt: '', run_in_background: false },
    profile
  )
  await waitFor(() => children[2]?.calls.length)
  const last = (await engine.query()).at(-1)!
  assert.equal(last.requested_agent_name, undefined)
  children[2].calls[0].reject(new Error('no result facts'))
  const noFacts = await third
  assert.equal(noFacts.final_text, undefined)
  assert.equal(noFacts.resolved_agent_name, profile.name)
  assert.equal(noFacts.event_count, undefined)
})

test('regression: legacy records retain absent turn and execution facts while only a newly admitted continuation gets an ID', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  await finish(engine, children[0])
  await engine.close()
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  const fields = [
    'sub_turn_id',
    'event_count',
    'requested_agent_name',
    'resolved_agent_name'
  ] as const
  for (const field of fields) {
    delete saved.tasks[0][field]
  }
  await writeFile(engine.store.file, JSON.stringify(saved))
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
    for (const field of fields) {
      assert.equal((await restored.query({ task_id: first.task_id }))[field], undefined)
    }
    /* oxlint-enable no-await-in-loop */
    const next = await restored.append(first.task_id, 'new legacy continuation')
    await waitFor(() => children[1]?.calls.length)
    assert.equal(next.sub_turn_id, taskTurnId(next.task_id))
    assert.equal(children[1].calls[0].turnId, next.sub_turn_id)
    assert.equal(next.resolved_agent_name, profile.name)
    for (const field of fields) {
      assert.equal(restored.task(first.task_id)[field], undefined)
    }
    await restored.stop(next.task_id)
  } finally {
    await restored.close()
  }
})

test('regression: store rejects malformed execution facts and resource snapshot inventories', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  children[0].calls[0].resolve({
    text: 'answer',
    eventCount: 0,
    subTurnId: first.sub_turn_id,
    resolvedAgentName: 'actual-worker'
  })
  await engine.runtimes.get(first.task_id)!.done
  await engine.close()
  const saved = await readFile(engine.store.file, 'utf8')
  const invalidFacts = [
    ['sub_turn_id', ['', 'bad-id', first.task_id, taskTurnId('different-task'), null, 1, []]],
    ['event_count', [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '1']],
    ['requested_agent_name', ['', ' \n', null, 1, []]],
    ['resolved_agent_name', ['', ' \n', null, 1, []]]
  ] as const
  /* oxlint-disable no-await-in-loop -- Cases reuse one task store; finish validation and cleanup before overwriting it. */
  for (const [field, values] of invalidFacts) {
    for (const value of values) {
      const invalid = JSON.parse(saved)
      invalid.tasks[0][field] = value
      await writeFile(engine.store.file, JSON.stringify(invalid))
      const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
      try {
        await assert.rejects(restored.init(), /Invalid task store state/)
      } finally {
        await restored.close()
      }
    }
  }
  /* oxlint-enable no-await-in-loop */
  /* oxlint-disable no-await-in-loop -- Cases reuse one task store; finish validation and cleanup before overwriting it. */
  for (const field of ['nativeToolSnapshot', 'toolInventory']) {
    const invalid = JSON.parse(saved)
    invalid.tasks[0].profile[field] = [1]
    await writeFile(engine.store.file, JSON.stringify(invalid))
    const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
    try {
      await assert.rejects(restored.init(), /Invalid task store state/)
    } finally {
      await restored.close()
    }
  }
  /* oxlint-enable no-await-in-loop */
  await writeFile(engine.store.file, saved)
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    assert.equal((await restored.query({ task_id: first.task_id })).event_count, 0)
  } finally {
    await restored.close()
  }
})

test('regression: append reports only provable typed argument, lookup, abort and admission failures', async (t) => {
  const { engine, children } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const [id, content] of [
    ['', 'x'],
    [' \t ', 'x'],
    [first.task_id, ' \n ']
  ]) {
    await assert.rejects(engine.append(id, content), { code: 'INVALID_ARGUMENT', status: 400 })
  }
  /* oxlint-enable no-await-in-loop */
  await assert.rejects(engine.append('unknown-local-task', 'x'), {
    code: 'TASK_NOT_FOUND',
    status: 404
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(engine.append(first.task_id, 'x', { signal: controller.signal }), {
    name: 'AbortError',
    code: 'TASK_APPEND_ABORTED',
    status: 409
  })
  children[0].steer = async () => {
    throw Object.assign(new Error('backend observed admission rejection'), {
      code: 'TASK_APPEND_REJECTED',
      status: 409,
      steerAccepted: false
    })
  }
  await assert.rejects(engine.append(first.task_id, 'x', { requestId: 'rejected' }), {
    code: 'TASK_APPEND_REJECTED',
    status: 409
  })
  assert.equal(engine.state!.requests[`append:${first.task_id}:rejected`], undefined)
  const release = deferred()
  children[0].abort = async () => {
    await release.promise
    children[0].calls[0].reject(new Error('stopped'))
  }
  const stopping = engine.stop(first.task_id)
  await waitFor(async () => (await engine.query({ task_id: first.task_id })).status === 'stopping')
  try {
    await assert.rejects(engine.append(first.task_id, 'x'), {
      code: 'TASK_APPEND_REJECTED',
      status: 409
    })
  } finally {
    release.resolve()
    await stopping
  }
  assert.deepEqual(children[0].steers, [])
  await engine.close()
  await assert.rejects(
    engine.append(first.task_id, 'x'),
    (error: unknown) => error instanceof Error && !('code' in error)
  )
})

test('regression: queued append persistence failure is typed, rolls back and cannot be dispatched by a concurrent completion', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  const first = await engine.start(input('A'), profile)
  const queued = await engine.start(input('B'), profile)
  await waitFor(() => children[0]?.calls.length)
  const save = engine.store.save.bind(engine.store)
  const entered = deferred()
  const release = deferred()
  const fault = new Error('queued append disk failure')
  let held = false
  engine.store.save = async (state) => {
    if (!held) {
      held = true
      entered.resolve()
      await release.promise
      throw fault
    }
    return save(state)
  }
  const rejected = assert.rejects(
    engine.append(queued.task_id, 'must not dispatch', { requestId: 'disk' }),
    { code: 'TASK_APPEND_PERSIST_FAILED', status: 500 }
  )
  await entered.promise
  try {
    children[0].calls[0].resolve({ text: 'A done' })
    await waitFor(() => !engine.runtimes.has(first.task_id))
    assert.equal(children.length, 1)
  } finally {
    release.resolve()
    await rejected
  }
  engine.store.save = save
  assert.equal(engine.task(queued.task_id).input.prompt, 'B')
  assert.equal(engine.task(queued.task_id).sub_turn_id, queued.sub_turn_id)
  assert.equal(engine.state!.requests[`append:${queued.task_id}:disk`], undefined)
  await assert.rejects(engine.append(queued.task_id, 'retry', { requestId: 'disk' }), {
    code: 'TASK_APPEND_PERSIST_FAILED',
    status: 500
  })
  engine.pump()
  assert.equal(children.length, 1)
  await engine.close()
})

test('regression: failed steering reservation never delivers and later repair preserves its at-most-once ID receipt', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const save = engine.store.save.bind(engine.store)
  engine.store.save = async () => {
    throw new Error('steer receipt disk failure')
  }
  await assert.rejects(
    engine.append(first.task_id, 'already delivered', { requestId: 'steer-disk' }),
    { code: 'TASK_APPEND_PERSIST_FAILED', status: 500 }
  )
  assert.deepEqual(children[0].steers, [])
  engine.store.save = save
  await assert.rejects(
    engine.append(first.task_id, 'already delivered', { requestId: 'steer-disk' }),
    { code: 'TASK_APPEND_PERSIST_FAILED', status: 500 }
  )
  assert.deepEqual(children[0].steers, [])
  children[0].calls[0].resolve({ text: 'complete' })
  await engine.runtimes.get(first.task_id)!.done
  await engine.close()
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const duplicate = await restored.append(first.task_id, 'already delivered', {
      requestId: 'steer-disk'
    })
    assert.equal(duplicate.mode, 'duplicate')
    assert.equal(duplicate.sub_turn_id, first.sub_turn_id)
    assert.equal(children.length, 1)
  } finally {
    await restored.close()
  }
})

test('regression: append aborted while child creation is pending is not delivered after prompt dispatch', async (t) => {
  const { engine, children, createChild } = await setup(t)
  const release = deferred()
  engine.createChild = async (args) => {
    await release.promise
    return createChild(args)
  }
  const first = await engine.start(input('original prompt'), profile)
  const controller = new AbortController()
  const rejected = assert.rejects(
    engine.append(first.task_id, 'never steer', {
      requestId: 'creation-abort',
      signal: controller.signal
    }),
    { code: 'TASK_APPEND_ABORTED', status: 409 }
  )
  await waitFor(() => Boolean(engine.runtimes.get(first.task_id)?.delivery))
  controller.abort()
  release.resolve()
  await rejected
  await waitFor(() => children[0]?.calls.length)
  assert.deepEqual(children[0].steers, [])
  assert.equal(children[0].calls[0].text, 'original prompt')
  assert.equal((await engine.query({ task_id: first.task_id })).status, 'running')
  assert.equal(engine.state!.requests[`append:${first.task_id}:creation-abort`], undefined)
})

test('regression: idle append persistence failure does not invent an admitted turn or receipt', async (t) => {
  const { engine, children } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  await finish(engine, children[0])
  const save = engine.store.save.bind(engine.store)
  engine.store.save = async () => {
    throw new Error('idle append disk failure')
  }
  await assert.rejects(engine.append(first.task_id, 'not admitted', { requestId: 'idle-disk' }), {
    code: 'TASK_APPEND_PERSIST_FAILED',
    status: 500
  })
  engine.store.save = save
  assert.equal(engine.state!.tasks.length, 1)
  assert.equal(engine.task(first.task_id).sub_turn_id, first.sub_turn_id)
  assert.equal(engine.state!.requests[`append:${first.task_id}:idle-disk`], undefined)
  assert.equal(children[0].calls.length, 1)
  engine.pump()
  assert.equal(children[0].calls.length, 1)
})

async function crashSteeringReservation(rootDir: string, phase: 'before' | 'after') {
  const script = `
    import { TaskEngine } from ${JSON.stringify(new URL('../src/engine.ts', import.meta.url).href)};
    import { readFile } from 'node:fs/promises';
    const steers = [];
    const engine = new TaskEngine({ rootDir: process.argv[1], parentId: 'parent', cwd: process.argv[1],
      createChild: async ({ sessionPath }) => ({ sessionPath, prompt: () => new Promise(() => {}),
        steer: async (text) => { steers.push(text); }, abort: async () => {}, dispose: async () => {} }) });
    await engine.init();
    const task = await engine.start({ description: 'crash window', prompt: 'original prompt', run_in_background: true },
      ${JSON.stringify(profile)});
    await engine.runtimes.get(task.task_id).started;
    const save = engine.store.save.bind(engine.store);
    engine.store.save = async (state) => {
      if (process.argv[2] === 'after') await save(state);
      throw new Error('reservation write outcome');
    };
    let code;
    try { await engine.append(task.task_id, 'request-R-content', { requestId: 'R' }); }
    catch (error) { code = error.code; }
    const disk = JSON.parse(await readFile(engine.store.file, 'utf8'));
    await new Promise((resolve) => process.stdout.write(JSON.stringify({ taskId: task.task_id, code, steers,
      receipt: disk.requests['append:' + task.task_id + ':R'], input: disk.tasks[0].input.prompt }), resolve));
    // No save restoration, prompt settlement, finish, or close. Process exit is the crash boundary.
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, rootDir, phase], {
    encoding: 'utf8'
  })
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout) as {
    taskId: string
    code: string
    steers: string[]
    receipt?: string
    input: string
  }
}

test('regression: pre-commit receipt failure cannot steer before a real restart retries R without repair saves', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  await engine.close()
  const crashed = await crashSteeringReservation(rootDir, 'before')
  assert.equal(crashed.code, 'TASK_APPEND_PERSIST_FAILED')
  assert.equal(crashed.receipt, undefined)
  assert.equal(crashed.input, 'original prompt')
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const retry = await restored.append(crashed.taskId, 'request-R-content', { requestId: 'R' })
    await waitFor(() => children[0]?.calls.length)
    assert.notEqual(retry.task_id, crashed.taskId)
    assert.equal(children[0].calls[0].text, 'request-R-content')
    assert.equal(
      crashed.steers.length +
        children[0].calls.filter((call) => call.text === 'request-R-content').length,
      1
    )
    assert.deepEqual(
      crashed.steers,
      [],
      'the failed pre-delivery save must not follow an already delivered steer'
    )
    await restored.stop(retry.task_id)
  } finally {
    await restored.close()
  }
})

test('regression: post-commit throw replays the reserved ID after restart without claiming at-least-once delivery', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  await engine.close()
  const crashed = await crashSteeringReservation(rootDir, 'after')
  assert.equal(crashed.code, 'TASK_APPEND_PERSIST_FAILED')
  assert.equal(crashed.receipt, crashed.taskId)
  assert.equal(
    crashed.input,
    'original prompt',
    'a steering receipt has IDs, not an append body outbox'
  )
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    const retry = await restored.append(crashed.taskId, 'request-R-content', { requestId: 'R' })
    assert.equal(retry.mode, 'duplicate')
    assert.equal(retry.task_id, crashed.taskId)
    assert.equal(
      children.length,
      0,
      'a durable reservation permits the source at-most-once loss boundary'
    )
    assert.deepEqual(crashed.steers, [])
  } finally {
    await restored.close()
  }
})

type FixtureFactory = (options: unknown) => {
  steer(input: unknown): Promise<{ delivered: boolean; mode?: string; reason?: string }>
}
let steeringFixture: Promise<FixtureFactory> | undefined
function upstreamSteeringFixture(): Promise<FixtureFactory> {
  return (steeringFixture ??= (async () => {
    const sourcePath =
      'packages/local-runtime-v2/src/service/turn-system/execution/steering/steer-session.service.ts'
    const lock = JSON.parse(
      await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8')
    )
    const watched = lock.watch.find((entry: { source: string }) => entry.source === sourcePath)
    assert.ok(watched?.sha256, `Missing upstream steering watch: ${sourcePath}`)
    const source = await readFile(
      new URL('./fixtures/mcode-task-steering/steer-session.service.ts.source', import.meta.url),
      'utf8'
    )
    assert.equal(createHash('sha256').update(source).digest('hex'), watched.sha256)
    const ts = await import('typescript-fixture')
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS
      }
    }).outputText
    const dependencies = await import(
      new URL('./fixtures/mcode-task-steering/dependencies.mjs', import.meta.url).href
    )
    const imports = new Set([
      '../../agent-host/contracts.js',
      '../../agent-host/canonical-user-input.js',
      '../message-query-authorship.js',
      '../../steering-identity.js',
      '../../../session-system/shared/user-message-id.js'
    ])
    const module = { exports: {} as { createSteerSessionService: FixtureFactory } }
    new Function('require', 'module', 'exports', compiled)(
      (name: string) => {
        assert.ok(imports.has(name), `Unexpected source dependency: ${name}`)
        return dependencies
      },
      module,
      module.exports
    )
    return module.exports.createSteerSessionService
  })())
}

function steeringSourceHarness(factory: FixtureFactory) {
  const events: string[] = []
  const receipts = new Map<string, string>()
  const control = {
    status: 'accepted',
    reserveFault: 'none',
    acceptFault: false,
    releaseFault: false
  }
  const service = factory({
    turns: {
      activeTurnId: (sessionId: string) => `${sessionId}:active-turn`,
      async steerActiveTurn({ turnId }: { turnId: string }) {
        events.push('steer')
        if (control.status === 'unknown') {
          throw new Error('unknown delivery outcome')
        }
        return { status: control.status, turnId }
      }
    },
    activation: {
      async execute() {
        throw new Error('Active fixture path must not activate')
      }
    },
    receipts: {
      async findSteeringReceipt({ clientRequestId }: { clientRequestId: string }) {
        events.push('find')
        const turnId = receipts.get(clientRequestId)
        return turnId ? { turnId } : undefined
      },
      async reserveSteeringReceipt(args: {
        sessionId: string
        clientRequestId: string
        turnId: string
      }) {
        events.push('reserve')
        assert.deepEqual(Object.keys(args).sort(), ['clientRequestId', 'sessionId', 'turnId'])
        if (control.reserveFault === 'before') {
          throw new Error('receipt write failure')
        }
        receipts.set(args.clientRequestId, args.turnId)
        if (control.reserveFault === 'after') {
          throw new Error('receipt write failure')
        }
        return { status: 'reserved' }
      },
      async releaseSteeringReceipt({ clientRequestId }: { clientRequestId: string }) {
        events.push('release')
        if (control.releaseFault) {
          throw new Error('receipt compensation write failure')
        }
        receipts.delete(clientRequestId)
      }
    }
  })
  const input = {
    sessionId: 'fixture-session',
    producerId: 'task-append',
    idempotencyKey: 'R',
    userMessageId: 'message-R',
    input: { text: 'follow-up' },
    preDelivery: {
      async accept() {
        events.push('accept')
        if (control.acceptFault) {
          throw new Error('pre-delivery rejection')
        }
      }
    }
  }
  return {
    events,
    receipts,
    control,
    steer: (requestId = 'R', sessionId = input.sessionId) =>
      service.steer({
        ...input,
        sessionId,
        idempotencyKey: requestId,
        userMessageId: `message-${requestId}`
      })
  }
}

test('source comparison: reserve precedes pre-delivery and steer; only definite rejection compensates', async (t) => {
  const factory = await upstreamSteeringFixture()
  const source = steeringSourceHarness(factory)
  source.control.status = 'delivery-closed'
  assert.equal((await source.steer()).delivered, false)
  assert.deepEqual(source.events, ['find', 'reserve', 'accept', 'steer', 'release'])
  assert.equal(source.receipts.size, 0)

  const { engine, children } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const events: string[] = []
  const save = engine.store.save.bind(engine.store)
  const key = `append:${first.task_id}:R`
  engine.store.save = async (state) => {
    events.push(state.requests[key] ? 'reserve' : 'release')
    return save(state)
  }
  children[0].steer = async () => {
    events.push('steer')
    throw Object.assign(new Error('delivery closed before enqueue'), { steerAccepted: false })
  }
  await assert.rejects(engine.append(first.task_id, 'follow-up', { requestId: 'R' }), {
    code: 'TASK_APPEND_REJECTED'
  })
  assert.deepEqual(
    events,
    source.events.filter((event) => event !== 'find' && event !== 'accept')
  )
  assert.equal(engine.state!.requests[key], undefined)
  engine.store.save = save
})

test('source comparison: write outcome and unknown steering errors retain at-most-once receipt semantics', async () => {
  const factory = await upstreamSteeringFixture()
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const phase of ['before', 'after']) {
    const source = steeringSourceHarness(factory)
    source.control.reserveFault = phase
    await assert.rejects(source.steer(), /receipt write failure/)
    assert.deepEqual(source.events, ['find', 'reserve'])
    source.control.reserveFault = 'none'
    assert.equal((await source.steer()).mode, phase === 'before' ? 'steered' : 'duplicate')
    assert.equal(
      source.events.filter((event) => event === 'steer').length,
      phase === 'before' ? 1 : 0
    )
  }
  /* oxlint-enable no-await-in-loop */
  const source = steeringSourceHarness(factory)
  source.control.status = 'unknown'
  await assert.rejects(source.steer(), /unknown delivery outcome/)
  assert.deepEqual(source.events, ['find', 'reserve', 'accept', 'steer'])
  assert.equal(source.receipts.size, 1)
  assert.equal((await source.steer()).mode, 'duplicate')
  assert.equal(source.events.filter((event) => event === 'steer').length, 1)
  source.control.status = 'accepted'
  assert.equal((await source.steer('independent-C', 'independent-session')).mode, 'steered')
  assert.equal(source.receipts.size, 2)
  assert.equal(source.events.filter((event) => event === 'steer').length, 2)

  const rejected = steeringSourceHarness(factory)
  rejected.control.acceptFault = true
  await assert.rejects(rejected.steer(), /pre-delivery rejection/)
  assert.deepEqual(rejected.events, ['find', 'reserve', 'accept', 'release'])
  assert.equal(rejected.receipts.size, 0)
  const compensation = steeringSourceHarness(factory)
  compensation.control.status = 'delivery-closed'
  compensation.control.releaseFault = true
  assert.equal((await compensation.steer()).delivered, false)
  assert.equal(compensation.receipts.size, 1)
  assert.equal((await compensation.steer()).mode, 'duplicate')
  assert.equal(compensation.events.filter((event) => event === 'steer').length, 1)
})

test('regression: a turn settled during the reservation save compensates before activation without steering the old turn', async (t) => {
  const { engine, children } = await setup(t)
  const first = await engine.start(input('old turn'), profile)
  await waitFor(() => children[0]?.calls.length)
  const barrier = holdNextPersistence(engine)
  const appending = engine.append(first.task_id, 'new turn content', { requestId: 'settled-save' })
  await barrier.entered
  children[0].calls[0].resolve({ text: 'old turn done' })
  await tick()
  assert.equal(engine.runtimes.get(first.task_id)?.accepting, false)
  assert.deepEqual(children[0].steers, [])
  barrier.release()
  const next = await appending
  await waitFor(() => children[0].calls.length === 2)
  assert.notEqual(next.task_id, first.task_id)
  assert.equal(next.mode, 'activated')
  assert.equal(next.sub_turn_id, taskTurnId(next.task_id))
  assert.deepEqual(children[0].steers, [])
  assert.equal(children[0].calls[1].text, 'new turn content')
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(saved.requests[`append:${first.task_id}:settled-save`], next.task_id)
})

test('regression: abort during a pre-delivery save removes only the known-undelivered receipt and leaves the child running', async (t) => {
  const { engine, children } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const controller = new AbortController()
  const barrier = holdNextPersistence(engine)
  const rejected = assert.rejects(
    engine.append(first.task_id, 'not enqueued', {
      requestId: 'abort-save',
      signal: controller.signal
    }),
    { code: 'TASK_APPEND_ABORTED', status: 409 }
  )
  await barrier.entered
  controller.abort()
  barrier.release()
  await rejected
  assert.deepEqual(children[0].steers, [])
  assert.equal((await engine.query({ task_id: first.task_id })).status, 'running')
  assert.equal(engine.state!.requests[`append:${first.task_id}:abort-save`], undefined)
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(saved.requests[`append:${first.task_id}:abort-save`], undefined)
  assert.equal(engine.task(first.task_id).input.prompt, 'hello')
})

test('regression: unknown SDK steering error retains R without blocking independent queued B or new C', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t, { maxConcurrency: 1 })
  const first = await engine.start(input('A'), profile)
  const queued = await engine.start(input('B'), profile)
  await waitFor(() => children[0]?.calls.length)
  const runtime = engine.runtimes.get(first.task_id)!
  const unknown = new Error('unknown child transport outcome')
  children[0].steer = async (text) => {
    children[0].steers.push(text)
    children[0].calls[0].resolve({ text: 'settled after SDK call' })
    throw unknown
  }
  await assert.rejects(
    engine.append(first.task_id, 'maybe delivered', { requestId: 'unknown' }),
    (error: unknown) => error === unknown
  )
  await runtime.done
  assert.equal(engine.state!.requests[`append:${first.task_id}:unknown`], first.task_id)
  assert.deepEqual(children[0].steers, ['maybe delivered'])
  assert.equal(
    children[0].calls.length,
    1,
    'settlement is not proof that the failed SDK call did not enqueue'
  )
  const duplicate = await engine.append(first.task_id, 'maybe delivered', { requestId: 'unknown' })
  assert.equal(duplicate.mode, 'duplicate')
  await waitFor(() => children[1]?.calls.length)
  assert.equal((await engine.query({ task_id: queued.task_id })).status, 'running')
  assert.equal(children[1].calls[0].text, 'B')
  const next = await engine.start(input('C'), profile)
  assert.equal(next.status, 'queued', 'only the explicit host quota can queue C')
  await finish(engine, children[1], 'B done')
  await waitFor(() => children[2]?.calls.length)
  assert.equal(children[2].calls[0].text, 'C')
  assert.notEqual(next.session_id, first.session_id)
  assert.equal((await engine.query({ task_id: first.task_id })).status, 'succeeded')
  assert.equal((await engine.output(first.task_id)).output, 'settled after SDK call')
  assert.equal(engine.task(first.task_id).stopError, undefined, 'do not invent a cleanup failure')
  await finish(engine, children[2], 'C done')
  assert.equal(
    (await engine.append(first.task_id, 'maybe delivered', { requestId: 'unknown' })).mode,
    'duplicate'
  )
  await engine.close()
  const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
  await restored.init()
  try {
    assert.equal(
      (await restored.append(first.task_id, 'maybe delivered', { requestId: 'unknown' })).mode,
      'duplicate'
    )
    assert.equal(children.length, 3)
    assert.deepEqual(children[0].steers, ['maybe delivered'])
  } finally {
    await restored.close()
  }
})

test('regression: definitive steer rejection with failed compensation retains the receipt and original rejection semantics', async (t) => {
  const { engine, children } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const save = engine.store.save.bind(engine.store)
  let saves = 0
  engine.store.save = async (state) => {
    if (++saves === 2) {
      throw new Error('compensation save failed')
    }
    return save(state)
  }
  children[0].steer = async () => {
    throw Object.assign(new Error('definitely not enqueued'), { steerAccepted: false })
  }
  await assert.rejects(
    engine.append(first.task_id, 'not enqueued', { requestId: 'compensation' }),
    { code: 'TASK_APPEND_REJECTED', status: 409 }
  )
  assert.equal(engine.state!.requests[`append:${first.task_id}:compensation`], first.task_id)
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(saved.requests[`append:${first.task_id}:compensation`], first.task_id)
  assert.deepEqual(children[0].steers, [])
  engine.store.save = save
})

test('regression: different request IDs remain serialized while the first pre-delivery save is held', async (t) => {
  const { engine, children } = await setup(t)
  const first = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const barrier = holdNextPersistence(engine)
  const one = engine.append(first.task_id, 'one', { requestId: 'one' })
  await barrier.entered
  const delivery = engine.runtimes.get(first.task_id)!.delivery
  const two = engine.append(first.task_id, 'two', { requestId: 'two' })
  await tick()
  assert.equal(engine.runtimes.get(first.task_id)!.delivery, delivery)
  assert.equal(engine.state!.requests[`append:${first.task_id}:two`], undefined)
  assert.deepEqual(children[0].steers, [])
  barrier.release()
  await Promise.all([one, two])
  assert.deepEqual(children[0].steers, ['one', 'two'])
  assert.equal(engine.state!.requests[`append:${first.task_id}:one`], first.task_id)
  assert.equal(engine.state!.requests[`append:${first.task_id}:two`], first.task_id)
})

test('source comparison: task turn encoding is an unchanged reversible index and the task row remains authoritative', async () => {
  const sourcePath = 'packages/local-runtime/src/background-task/turn-id.ts'
  const lock = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8'))
  const watched = lock.watch.find((entry: { source: string }) => entry.source === sourcePath)
  assert.ok(watched?.sha256, `Missing upstream turn-id watch: ${sourcePath}`)
  const source = await readFile(
    new URL('./fixtures/mcode-task-steering/turn-id.ts.source', import.meta.url),
    'utf8'
  )
  assert.equal(createHash('sha256').update(source).digest('hex'), watched.sha256)
  assert.equal(
    await readFile(
      new URL('../src/vendor/mcode-adapters/task-turn-id.ts', import.meta.url),
      'utf8'
    ),
    source
  )
  const ts = await import('typescript-fixture')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS
    }
  }).outputText
  const module = {
    exports: {} as {
      taskTurnId(id: string): string
      taskIdFromTurnId(id: string): string | undefined
    }
  }
  new Function('module', 'exports', compiled)(module, module.exports)
  for (const id of ['', 'task-id', 'bg_uuid', 'opaque task id', 'turn_task_bg_nested']) {
    assert.equal(taskTurnId(id), module.exports.taskTurnId(id))
    assert.equal(taskIdFromTurnId(taskTurnId(id)), module.exports.taskIdFromTurnId(taskTurnId(id)))
  }
  for (const turn of ['', 'turn_task_bg_', 'unrelated', 'turn_task_bg_task']) {
    assert.equal(taskIdFromTurnId(turn), module.exports.taskIdFromTurnId(turn))
  }
})

test('regression: a backend result cannot replace the admitted reversible task-turn mapping', async (t) => {
  const { engine, children } = await setup(t)
  const task = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  children[0].calls[0].resolve({
    text: 'not this task',
    subTurnId: taskTurnId('different-task'),
    eventCount: 99
  })
  await engine.runtimes.get(task.task_id)!.done
  const failed = await engine.query({ task_id: task.task_id })
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /does not match/)
  assert.equal(failed.sub_turn_id, taskTurnId(task.task_id))
  assert.equal(failed.event_count, undefined)
  assert.equal(failed.final_text, undefined)
})

type SourceTerminalWriter = (input: {
  host: unknown
  taskId: string
  result: TaskTerminalOutcome
  delivery: 'schedule' | 'already-delivered'
}) => Promise<BackgroundTask>
let terminalFixture: Promise<SourceTerminalWriter> | undefined
function upstreamTerminalFixture(): Promise<SourceTerminalWriter> {
  return (terminalFixture ??= (async () => {
    const source = await readFile(
      new URL('./fixtures/mcode-task-terminal/terminal.ts.source', import.meta.url),
      'utf8'
    )
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      'b6119204d4a78b404014cc15b2bdb2ba3ea63b3eaf106687f4e57a7673eb28b3'
    )
    const lock = JSON.parse(
      await readFile(new URL('../upstream.lock.json', import.meta.url), 'utf8')
    )
    assert.equal(lock.commit, '3c21163c85a9684030cb147bfef48c6284fa3c46')
    const ts = await import('typescript-fixture')
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS
      }
    }).outputText
    const module = { exports: {} as { persistLocalSubagentTaskTerminal: SourceTerminalWriter } }
    new Function('require', 'module', 'exports', compiled)(
      (name: string) => {
        if (name === './domain.js') {
          return { isTerminalTaskStatus, normalizeTaskError }
        }
        if (name === '../common/logger.js') {
          return { logger: { info() {}, warn() {} } }
        }
        assert.equal(name, './delivery.js')
        return {
          scheduleLocalBackgroundTaskDelivery: (host: { deliveries: string[] }, id: string) =>
            host.deliveries.push(id)
        }
      },
      module,
      module.exports
    )
    return module.exports.persistLocalSubagentTaskTerminal
  })())
}

async function sourceTerminal(
  result: TaskTerminalOutcome,
  status: BackgroundTask['status'] = 'running',
  failPatch = false
) {
  const writer = await upstreamTerminalFixture()
  let task: BackgroundTask = {
    taskId: 'source-task',
    kind: 'subagent',
    ownerSessionId: 'owner',
    status,
    createdAt: 0,
    updatedAt: 0,
    ...(status === 'canceled'
      ? { endedAt: 7, lastError: { code: 'TASK_CANCELED', message: 'stop won' } }
      : {})
  }
  let output = ''
  const chunks: { stream: string; content: string }[] = []
  const summaries: (string | undefined)[] = []
  const deliveries: string[] = []
  const patches: BackgroundTaskPatch[] = []
  const host = {
    nowMs: () => 42,
    deliveries,
    backgroundTaskService: {
      async appendOutput(chunk: { stream: string; content: string }) {
        chunks.push(chunk)
        output += chunk.content
        return {
          taskId: task.taskId,
          kind: 'file',
          uri: 'fixture-output',
          offset: Buffer.byteLength(output)
        }
      },
      async patchIfNotTerminal(_id: string, patch: BackgroundTaskPatch) {
        patches.push(patch)
        if (failPatch) {
          throw new Error('terminal patch failed')
        }
        if (isTerminalTaskStatus(task.status)) {
          return { patched: false, task }
        }
        task = { ...task, ...patch }
        return { patched: true, task }
      },
      async get() {
        return task
      },
      async patch(_id: string, patch: BackgroundTaskPatch) {
        task = { ...task, ...patch }
        return task
      },
      async finalizeOutput(_id: string, summary?: string) {
        summaries.push(summary)
      }
    }
  }
  const writing = writer({ host, taskId: task.taskId, result, delivery: 'schedule' })
  return { writing, chunks, summaries, deliveries, patches, output: () => output, task: () => task }
}

test('source comparison: terminal content and suffixes are plain final_result text, including late stop backfill', async () => {
  const namedAbort = Object.assign(new Error('throw named AbortError'), { name: 'AbortError' })
  const cases: TaskTerminalOutcome[] = [
    { status: 'succeeded', finalText: '中🙂 final\n' },
    { status: 'succeeded' },
    { status: 'failed', finalText: 'partial', errorMessage: 'model failed' },
    { status: 'failed' },
    { status: 'failed', finalText: '', errorMessage: '' },
    { status: 'aborted', finalText: 'partial', errorMessage: 'turn aborted' },
    { status: 'aborted' },
    { failure: new Error('completion rejected') },
    { failure: 'scalar rejection' },
    { failure: namedAbort }
  ]
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const outcome of cases) {
    const projection = toTerminalProjection(outcome)
    const source = await sourceTerminal(outcome)
    await source.writing
    assert.deepEqual(
      source.chunks.map(({ stream, content }) => ({ stream, content })),
      [{ stream: 'final_result', content: projection.outputText }]
    )
    assert.equal(source.output(), projection.outputText)
    assert.equal(source.task().status, projection.status)
    assert.deepEqual(source.summaries, [projection.summary])
    assert.deepEqual(source.patches[0].lastError, projection.lastError)
    assert.deepEqual(source.deliveries, ['source-task'])
  }
  /* oxlint-enable no-await-in-loop */
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const outcome of cases) {
    const source = await sourceTerminal(outcome, 'canceled')
    await source.writing
    assert.equal(source.task().status, 'canceled')
    assert.equal(source.task().endedAt, 7)
    assert.equal(source.task().lastError?.message, 'stop won')
    assert.equal(source.output(), toTerminalProjection(outcome).outputText)
    assert.equal(source.chunks.length, 1)
  }
  /* oxlint-enable no-await-in-loop */
  const failedWrite = await sourceTerminal(
    { status: 'succeeded', finalText: 'one append' },
    'running',
    true
  )
  await assert.rejects(failedWrite.writing, /terminal patch failed/)
  assert.equal(failedWrite.output(), 'one append')
  assert.equal(
    failedWrite.chunks.length,
    1,
    'terminal persistence failure is not a second execution failure producer'
  )
})

test('regression: real engine publishes only the scripted terminal outcome, never assistant drafts, tool statuses or stdout', async (t) => {
  const { engine, children } = await setup(t)
  const cases: TaskRunOutcome[] = [
    { status: 'succeeded', finalText: 'committed 中🙂 final\n' },
    { status: 'succeeded', finalText: '' },
    { status: 'failed', finalText: 'committed partial', errorMessage: 'normal model failure' },
    { status: 'failed', finalText: '' },
    { status: 'aborted', finalText: 'committed before abort', errorMessage: 'normal turn abort' },
    { status: 'aborted', finalText: '' }
  ]
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const [index, outcome] of cases.entries()) {
    const task = await engine.start(input(`case ${index}`), profile)
    await waitFor(() => children[index]?.calls.length)
    children[index].onOutput('assistant draft that will be replaced')
    children[index].onOutput('[tool_execution_end] bash: done')
    children[index].onOutput('private stdout')
    children[index].onActivity?.('Running tool')
    assert.equal((await engine.output(task.task_id)).output, '')
    assert.equal((await engine.query({ task_id: task.task_id })).output_bytes, 0)
    const disk = JSON.parse(await readFile(engine.store.file, 'utf8'))
    assert.equal(disk.tasks.at(-1).output, '')
    const timed = await engine.output(task.task_id, { wait_ms: 5 })
    assert.equal(timed.output, '')
    assert.equal(timed.timed_out, true)
    const waiting = engine.output(task.task_id, { wait_ms: 30000 })
    await waitFor(() => engine.waiters.size === 1)
    settleResult(children[index].calls[0], outcome.status, outcome.finalText!, outcome.errorMessage)
    const published = await waiting
    await engine.runtimes.get(task.task_id)?.done
    const source = await sourceTerminal(outcome)
    await source.writing
    assert.equal(published.output, source.output())
    assert.equal(published.status, source.task().status)
    assert.equal(published.timed_out, false)
    assert.equal(published.next_offset, Buffer.byteLength(source.output()))
    assert.equal((await engine.output(task.task_id)).output, '')
    assert.equal(engine.task(task.task_id).final_text, outcome.finalText)
    const durable = JSON.parse(await readFile(engine.store.file, 'utf8'))
    assert.equal(durable.tasks.at(-1).output, source.output())
    assert.equal(
      'outcome' in durable.tasks.at(-1),
      false,
      'producer provenance is not a new persistent trace field'
    )
    assert.doesNotMatch(
      JSON.stringify(durable),
      /assistant draft that will be replaced|private stdout|tool_execution_end/
    )
    assert.equal(
      (await engine.pendingNotifications()).some((entry) => entry.task_id === task.task_id),
      true,
      'a normal background aborted result still schedules its owner report'
    )
  }
  /* oxlint-enable no-await-in-loop */
})

test('regression: true completion throws retain caller classification rather than Error.name or partial facts', async (t) => {
  const { engine, children } = await setup(t)
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const [index, background] of [true, false].entries()) {
    const starting = engine.start({ ...input(), run_in_background: background }, profile)
    const task = background ? await starting : undefined
    await waitFor(() => children[index]?.calls.length)
    const current = task ?? (await engine.query()).at(-1)!
    const error = Object.assign(new Error('actual rejection'), {
      name: 'AbortError',
      partialResult: {
        outcome: { kind: 'exception' },
        text: 'committed partial fact',
        subTurnId: current.sub_turn_id,
        eventCount: 2
      }
    })
    children[index].onOutput('trace is not a failure body')
    children[index].calls[0].reject(error)
    await engine.runtimes.get(current.task_id)?.done
    const result = await starting
    assert.equal((await engine.query({ task_id: current.task_id })).status, 'failed')
    assert.equal(result.task_id, current.task_id)
    const outcome: TaskTerminalOutcome = background
      ? { failure: error }
      : { status: 'failed', errorMessage: 'actual rejection' }
    const source = await sourceTerminal(outcome)
    await source.writing
    assert.equal((await engine.output(current.task_id)).output, source.output())
    assert.equal(engine.task(current.task_id).final_text, 'committed partial fact')
    assert.equal(engine.task(current.task_id).event_count, 2)
  }
  /* oxlint-enable no-await-in-loop */
})

test('regression: stop-winning row keeps its terminal status while a late normal failed outcome supplies exact output', async (t) => {
  const { engine, children } = await setup(t)
  const task = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  children[0].abort = async () => {
    throw new Error('abort request failed')
  }
  const stopped = await engine.stop(task.task_id)
  assert.equal(stopped.status, 'canceled')
  assert.equal((await engine.output(task.task_id)).output, '')
  children[0].onOutput('late draft while logical row is canceled')
  assert.equal((await engine.output(task.task_id)).output, '')
  const outcome: TaskRunOutcome = {
    status: 'failed',
    finalText: 'late committed text',
    errorMessage: 'late actual failure'
  }
  settleResult(children[0].calls[0], outcome.status, outcome.finalText!, outcome.errorMessage)
  await engine.runtimes.get(task.task_id)!.done
  const source = await sourceTerminal(outcome, 'canceled')
  await source.writing
  const result = await engine.output(task.task_id)
  assert.equal(result.status, 'canceled')
  assert.equal(result.output, source.output())
  assert.equal(result.output, 'late committed text\n\n[failed] late actual failure')
  assert.deepEqual(result.stopError, stopped.stopError)
})

test('regression: failed terminal writes retain close ownership and retry only the saved outcome', async (t) => {
  /* oxlint-disable no-await-in-loop -- Each outcome owns its store and completes recovery before the next case. */
  for (const status of ['canceled', 'succeeded', 'failed'] as const) {
    await t.test(status, async (t) => {
      const { engine, children, rootDir, createChild } = await setup(t)
      const task = await engine.start(input(), profile, { requestId: 'terminal-recovery' })
      await waitFor(() => children[0]?.calls.length)
      const save = engine.store.save.bind(engine.store)
      const terminalFault = new Error('terminal write failed')
      const closeFault = new Error('close retry write failed')
      let failure: Error | undefined = terminalFault
      let attempts = 0
      engine.store.save = async (state) => {
        if (state.tasks[0].status === status) {
          attempts++
          // A thrown acknowledgement is also uncertain even when the bytes reached disk.
          if (status === 'failed') {
            await save(state)
          }
          if (failure) {
            throw failure
          }
        }
        return save(state)
      }
      try {
        const done = engine.runtimes.get(task.task_id)!.done
        if (status === 'canceled') {
          assert.equal((await engine.stop(task.task_id, 'explicit stop')).status, status)
        } else {
          children[0].calls[0].resolve(terminalResult(status, 'one terminal body'))
        }
        await done
        assert.equal(engine.runtimes.has(task.task_id), false)
        assert.equal(engine.task(task.task_id).status, status)
        const expectedOutput = engine.task(task.task_id).output
        const expectedFinished = engine.task(task.task_id).finished_at
        assert.equal(attempts, 1)
        assert.equal(
          JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0].status,
          status === 'failed' ? 'failed' : status === 'canceled' ? 'stopping' : 'running'
        )
        await assert.rejects(engine.query(), terminalFault)
        failure = closeFault
        await assert.rejects(engine.close(), closeFault)
        assert.equal(attempts, 2)
        await assert.rejects(
          engine.query(),
          terminalFault,
          'cleanup must not replace the latched storage fault'
        )
        const other = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
        await assert.rejects(other.init(), /active task owner/)
        failure = undefined
        await engine.close()
        assert.equal(attempts, 3)
        const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
        assert.equal(saved.tasks[0].status, status)
        assert.equal(saved.tasks[0].output, expectedOutput)
        assert.equal(saved.tasks[0].finished_at, expectedFinished)
        assert.equal(saved.requests['start:terminal-recovery'], task.task_id)
        const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
        await restored.init()
        try {
          const replay = await restored.start(input(), profile, { requestId: 'terminal-recovery' })
          assert.equal(replay.task_id, task.task_id)
          assert.equal(replay.status, status)
          assert.equal(restored.task(task.task_id).output, expectedOutput)
          assert.equal(children.length, 1)
          assert.equal(children[0].calls.length, 1)
        } finally {
          await restored.close()
        }
      } finally {
        engine.store.save = save
      }
    })
  }
  /* oxlint-enable no-await-in-loop */
})

for (const stage of [
  'terminal-retry',
  'queued-cancel',
  'cleanup-confirmation',
  'store-close',
  'mixed-cancel'
]) {
  test(`close retains one pending ${stage} operation across bounded reporting and retries`, async (t) => {
    const { engine, children, rootDir, createChild } = await setup(t, { maxConcurrency: 1 })
    const blocked = deferred(),
      firstFailure = new Error('first stopping write failed')
    let task: TaskSummary
    let disposes = 0
    if (stage === 'terminal-retry') {
      const entered = deferred(),
        factory = deferred(),
        controller = new AbortController()
      engine.createChild = async (args) => {
        entered.resolve()
        await factory.promise
        return createChild(args)
      }
      const starting = engine.start({ ...input(), run_in_background: false }, profile, {
        signal: controller.signal
      })
      await entered.promise
      task = engine.summary(engine.state!.tasks[0])
      const runtime = engine.runtimes.get(task.task_id)!,
        save = engine.store.save.bind(engine.store)
      engine.store.save = async (state) => {
        if (state.tasks.some((item) => item.status === 'stopping')) {
          throw firstFailure
        }
        if (runtime.sealed) {
          throw new Error('terminal write also failed')
        }
        await save(state)
      }
      try {
        controller.abort()
        await assert.rejects(starting, (error) => error === firstFailure)
      } finally {
        factory.resolve()
        await runtime.done
        engine.store.save = save
      }
      assert.equal(engine.runtimes.size, 0, 'the failed terminal producer has already exited')
    } else if (stage === 'queued-cancel' || stage === 'mixed-cancel') {
      const pump = engine.pump
      engine.pump = () => {}
      task = await engine.start(input(), profile)
      if (stage === 'mixed-cancel') {
        await engine.start(input('second queued task'), profile)
      }
      engine.pump = pump
      assert.equal(task.status, 'queued')
    } else if (stage === 'store-close') {
      task = await engine.start(input(), profile)
      await waitFor(() => children[0]?.calls.length)
      await finish(engine, children[0])
    } else {
      task = await engine.start(input(), profile)
      await waitFor(() => children[0]?.calls.length)
      const runtime = engine.runtimes.get(task.task_id)!
      children[0].calls[0].reject(
        Object.assign(new Error('cleanup not yet confirmed'), { code: 'CHILD_CLEANUP_FAILED' })
      )
      await runtime.done
      const dispose = children[0].dispose.bind(children[0])
      children[0].dispose = async () => {
        disposes++
        await dispose()
      }
    }
    const before = await readFile(engine.store.file, 'utf8'),
      save = engine.store.save.bind(engine.store)
    let writes = 0
    const close = engine.store.close.bind(engine.store)
    if (stage === 'store-close') {
      engine.store.close = async () => {
        writes++
        await blocked.promise
        await close()
      }
    } else {
      engine.store.save = async (state) => {
        writes++
        if (stage === 'mixed-cancel' && writes === 1) {
          throw firstFailure
        }
        await blocked.promise
        await save(state)
      }
    }
    const boundedClose = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          engine.close(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('close stayed pending')), 2300)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // oxlint-disable-next-line no-await-in-loop -- Both reports must join the same unfinished close write.
        await assert.rejects(boundedClose(), (error: Error & { code?: string }) => {
          assert.equal(error.code, 'CHILD_CLEANUP_FAILED')
          if (stage === 'terminal-retry' || stage === 'mixed-cancel') {
            assert.equal(error.cause, firstFailure)
          }
          return true
        })
        assert.equal(
          writes,
          stage === 'mixed-cancel' ? 2 : 1,
          'a timed-out close must not enqueue a duplicate write'
        )
      }
      assert.equal(await readFile(engine.store.file, 'utf8'), before)
      const other = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
      await assert.rejects(other.init(), /active task owner/)
      if (stage === 'cleanup-confirmation') {
        assert.equal(disposes, 1)
      }
    } finally {
      engine.store.save = save
      engine.store.close = close
      if (stage === 'mixed-cancel') {
        const drained = engine.close().catch((error) => {
          assert.equal(error, firstFailure)
        })
        blocked.resolve()
        await drained
      } else {
        blocked.resolve()
      }
      await engine.close()
    }
    assert.equal(writes, stage === 'mixed-cancel' ? 2 : 1)
    const persisted = JSON.parse(await readFile(engine.store.file, 'utf8'))
    assert.equal(
      persisted.tasks.find((item: TaskRecord) => item.task_id === task.task_id).output,
      engine.task(task.task_id).output
    )
    const restored = await new TaskEngine({
      rootDir,
      parentId: 'parent',
      cwd: rootDir,
      createChild
    }).init()
    await restored.close()
  })
}

test('regression: running and terminal write failures cannot close a queued disk row as completed cleanup', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const save = engine.store.save.bind(engine.store)
  const runningFault = new Error('running write failed first')
  const terminalFault = new Error('terminal repair still failed')
  let fail = true
  let terminalAttempts = 0
  engine.store.save = async (state) => {
    if (state.tasks[0]?.status === 'running') {
      throw runningFault
    }
    if (state.tasks[0]?.status === 'failed') {
      terminalAttempts++
      if (fail) {
        throw terminalFault
      }
    }
    return save(state)
  }
  try {
    const task = await engine.start(input(), profile, { requestId: 'both-writes-fail' })
    await waitFor(() => !engine.runtimes.has(task.task_id))
    assert.equal(children.length, 0)
    assert.equal(engine.task(task.task_id).status, 'failed')
    assert.equal(JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0].status, 'queued')
    await assert.rejects(engine.close(), terminalFault)
    assert.equal(terminalAttempts, 2)
    await assert.rejects(
      engine.query(),
      runningFault,
      'the first storage error must remain latched'
    )
    const other = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
    await assert.rejects(other.init(), /active task owner/)
    fail = false
    const expectedOutput = engine.task(task.task_id).output
    await engine.close()
    const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
    assert.equal(saved.tasks[0].status, 'failed')
    assert.equal(saved.tasks[0].error, runningFault.message)
    assert.equal(saved.tasks[0].output, expectedOutput)
    assert.equal(saved.requests['start:both-writes-fail'], task.task_id)
    const restored = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
    await restored.init()
    try {
      const replay = await restored.start(input(), profile, { requestId: 'both-writes-fail' })
      assert.equal(replay.status, 'failed')
      assert.equal(replay.task_id, task.task_id)
      assert.equal(restored.task(task.task_id).output, expectedOutput)
      assert.equal(children.length, 0)
    } finally {
      await restored.close()
    }
  } finally {
    engine.store.save = save
  }
})

test('regression: close propagates a terminal save failure produced while canceling its live child', async (t) => {
  const { engine, children, rootDir, createChild } = await setup(t)
  const task = await engine.start(input(), profile)
  await waitFor(() => children[0]?.calls.length)
  const save = engine.store.save.bind(engine.store)
  const fault = new Error('shutdown terminal write failed')
  let fail = true
  let attempts = 0
  engine.store.save = async (state) => {
    if (state.tasks[0].status === 'canceled') {
      attempts++
      if (fail) {
        throw fault
      }
    }
    return save(state)
  }
  try {
    await assert.rejects(engine.close(), fault)
    assert.equal(engine.task(task.task_id).status, 'canceled')
    assert.equal(JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0].status, 'stopping')
    assert.equal(attempts, 2, 'close must flush failures created after its initial task scan')
    await assert.rejects(engine.query(), fault)
    const other = new TaskEngine({ rootDir, parentId: 'parent', cwd: rootDir, createChild })
    await assert.rejects(other.init(), /active task owner/)
    const expectedOutput = engine.task(task.task_id).output
    fail = false
    await engine.close()
    const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
    assert.equal(saved.tasks[0].status, 'canceled')
    assert.equal(saved.tasks[0].output, expectedOutput)
    assert.equal(children[0].disposed, true)
    assert.equal(children[0].calls.length, 1)
  } finally {
    engine.store.save = save
  }
})

test('regression: terminal commit rejection is one write attempt and durable replay never duplicates or reclassifies final output', async (t) => {
  const { engine, children, rootDir } = await setup(t)
  const task = await engine.start(input(), profile, { requestId: 'terminal-once' })
  await waitFor(() => children[0]?.calls.length)
  const save = engine.store.save.bind(engine.store)
  let terminalAttempts = 0
  engine.store.save = async (state) => {
    const current = state.tasks.find((item) => item.task_id === task.task_id)!
    if (current.output) {
      terminalAttempts++
      await save(state)
      throw new Error('commit acknowledged as failure')
    }
    return save(state)
  }
  children[0].onOutput('not persisted trace')
  children[0].calls[0].resolve(terminalResult('succeeded', 'one terminal body'))
  await engine.runtimes.get(task.task_id)!.done
  assert.equal(terminalAttempts, 1)
  assert.equal(engine.task(task.task_id).output, 'one terminal body')
  assert.equal(
    JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0].output,
    'one terminal body'
  )
  engine.store.save = save
  await engine.close()
  const script = `
    import { TaskEngine } from ${JSON.stringify(new URL('../src/engine.ts', import.meta.url).href)};
    const engine = new TaskEngine({ rootDir: process.argv[1], parentId: 'parent', cwd: process.argv[1],
      createChild: async () => { throw new Error('Replay must not execute'); } });
    await engine.init();
    const result = await engine.start({ description: 'retry', prompt: 'retry', run_in_background: true },
      ${JSON.stringify(profile)}, { requestId: 'terminal-once' });
    const output = await engine.output(result.task_id);
    process.stdout.write(JSON.stringify({ result, output }));
    await engine.close();
  `
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', script, rootDir], {
    encoding: 'utf8'
  })
  assert.equal(restarted.status, 0, restarted.stderr)
  const replay = JSON.parse(restarted.stdout)
  assert.equal(replay.result.status, 'succeeded')
  assert.equal(replay.output.output, 'one terminal body')
  assert.equal(
    JSON.parse(await readFile(engine.store.file, 'utf8')).tasks[0].output,
    'one terminal body'
  )
  assert.equal(children[0].calls.length, 1)
})

test('regression: a queued cancellation writes one actual aborted result without starting a child or adding a placeholder', async (t) => {
  const { engine, children } = await setup(t, { maxConcurrency: 1 })
  await engine.start(input('blocker'), profile)
  const queued = await engine.start(input('not dispatched'), profile)
  await waitFor(() => children[0]?.calls.length)
  const stopped = await engine.stop(queued.task_id, 'canceled before dispatch')
  const source = await sourceTerminal(
    { status: 'aborted', errorMessage: 'canceled before dispatch' },
    'canceled'
  )
  await source.writing
  assert.equal(stopped.status, 'canceled')
  assert.equal(children.length, 1)
  assert.equal((await engine.output(queued.task_id)).output, source.output())
  assert.equal(engine.task(queued.task_id).final_text, undefined)
  assert.equal(engine.task(queued.task_id).event_count, undefined)
  await engine.stop(queued.task_id, 'repeat stop does not run the producer')
  await engine.close()
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  assert.equal(
    saved.tasks.find((task: TaskRecord) => task.task_id === queued.task_id).output,
    '\n\n[aborted] canceled before dispatch'
  )
})

test('regression: host shutdown preserves source caller classification without overriding a captured normal outcome', async (t) => {
  const { engine, children } = await setup(t)
  const background = await engine.start(input('background runner'), profile)
  const seed = await engine.start(input('append seed'), profile)
  await waitFor(() => children[0]?.calls.length && children[1]?.calls.length)
  await finish(engine, children[1], 'seed finished')
  const append = await engine.append(seed.task_id, 'append completion')
  await waitFor(() => children[1].calls.length === 2)
  const normal = await engine.start(input('normal result wins'), profile)
  await waitFor(() => children[2]?.calls.length)
  for (const child of children.slice(0, 2)) {
    child.abort = async () => {
      const call = child.calls.at(-1)!
      call.reject(
        Object.assign(new Error('shutdown execution rejection'), {
          partialResult: {
            text: 'committed fact is not a failure body',
            outcome: { kind: 'exception' },
            subTurnId: call.turnId
          }
        })
      )
    }
  }
  children[2].abort = async () =>
    settleResult(children[2].calls[0], 'failed', 'committed normal failure', 'normal failure won')
  await engine.close()
  const saved = JSON.parse(await readFile(engine.store.file, 'utf8'))
  const expected: [string, TaskTerminalOutcome][] = [
    [background.task_id, { status: 'aborted', errorMessage: 'Parent closed' }],
    [append.task_id, { failure: new Error('shutdown execution rejection') }],
    [
      normal.task_id,
      {
        status: 'failed',
        finalText: 'committed normal failure',
        errorMessage: 'normal failure won'
      }
    ]
  ]
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const [id, outcome] of expected) {
    const source = await sourceTerminal(outcome, 'canceled')
    await source.writing
    const task = saved.tasks.find((entry: TaskRecord) => entry.task_id === id)
    assert.equal(task.status, 'canceled')
    assert.equal(task.output, source.output())
    for (const field of ['outcome', 'backgroundRunner', 'shutdownReason']) {
      assert.equal(field in task, false)
    }
  }
  /* oxlint-enable no-await-in-loop */
})
