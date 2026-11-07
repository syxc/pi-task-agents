import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { answer, deferred, fixture, profile } from './pi-backend-test-helpers.ts'
import type { ChildFailure, ChildSession } from '../src/types.ts'

test('an already canceled factory performs no session initialization', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.create({
      profile,
      cwd: f.cwd,
      sessionPath: join(f.root, 'never-created.jsonl'),
      signal: AbortSignal.abort()
    }),
    { name: 'AbortError' }
  )
  assert.equal(f.session(), undefined)
})

for (const stage of ['factory', 'session_start', 'profile']) {
  test(`cooperative cancellation after ${stage} drains native shutdown without model calls`, async (t) => {
    const f = await fixture(t),
      entered = deferred(),
      release = deferred()
    const key = `initialization-cancellation-${randomUUID()}`
    const state = { entered, release, starts: 0, shutdowns: 0, profiles: 0, models: 0 }
    ;(globalThis as unknown as Record<string, unknown>)[key] = state
    const path = join(f.root, 'sessions', 'canceled.jsonl')
    const extension = join(f.root, 'cancellation.mjs')
    await writeFile(
      extension,
      `export default async pi => {
      const state = globalThis[${JSON.stringify(key)}];
      pi.on('session_start', async () => {
        state.starts++;
        if (${JSON.stringify(stage)} === 'session_start') { state.entered.resolve(); await state.release.promise; }
      });
      pi.on('session_shutdown', () => { state.shutdowns++; });
      if (${JSON.stringify(stage)} === 'factory') { state.entered.resolve(); await state.release.promise; }
    };`
    )
    f.script(() => {
      state.models++
      return answer()
    })
    const controller = new AbortController()
    const creating = f.create({
      profile: { ...profile, extensions: [extension] },
      cwd: f.cwd,
      sessionPath: path,
      signal: controller.signal,
      onProfileResolved: async () => {
        state.profiles++
        if (stage === 'profile') {
          entered.resolve()
          await release.promise
        }
      }
    })
    const rejected = assert.rejects(creating, { name: 'AbortError' })
    try {
      await entered.promise
      controller.abort()
      await assert.rejects(f.child({}, path), /leased/)
      release.resolve()
      await rejected
      assert.equal(state.models, 0)
      assert.equal(state.starts, stage === 'factory' ? 0 : 1)
      assert.equal(state.profiles, stage === 'profile' ? 1 : 0)
      assert.equal(state.shutdowns, 1)
      await (await f.child({}, path)).dispose()
    } finally {
      release.resolve()
      await rejected
      delete (globalThis as unknown as Record<string, unknown>)[key]
    }
  })
}

function timerDestroyed(timer: ReturnType<typeof setInterval> | undefined): boolean {
  const native = timer as ReturnType<typeof setInterval> & { _destroyed: boolean }
  // oxlint-disable-next-line no-underscore-dangle -- Assert Node's real timer cleanup, not only the fixture's stopped flag.
  return native._destroyed
}

async function ownedExtensions(
  t: TestContext,
  conflict: boolean,
  rejectFirst = false,
  { invalidMetadata = false, projectTrusted = false } = {}
) {
  const f = await fixture(t, { projectTrusted }),
    entered = deferred(),
    release = deferred(),
    ticked = deferred()
  const key = `child-initialization-${randomUUID()}`
  const state = {
    entered,
    release,
    ticked,
    rejectFirst,
    invalidMetadata,
    starts: 0,
    shutdowns: 0,
    stopped: false,
    ticks: 0,
    contexts: [] as ExtensionContext[],
    observed: [] as Record<string, unknown>[],
    executionErrors: [] as string[],
    api: undefined as ExtensionAPI | undefined,
    interval: undefined as ReturnType<typeof setInterval> | undefined
  }
  ;(globalThis as unknown as Record<string, unknown>)[key] = state
  const extension = join(f.root, 'owned-resource.mjs'),
    duplicate = join(f.root, 'duplicate-tool.mjs')
  const register = `pi.registerTool({ name: 'owned_tool', label: 'Owned tool', description: 'Owned fixture',
    parameters: { type: 'object', properties: {} }, ${invalidMetadata ? 'promptSnippet: 42,' : ''}
    execute: async () => ({ content: [], details: {} }) });`
  await writeFile(
    extension,
    `export default pi => {
    const state = globalThis[${JSON.stringify(key)}]; state.api = pi;
    state.interval = setInterval(() => { state.ticks++; state.ticked.resolve(); }, 1);
    pi.on('session_start', () => { state.starts++; });
    pi.on('session_shutdown', async (_event, ctx) => {
      if (!ctx.sessionManager.getSessionId()) throw Error('Missing native session context');
      state.shutdowns++; state.entered.resolve();
      if (state.invalidMetadata) {
        state.contexts.push(ctx);
        state.observed.push({ cwd: ctx.cwd, sessionPath: ctx.sessionManager.getSessionFile(),
          trusted: ctx.isProjectTrusted(), model: ctx.model, thinkingLevel: ctx.thinkingLevel,
          hasUI: ctx.hasUI, tools: ctx.tools, executeTool: ctx.executeTool });
        try { pi.sendUserMessage('Never dispatch from cleanup'); state.executionErrors.push('unblocked'); }
        catch (error) { state.executionErrors.push(error.message); }
        try { await pi.setModel(ctx.model); state.executionErrors.push('unblocked'); }
        catch (error) { state.executionErrors.push(error.message); }
      }
      if (state.rejectFirst && state.shutdowns === 1) throw Error('owned early cleanup failure');
      await state.release.promise;
      clearInterval(state.interval); state.stopped = true;
    });
    ${register}
  };`
  )
  await writeFile(duplicate, `export default pi => { ${register} };`)
  let calls = 0,
    profiles = 0
  f.script(() => {
    calls++
    return answer()
  })
  let cleanupChild: ChildSession | undefined
  const create = () =>
    f.child(
      { extensions: conflict ? [extension, duplicate] : [extension] },
      undefined,
      async () => {
        profiles++
      }
    )
  return {
    ...f,
    state,
    create,
    calls: () => calls,
    profiles: () => profiles,
    own(child: ChildSession | undefined) {
      cleanupChild = child
    },
    async cleanup() {
      release.resolve()
      try {
        await cleanupChild?.dispose()
      } finally {
        clearInterval(state.interval)
        delete (globalThis as unknown as Record<string, unknown>)[key]
      }
    }
  }
}

