import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { TaskEngine } from '../src/engine.ts'
import { taskExecutionBinding, type ParentToolBinding } from '../src/task-execution-context.ts'
import type { AgentProfile } from '../src/types.ts'

const profile: AgentProfile = {
  name: 'worker',
  instructions: 'Owned fixture',
  tools: [],
  skills: [],
  extensions: [],
  mcp: false,
  timeoutMs: 0
}
const input = {
  description: 'Owned context boundary',
  prompt: 'Owned fixture',
  run_in_background: true
}
const binding = (id: string): ParentToolBinding => ({
  owner: {},
  id,
  inline: true,
  ctx: {} as ExtensionToolContext,
  tool: {
    name: id,
    label: id,
    description: id,
    parameters: { type: 'object' },
    execute: async () => ({ content: [], details: {} })
  }
})

async function setup(t: TestContext) {
  const rootDir = await mkdtemp(join(tmpdir(), 'pi-execution-context-'))
  const observed: Array<ParentToolBinding | undefined> = []
  const engine = await new TaskEngine({
    rootDir,
    parentId: 'owned',
    cwd: rootDir,
    maxConcurrency: 1,
    createChild: async ({ sessionPath }) => ({
      sessionPath,
      async prompt() {
        observed.push(taskExecutionBinding.getStore())
        return { text: 'done', outcome: { kind: 'returned', status: 'succeeded' } }
      },
      async steer() {},
      async abort() {},
      async dispose() {}
    })
  }).init()
  t.after(async () => {
    try {
      await engine.close()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
  // Inspect the actual admission reservation and transient map without replacing
  // enqueue, commit, persist or pump with an alternate scheduling implementation.
  const internals = engine as unknown as {
    admission: { pending: Set<string> }
    executionContexts: Map<string, unknown>
  }
  return { engine, observed, ...internals }
}

for (const missing of [false, true]) {
  test(
    'commit release dispatch ' +
      (missing ? 'clears a missing binding' : 'uses the pre-registered task binding'),
    async (t) => {
      const f = await setup(t)
      const own = binding('own'),
        foreign = binding('foreign')
      const pending = f.admission.pending,
        remove = pending.delete.bind(pending)
      let intercepted = false,
        registered = false,
        done: Promise<void> | undefined
      t.mock.method(pending, 'delete', (id: string) => {
        const removed = remove(id)
        if (!intercepted) {
          intercepted = true
          registered = f.executionContexts.has(id)
          if (missing) {
            f.executionContexts.delete(id)
          }
          // commit's finally has just made the real queued record dispatchable;
          // enqueue's await continuation has not had a chance to execute yet.
          taskExecutionBinding.run(foreign, () => f.engine.pump())
          done = f.engine.runtimes.get(id)?.done
        }
        return removed
      })
      const task = await taskExecutionBinding.run(own, () => f.engine.start(input, profile))
      await done
      assert.equal(intercepted, true)
      assert.equal(
        registered,
        true,
        'The binding must exist before commit releases its pending reservation'
      )
      assert.deepEqual(
        f.observed,
        [missing ? undefined : own],
        'The task must never inherit the pumping task binding'
      )
      assert.equal(f.engine.task(task.task_id).status, 'succeeded')
      assert.equal(
        f.executionContexts.size,
        0,
        'A pump that wins the commit continuation race must not leave a late map entry'
      )
    }
  )
}

test('failed admission persistence removes the pre-registered task binding', async (t) => {
  const f = await setup(t)
  const persist = f.engine.persist
  t.mock.method(f.engine, 'persist', async () => {
    throw new Error('OWNED_COMMIT_FAILURE')
  })
  try {
    await assert.rejects(
      taskExecutionBinding.run(binding('rejected'), () => f.engine.start(input, profile)),
      /OWNED_COMMIT_FAILURE/
    )
    assert.equal(f.executionContexts.size, 0)
    assert.equal(f.admission.pending.size, 0)
    assert.equal(f.engine.state?.tasks.length, 0)
    assert.deepEqual(f.observed, [])
  } finally {
    f.engine.persist = persist
  }
})