test('normal initialization binds native extensions and awaits owned resource shutdown without model calls', async (t) => {
  const f = await ownedExtensions(t, false)
  try {
    const child = await f.create()
    f.own(child)
    await f.state.ticked.promise
    assert.equal(f.state.starts, 1)
    assert.equal(f.profiles(), 1)
    const closing = child.dispose()
    await f.state.entered.promise
    assert.equal(f.state.stopped, false)
    await assert.rejects(f.child(), /leased/)
    f.state.release.resolve()
    await closing
    assert.equal(f.state.stopped, true)
    assert.equal(
      timerDestroyed(f.state.interval),
      true,
      'the owned native interval must be stopped'
    )
    assert.equal(f.calls(), 0)
    await (await f.child()).dispose()
  } finally {
    await f.cleanup()
  }
})

test('resource diagnostics await native shutdown of factories loaded before child initialization fails', async (t) => {
  const f = await ownedExtensions(t, true)
  try {
    const creating = f.create().then(
      (child) => ({ child, error: undefined }),
      (error: ChildFailure) => ({ child: undefined, error })
    )
    await Promise.race([f.state.entered.promise, creating])
    assert.equal(
      f.state.shutdowns,
      1,
      'a factory resource must receive shutdown even on resource diagnostics'
    )
    await f.state.ticked.promise
    let settled = false
    void creating.then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      settled,
      false,
      'initialization rejection must await the asynchronous shutdown hook'
    )
    assert.equal(f.state.stopped, false)
    await assert.rejects(f.child(), /leased/)
    f.state.release.resolve()
    const { child, error } = await creating
    f.own(child ?? error?.cleanupChild)
    assert.equal(child, undefined)
    assert.match(error!.message, /Could not load the explicitly configured child resources/)
    assert.ok(
      f
        .options()
        .resourceLoader!.getExtensions()
        .errors.some((item) => /owned_tool.*conflicts/.test(item.error))
    )
    assert.equal(error!.cleanupChild, undefined)
    assert.equal(f.state.stopped, true)
    assert.equal(timerDestroyed(f.state.interval), true)
    assert.equal(f.profiles(), 0)
    assert.equal(f.calls(), 0)
    await (await f.child()).dispose()
  } finally {
    await f.cleanup()
  }
})

test('SDK constructor rejection awaits cleanup-only native shutdown with an untrusted context', async (t) => {
  const f = await ownedExtensions(t, false, false, { invalidMetadata: true })
  try {
    const creating = f.create().then(
      (child) => ({ child, error: undefined }),
      (error: ChildFailure) => ({ child: undefined, error })
    )
    await Promise.race([f.state.entered.promise, creating])
    assert.equal(
      f.state.shutdowns,
      1,
      'SDK construction failure must still shut down loaded factories'
    )
    await f.state.ticked.promise
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      f.options().resourceLoader!.getExtensions().errors,
      [],
      'this failure occurs after successful extension loading'
    )
    assert.deepEqual(f.state.observed, [
      {
        cwd: f.cwd,
        sessionPath: join(f.root, 'sessions', 'owned.jsonl'),
        trusted: false,
        model: f.model,
        thinkingLevel: 'off',
        hasUI: false,
        tools: undefined,
        executeTool: undefined
      }
    ])
    assert.equal(f.state.executionErrors.length, 2)
    for (const error of f.state.executionErrors) {
      assert.match(error, /not initialized/)
    }
    assert.equal(f.state.starts, 0, 'fallback cleanup must not emit session_start')
    let settled = false
    void creating.then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    await assert.rejects(f.child(), /leased/)
    f.state.release.resolve()
    const { child, error } = await creating
    f.own(child ?? error?.cleanupChild)
    assert.equal(child, undefined)
    assert.match(error!.message, /text.replace is not a function/)
    assert.equal(error!.cleanupChild, undefined)
    assert.equal(f.state.stopped, true)
    assert.equal(timerDestroyed(f.state.interval), true)
    for (const field of ['cwd', 'model', 'thinkingLevel']) {
      assert.throws(() => f.state.contexts[0][field], /stale/)
    }
    assert.throws(() => f.state.contexts[0].isProjectTrusted(), /stale/)
    assert.throws(() => f.state.api.getThinkingLevel(), /stale/)
    assert.equal(f.profiles(), 0)
    assert.equal(f.calls(), 0)
    await (await f.child()).dispose()
  } finally {
    await f.cleanup()
  }
})

test('SDK constructor cleanup rejection retains a retryable cleanup-only child and trusted context', async (t) => {
  const f = await ownedExtensions(t, false, true, { invalidMetadata: true, projectTrusted: true })
  try {
    const error = await f.create().then(
      (child) => {
        f.own(child)
        throw new Error('Expected initialization failure')
      },
      (error: ChildFailure) => error
    )
    f.own(error.cleanupChild)
    assert.equal(error.code, 'CHILD_CLEANUP_FAILED')
    assert.match(error.message, /text.replace is not a function/)
    assert.match(error.message, /owned early cleanup failure/)
    assert.ok(error.cleanupChild)
    await f.state.ticked.promise
    assert.equal(f.state.stopped, false)
    assert.equal(timerDestroyed(f.state.interval), false)
    await assert.rejects(error.cleanupChild.prompt('Never dispatch'), /not initialized|disposed/)
    await assert.rejects(error.cleanupChild.steer('Never dispatch'), (error: ChildFailure) => {
      assert.equal(error.steerAccepted, false)
      return true
    })
    await assert.rejects(f.child(), /leased/)
    const closing = error.cleanupChild.dispose()
    assert.equal(
      error.cleanupChild.dispose(),
      closing,
      'concurrent cleanup retries must share one native shutdown'
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.state.shutdowns, 2)
    assert.equal(f.state.starts, 0)
    assert.equal(f.state.stopped, false)
    for (const observed of f.state.observed) {
      assert.deepEqual(observed, {
        cwd: f.cwd,
        sessionPath: join(f.root, 'sessions', 'owned.jsonl'),
        trusted: true,
        model: f.model,
        thinkingLevel: 'off',
        hasUI: false,
        tools: undefined,
        executeTool: undefined
      })
    }
    assert.equal(f.state.executionErrors.length, 4)
    for (const error of f.state.executionErrors) {
      assert.match(error, /not initialized/)
    }
    await assert.rejects(f.child(), /leased/)
    f.state.release.resolve()
    await closing
    await error.cleanupChild.dispose()
    assert.equal(f.state.shutdowns, 2, 'successful cleanup must be idempotent')
    assert.equal(f.state.stopped, true)
    assert.equal(timerDestroyed(f.state.interval), true)
    assert.throws(() => f.state.api.getThinkingLevel(), /stale/)
    assert.equal(f.profiles(), 0)
    assert.equal(f.calls(), 0)
    await (await f.child()).dispose()
  } finally {
    await f.cleanup()
  }
})

test('early diagnostic cleanup rejection returns a retryable child and retains its live resource lease', async (t) => {
  const f = await ownedExtensions(t, true, true)
  try {
    const error = await f.create().then(
      (child) => {
        f.own(child)
        throw new Error('Expected initialization failure')
      },
      (error: ChildFailure) => error
    )
    f.own(error.cleanupChild)
    assert.equal(error.code, 'CHILD_CLEANUP_FAILED')
    assert.match(error.message, /Could not load the explicitly configured child resources/)
    assert.match(error.message, /owned early cleanup failure/)
    assert.ok(error.cleanupChild, 'the owner must be able to retry cleanup after factory rejection')
    await f.state.ticked.promise
    assert.equal(f.state.stopped, false)
    assert.equal(timerDestroyed(f.state.interval), false)
    await assert.rejects(error.cleanupChild.prompt('Never dispatch'), /disposed/)
    await assert.rejects(f.child(), /leased/)
    const closing = error.cleanupChild.dispose()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.state.shutdowns, 2)
    assert.equal(f.state.stopped, false)
    await assert.rejects(f.child(), /leased/)
    f.state.release.resolve()
    await closing
    assert.equal(f.state.stopped, true)
    assert.equal(timerDestroyed(f.state.interval), true)
    assert.equal(f.profiles(), 0)
    assert.equal(f.calls(), 0)
    await (await f.child()).dispose()
  } finally {
    await f.cleanup()
  }
})
