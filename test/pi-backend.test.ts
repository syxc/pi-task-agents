import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type * as sdk from '@earendil-works/pi-coding-agent'
import { answer, tool, deferred, profile, fixture } from './pi-backend-test-helpers.ts'
import { seedInheritedProvider } from '../src/model-providers.ts'
import { TaskEngine } from '../src/engine.ts'
import type { AgentProfile, ChildFailure, ChildSession, TaskRecord } from '../src/types.ts'
import { DiagnosticLog } from '../src/diagnostics.ts'
import { recordChildFailure } from '../src/engine-facts.ts'
import { taskTurnId } from '../src/vendor/mcode-adapters/task-turn-id.ts'

test('default SDK native Bash writes an owned file; facts come from real messages/events', async (t) => {
  const f = await fixture(t)
  let resolved!: AgentProfile
  const child = await f.child({ tools: ['bash'] }, undefined, async (value) => {
    resolved = value
  })
  assert.deepEqual(f.session().getCallableToolNames(), ['bash', 'bash_task'])
  assert.equal(f.options().customTools, undefined)
  f.script((step) =>
    step === 1 ? tool('bash', { command: "printf 'owned bytes' > actual.txt" }) : answer('Finished')
  )
  const before = f.events()
  const result = await child.prompt('Write the owned fixture', { turnId: 'opaque turn / 42' })
  assert.equal(await readFile(join(f.cwd, 'actual.txt'), 'utf8'), 'owned bytes')
  assert.equal(result.text, 'Finished')
  assert.equal(result.subTurnId, 'opaque turn / 42')
  assert.deepEqual(result.outcome, { kind: 'returned', status: 'succeeded' })
  assert.deepEqual(result.usage, {
    input: 4,
    output: 6,
    cacheRead: 8,
    cacheWrite: 10,
    totalTokens: 28,
    cost: 0.02
  })
  assert.equal(result.eventCount, f.events() - before)
  assert.equal(resolved.model, 'offline/local')
  assert.deepEqual(resolved.nativeToolSnapshot, ['bash', 'bash_task'])
  assert.equal(Object.isFrozen(resolved), true)
  assert.equal(Object.isFrozen(resolved.tools), true)
  assert.equal(Object.isFrozen(resolved.nativeToolSnapshot), true)
  assert.equal((await stat(child.sessionPath)).mode & 0o777, 0o600)
  assert.equal((await stat(join(f.root, 'sessions'))).mode & 0o777, 0o700)
})

test('successful reports preserve ordinary Basic and token text with the original credential protection', async (t) => {
  const f = await fixture(t)
  const ordinary =
    'Basic arithmetic is supported. Basic checks passed.\ntoken: identifier\n{"token":"field-name"}'
  const credentials = [
    'Bearer bearer-credential',
    'api-key=api-credential',
    'access_token=access-credential',
    'refresh_token=refresh-credential',
    'authorization=auth-credential',
    'password=password-credential',
    'secret=secret-credential',
    'sk_syntheticcredential'
  ].join('\n')
  f.script(() => answer(ordinary + '\n' + credentials))
  const child = await f.child()
  const result = await child.prompt(
    'Return the offline report with ordinary words and credentials.'
  )
  assert.deepEqual(result.outcome, { kind: 'returned', status: 'succeeded' })
  assert.equal(
    result.text,
    ordinary +
      '\n' +
      [
        'Bearer [redacted]',
        'api-key=[redacted]',
        'access_token=[redacted]',
        'refresh_token=[redacted]',
        'authorization=[redacted]',
        'password=[redacted]',
        'secret=[redacted]',
        '[redacted]'
      ].join('\n')
  )
  assert.doesNotMatch(result.text, /credential/)
})

test('error pipelines redact escaped credentials before terminal facts reach diagnostic JSONL', async (t) => {
  const raw = JSON.stringify({ password: 'prefix\\"tail-secret-round2' })
  /* oxlint-disable no-await-in-loop -- SDK fixtures and cleanup ownership must settle before the next failure path. */
  for (const mode of [
    'model',
    'extension',
    'cleanup',
    'initialization',
    'uninitialized-shutdown'
  ]) {
    await t.test(mode, async (t) => {
      const f = await fixture(
        t,
        mode === 'uninitialized-shutdown'
          ? {
              sdk: {
                createAgentSession: async () => {
                  throw new Error('Offline constructor failure')
                }
              }
            }
          : {}
      )
      const taskId = 'error-pipeline-' + mode
      const turnId = taskTurnId(taskId)
      const extension = join(f.root, 'error-pipeline.mjs')
      if (mode === 'extension' || mode === 'uninitialized-shutdown') {
        await writeFile(
          extension,
          'export default pi => { let first = true; pi.on(' +
            JSON.stringify(mode === 'extension' ? 'input' : 'session_shutdown') +
            ', () => { if (first) { first = false; throw Error(' +
            JSON.stringify(raw) +
            '); } }); };'
        )
      }
      const operation = async () => {
        if (mode === 'initialization') {
          return f.child({}, undefined, async () => {
            throw new Error(raw)
          })
        }
        const child = await f.child(
          mode === 'extension' || mode === 'uninitialized-shutdown'
            ? { extensions: [extension] }
            : {}
        )
        if (mode === 'cleanup') {
          const session = f.session()
          const original = session.dispose.bind(session)
          session.dispose = () => {
            session.dispose = original
            throw Object.assign(new Error(raw), { code: raw })
          }
          return child.dispose()
        }
        f.script(() => answer('', { stopReason: 'error', errorMessage: raw }))
        return child.prompt('Return the offline failure.', { turnId })
      }
      let failure: ChildFailure | undefined
      await assert.rejects(operation(), (error: ChildFailure) => {
        failure = error
        return true
      })
      assert.ok(failure)
      await failure.cleanupChild?.dispose()
      const task: TaskRecord = {
        task_id: taskId,
        sub_turn_id: turnId,
        session_id: 'pipeline-session',
        parent_id: 'pipeline-parent',
        childSessionPath: join(f.root, 'sessions', 'owned.jsonl'),
        profile,
        input: { prompt: 'Return the offline failure.' },
        status: 'failed',
        description: 'Offline error redaction',
        agent_name: profile.name,
        created_at: new Date().toISOString(),
        output: '',
        cursor: 0,
        notification_pending: false,
        notify_completion: false
      }
      const terminal = recordChildFailure(task, failure).message
      new DiagnosticLog(f.agentDir).write('error', 'task_failed', {
        task_id: taskId,
        status: 'failed',
        error: terminal
      })
      const directory = join(f.agentDir, 'task-agents', 'logs')
      const files = await readdir(directory)
      const persisted = await Promise.all(
        files.map((name) => readFile(join(directory, name), 'utf8'))
      )
      assert.doesNotMatch(persisted.join(''), /prefix|tail-secret-round2/)
      const record = JSON.parse(persisted.join('').trim())
      assert.equal(record.error.message, terminal)
      assert.match(terminal, /\[redacted\]/)
      assert.doesNotMatch(failure.message, /prefix|tail-secret-round2/)
      assert.doesNotMatch(terminal, /prefix|tail-secret-round2/)
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('independent sessions and continuation retain only their own history', async (t) => {
  const f = await fixture(t),
    first = await f.child()
  await first.prompt('First child secret')
  await assert.rejects(f.child(), /leased/)
  await first.dispose()
  const continued = await f.child()
  assert.match(JSON.stringify(f.session().messages), /First child secret/)
  assert.equal((await continued.prompt('Continuation')).text, 'done')
  const second = await f.child({}, join(f.root, 'sessions', 'second.jsonl'))
  assert.doesNotMatch(JSON.stringify(f.session().messages), /First child secret|Continuation/)
  await second.prompt('Independent')
  const history = await readFile(first.sessionPath, 'utf8')
  assert.match(history, /Continuation/)
  assert.doesNotMatch(history, /Independent/)
})

test('real session paths reject symlinks, foreign cwd and non-string input', async (t) => {
  const f = await fixture(t),
    child = await f.child()
  await assert.rejects(child.prompt(42 as unknown as string), /string/)
  await assert.rejects(child.steer({} as unknown as string), /string/)
  await assert.rejects(child.prompt('text', { turnId: '' }), /Turn ID/)
  await child.prompt('Persist history')
  await child.dispose()
  const alias = join(f.root, 'alias.jsonl')
  await symlink(child.sessionPath, alias)
  await assert.rejects(f.child({}, alias))
  const foreign = join(f.root, 'foreign.jsonl')
  await writeFile(foreign, JSON.stringify({ type: 'session', id: 'foreign', cwd: '/foreign' }))
  await assert.rejects(f.child({}, foreign), /working directory/)
})

test('skills/extensions use selected resources, snapshots and role ceilings', async (t) => {
  const f = await fixture(t)
  const skill = join(f.root, 'owned-skill')
  await mkdir(skill)
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: owned-skill\ndescription: Owned fixture\n---\nOnly this fixture.'
  )
  const extension = join(f.root, 'owned.mjs')
  await writeFile(
    extension,
    `export default pi => {
    pi.on('input', e => e.text === 'raw' ? { action: 'transform', text: 'transformed' } : undefined);
    for (const name of ['plugin_owned', 'task', 'task_stop']) pi.registerTool({ name, label: name, description: name,
      parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }) });
  };`
  )
  const child = await f.child({
    tools: ['read', 'write', 'task'],
    name: 'explore',
    skills: [skill],
    extensions: [extension]
  })
  assert.deepEqual(
    f
      .options()
      .resourceLoader!.getSkills()
      .skills.map((skill) => skill.name),
    ['owned-skill']
  )
  assert.deepEqual(f.session().getCallableToolNames().sort(), ['plugin_owned', 'read'])
  await child.prompt('raw')
  assert.match(JSON.stringify(f.session().messages), /transformed/)
  await child.dispose()
  const denied = await f.child({ skills: [], extensions: [], nativeToolSnapshot: [] })
  assert.deepEqual(f.session().getCallableToolNames(), [])
  assert.deepEqual(f.options().resourceLoader!.getSkills().skills, [])
  await denied.dispose()
  const sealed = await f.child({ skills: [skill], skillSnapshot: [] })
  assert.deepEqual(f.options().resourceLoader!.getSkills().skills, [])
  await sealed.dispose()
})

test('native tool calls still pass selected permission hooks', async (t) => {
  const f = await fixture(t),
    extension = join(f.root, 'permission.mjs')
  await writeFile(
    extension,
    `export default pi => pi.on('tool_call', e => e.toolName === 'bash' ? { block: true, reason: 'owned deny' } : undefined);`
  )
  const child = await f.child({ tools: ['bash'], extensions: [extension] })
  f.script((step) =>
    step === 1 ? tool('bash', { command: 'printf forbidden > forbidden.txt' }) : answer('Denied')
  )
  assert.equal((await child.prompt('Try the permission gate')).text, 'Denied')
  await assert.rejects(readFile(join(f.cwd, 'forbidden.txt')), { code: 'ENOENT' })
  assert.match(JSON.stringify(f.session().messages), /owned deny/)
})

test('permission extensions observe the actual parent project trust', async (t) => {
  /* oxlint-disable no-await-in-loop -- Subtests share SDK mocks and process state; finish each case before the next. */
  for (const projectTrusted of [false, true]) {
    await t.test(String(projectTrusted), async (t) => {
      const f = await fixture(t, { projectTrusted })
      const key = `child-trust-${Date.now()}-${projectTrusted}`,
        observed: boolean[] = []
      ;(globalThis as unknown as Record<string, unknown>)[key] = observed
      t.after(() => {
        delete (globalThis as unknown as Record<string, unknown>)[key]
      })
      const extension = join(f.root, 'trust-gate.mjs')
      await writeFile(
        extension,
        `export default pi => pi.on('tool_call', (e, ctx) => {
      globalThis[${JSON.stringify(key)}].push(ctx.isProjectTrusted());
      if (!ctx.isProjectTrusted()) return { block: true, reason: 'Untrusted fixture' };
    });`
      )
      const child = await f.child({ tools: ['bash'], extensions: [extension] })
      f.script((step) =>
        step === 1 ? tool('bash', { command: 'printf owned > trust.txt' }) : answer('Finished')
      )
      await child.prompt('Run the owned permission fixture')
      assert.deepEqual(observed, [projectTrusted])
      if (projectTrusted) {
        assert.equal(await readFile(join(f.cwd, 'trust.txt'), 'utf8'), 'owned')
      } else {
        await assert.rejects(readFile(join(f.cwd, 'trust.txt')), { code: 'ENOENT' })
      }
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('abort and timeout end the owning prompt without contaminating its successor', async (t) => {
  /* oxlint-disable no-await-in-loop -- Subtests share SDK mocks and process state; finish each case before the next. */
  for (const mode of ['abort', 'timeout']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t),
        child = await f.child({ timeoutMs: mode === 'timeout' ? 30 : 0 })
      const entered = deferred()
      f.script(async (_step, _context, options) => {
        entered.resolve()
        await new Promise<void>((resolve) =>
          options.signal.aborted
            ? resolve()
            : options.signal.addEventListener('abort', () => resolve(), { once: true })
        )
        return answer('', { stopReason: 'aborted' })
      })
      const running = child.prompt('Wait')
      const rejected = assert.rejects(running, (error: ChildFailure) => {
        assert.equal(error.name, mode === 'timeout' ? 'TimeoutError' : 'AbortError')
        assert.deepEqual(error.partialResult?.outcome, {
          kind: 'returned',
          status: mode === 'timeout' ? 'failed' : 'aborted'
        })
        return true
      })
      await entered.promise
      if (mode === 'abort') {
        await child.abort()
      }
      await rejected
      f.script(() => answer('Next only'))
      assert.equal((await child.prompt('Successor')).text, 'Next only')
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('preflight cancellation cannot start a late model/tool run and a successor still works', async (t) => {
  /* oxlint-disable no-await-in-loop -- Subtests share SDK mocks and process state; finish each case before the next. */
  for (const stage of ['input', 'auth', 'before_agent_start', 'timeout']) {
    await t.test(stage, async (t) => {
      const f = await fixture(t),
        entered = deferred(),
        release = deferred(),
        canceled = deferred()
      const key = `task-agent-preflight-${stage}-${Date.now()}`
      ;(globalThis as unknown as Record<string, unknown>)[key] = { entered, release }
      t.after(() => {
        delete (globalThis as unknown as Record<string, unknown>)[key]
      })
      const extension = join(f.root, 'preflight.mjs')
      await writeFile(
        extension,
        `export default pi => pi.on(${JSON.stringify(stage === 'before_agent_start' ? stage : 'input')}, async e => {
      if (${JSON.stringify(stage)} === 'auth') return;
      const fixture = globalThis[${JSON.stringify(key)}]; fixture.entered.resolve(); await fixture.release.promise;
    });`
      )
      if (stage === 'auth') {
        f.runtime.hasConfiguredAuth = () => false
        ;(f.runtime as unknown as sdk.ModelRuntime).checkAuth = async () => {
          entered.resolve()
          await release.promise
          return 'owned-test-auth'
        }
      }
      const child = await f.child({
        tools: ['bash'],
        extensions: [extension],
        timeoutMs: stage === 'timeout' ? 200 : 0
      })
      let calls = 0
      f.script(() =>
        ++calls === 1 ? tool('bash', { command: 'printf owned > owned.txt' }) : answer('Done')
      )
      const sessionAbort = f.session().abort.bind(f.session())
      f.session().abort = () => {
        canceled.resolve()
        return sessionAbort()
      }
      const running = child.prompt('Canceled owner')
      const rejected = assert.rejects(running, {
        name: stage === 'timeout' ? 'TimeoutError' : 'AbortError'
      })
      await entered.promise
      const stopping = stage === 'timeout' ? canceled.promise : child.abort()
      if (stage === 'timeout') {
        await canceled.promise
      }
      release.resolve()
      await stopping
      await rejected
      assert.equal(calls, 0, 'canceling preflight must not invoke the model')
      await assert.rejects(readFile(join(f.cwd, 'owned.txt')), { code: 'ENOENT' })
      assert.equal((await child.prompt('Successor')).text, 'Done')
      assert.equal(await readFile(join(f.cwd, 'owned.txt'), 'utf8'), 'owned')
      assert.equal(calls, 2, 'the same model/tool path must remain reachable for a valid successor')
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('async input steering reaches its original sink; canceled delayed input never enters a successor', async (t) => {
  const f = await fixture(t),
    extension = join(f.root, 'steering.mjs')
  const entered = deferred(),
    release = deferred()
  const key = `task-agent-steer-${Date.now()}`
  ;(globalThis as unknown as Record<string, unknown>)[key] = { entered, release }
  t.after(() => {
    delete (globalThis as unknown as Record<string, unknown>)[key]
  })
  await writeFile(
    extension,
    `export default pi => pi.on('input', async e => {
    if (e.text === 'delayed') { globalThis[${JSON.stringify(key)}].entered.resolve(); await globalThis[${JSON.stringify(key)}].release.promise; }
    if (e.streamingBehavior === 'steer') return { action: 'transform', text: e.text + ' transformed' };
  });`
  )
  const child = await f.child({ extensions: [extension] })
  const streaming = deferred(),
    finish = deferred()
  f.script(async (step, _context, options) => {
    if (step === 1) {
      streaming.resolve()
      await Promise.race([
        finish.promise,
        new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), { once: true })
        )
      ])
    }
    return answer('Owner answer', options.signal.aborted ? { stopReason: 'aborted' } : {})
  })
  const running = child.prompt('Owner')
  await streaming.promise
  assert.equal(await child.steer('queued'), 'queued')
  const delayed = child.steer('delayed')
  const rejectedInput = assert.rejects(delayed, (error: ChildFailure) => {
    assert.equal(error.steerAccepted, false)
    return true
  })
  await entered.promise
  const rejectedOwner = assert.rejects(running, { name: 'AbortError' })
  await child.abort()
  await rejectedOwner
  await rejectedInput
  f.script(() => answer('Successor only'))
  assert.equal((await child.prompt('Successor')).text, 'Successor only')
  release.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.session().pendingMessageCount, 0)
  assert.doesNotMatch(JSON.stringify(f.session().messages), /delayed transformed/)
  finish.resolve()
})

test('successful async steering runs input hooks and is consumed before owning-turn settlement', async (t) => {
  const f = await fixture(t),
    extension = join(f.root, 'async-input.mjs')
  const input = deferred(),
    release = deferred(),
    streaming = deferred(),
    finish = deferred(),
    settling = deferred()
  const key = `task-agent-async-${Date.now()}`
  ;(globalThis as unknown as Record<string, unknown>)[key] = { input, release, settling }
  t.after(() => {
    delete (globalThis as unknown as Record<string, unknown>)[key]
  })
  await writeFile(
    extension,
    `export default pi => {
    pi.on('input', async e => { if (e.streamingBehavior !== 'steer') return;
      const fixture = globalThis[${JSON.stringify(key)}]; fixture.input.resolve(); await fixture.release.promise;
      return { action: 'transform', text: 'Accepted transformed input' };
    });
    pi.on('agent_before_settle', () => globalThis[${JSON.stringify(key)}].settling.resolve());
  };`
  )
  const child = await f.child({ extensions: [extension] })
  f.script(async (step) => {
    if (step === 1) {
      streaming.resolve()
      await finish.promise
    }
    return answer(step === 1 ? 'First answer' : 'Steered answer')
  })
  const running = child.prompt('Owner')
  await streaming.promise
  const steering = child.steer('Async steering')
  await input.promise
  finish.resolve()
  await settling.promise
  release.resolve()
  assert.equal(await steering, 'queued')
  assert.equal((await running).text, 'First answer\nSteered answer')
  assert.match(JSON.stringify(f.session().messages), /Accepted transformed input/)
  assert.equal(f.session().pendingMessageCount, 0)
})

test('abort/dispose and shutdown-hook failures retain the session lease until retry succeeds', async (t) => {
  /* oxlint-disable no-await-in-loop -- Subtests share SDK mocks and process state; finish each case before the next. */
  for (const mode of ['abort', 'dispose', 'shutdown']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t),
        extension = join(f.root, 'shutdown.mjs')
      if (mode === 'shutdown') {
        await writeFile(
          extension,
          `export default pi => { let first = true; pi.on('session_shutdown', () => { if (first) { first = false; throw Error('owned cleanup failure'); } }); };`
        )
      }
      const child = await f.child(mode === 'shutdown' ? { extensions: [extension] } : {})
      if (mode !== 'shutdown') {
        const session = f.session(),
          original = session[mode].bind(session)
        let first = true
        session[mode] = (...args: Parameters<typeof original>) => {
          if (first) {
            first = false
            throw new Error('owned cleanup failure')
          }
          return original(...args)
        }
      }
      await assert.rejects(child.dispose(), (error: ChildFailure) => {
        assert.equal(error.code, 'CHILD_CLEANUP_FAILED')
        return true
      })
      await assert.rejects(f.child(), /leased/)
      await child.dispose()
      await (await f.child()).dispose()
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('failed initialization exposes cleanup ownership and the engine retries it on close', async (t) => {
  const f = await fixture(t),
    extension = join(f.root, 'initialization-cleanup.mjs')
  let modelCalls = 0
  f.script(() => {
    modelCalls++
    return answer()
  })
  await writeFile(
    extension,
    `export default pi => { let first = true; pi.on('session_shutdown', () => {
    if (first) { first = false; throw Error('owned initial cleanup failure'); }
  }); };`
  )
  let orphan: ChildSession | undefined
  await assert.rejects(
    f.child({ extensions: [extension] }, undefined, async () => {
      throw new Error('profile persistence failed')
    }),
    (error: ChildFailure) => {
      orphan = error.cleanupChild
      assert.equal(error.code, 'CHILD_CLEANUP_FAILED')
      assert.ok(orphan, 'factory rejection must retain a reachable cleanup handle')
      assert.match(error.message, /profile persistence failed/)
      return true
    }
  )
  await assert.rejects(f.child(), /leased/)
  await orphan!.dispose()
  await (await f.child()).dispose()

  const engine = new TaskEngine({
    rootDir: join(f.root, 'tasks'),
    parentId: 'cleanup-owner',
    cwd: f.cwd,
    createChild: f.create
  })
  await engine.init()
  t.after(() => engine.close())
  const persist = engine.persist.bind(engine)
  let failSnapshot = true
  engine.persist = async () => {
    if (
      failSnapshot &&
      engine.state?.tasks.some((task) => task.profile.skillSnapshot !== undefined)
    ) {
      failSnapshot = false
      throw new Error('engine profile persistence failed')
    }
    await persist()
  }
  await engine.start(
    { agent_name: 'worker', description: 'Initialization cleanup', prompt: 'Never dispatch' },
    { ...profile, extensions: [extension] }
  )
  const [task] = engine.state!.tasks
  assert.equal(task.stopError?.code, 'CHILD_CLEANUP_FAILED')
  assert.ok(
    engine.sessions.get(task.session_id)?.child,
    'engine must own a child even when its factory rejected'
  )
  assert.equal(
    engine.runtimes.has(task.task_id),
    true,
    'unconfirmed cleanup must retain its capacity'
  )
  assert.equal(
    JSON.stringify(engine.state).includes('cleanupChild'),
    false,
    'cleanup handles are not persisted'
  )
  assert.equal(modelCalls, 0, 'failed initialization must never dispatch the model')
  await assert.rejects(f.child({ extensions: [extension] }, task.childSessionPath), /leased/)
  await engine.close()
  await (await f.child({}, task.childSessionPath)).dispose()
})

test('model inheritance, native thinking validation and profile persistence happen before dispatch', async (t) => {
  const f = await fixture(t)
  const child = await f.child()
  assert.equal(f.options().model, f.model)
  await child.dispose()
  await assert.rejects(f.child({ thinking: 'high' }), /unsupported/)
  await assert.rejects(
    f.child({ effort: 'high' }),
    /Requested child thinking level high is unsupported/
  )
  await assert.rejects(
    f.child({ effort: 'max' }),
    /Requested child thinking level max is unsupported/
  )
  await assert.rejects(
    f.child({ thinking: 'm3' as AgentProfile['thinking'] }),
    /Invalid Pi thinking/
  )
  await assert.rejects(
    f.child({}, undefined, async () => {
      throw new Error('persist failed')
    }),
    /persist failed/
  )
  await (await f.child()).dispose()
})

test('an explicit model does not inherit a different parent thinking choice', async (t) => {
  const f = await fixture(t, { inheritedThinking: 'high' })
  const child = await f.child({ model: 'offline/local', thinking: undefined })
  assert.equal(f.options().thinkingLevel, undefined)
  assert.equal(f.session().thinkingLevel, 'off')
  await child.dispose()
})

test('only the selected trusted registered provider is seeded, without reading protocol metadata', () => {
  const registered: unknown[] = []
  const runtime = {
    registerProvider: (...args: unknown[]) => registered.push(args),
    registerNativeProvider: (provider: unknown) => registered.push(provider)
  } as unknown as Parameters<typeof seedInheritedProvider>[0]
  const config = { api: 'test', models: [] }
  const inherited = {
    getRegisteredProviderIds: () => ['owned'],
    getRegisteredNativeProvider: () => undefined,
    getRegisteredProviderConfig: () => config
  } as unknown as Parameters<typeof seedInheritedProvider>[1]
  assert.equal(seedInheritedProvider(runtime, inherited, 'untrusted-name'), false)
  assert.deepEqual(registered, [])
  assert.equal(seedInheritedProvider(runtime, inherited, 'owned'), true)
  assert.deepEqual(registered, [['owned', config]])
})

test('returned model failures and true input exceptions preserve terminal provenance', async (t) => {
  const f = await fixture(t),
    child = await f.child()
  f.script(() =>
    answer('Committed failure', { stopReason: 'error', errorMessage: 'Owned failure' })
  )
  await assert.rejects(child.prompt('Fail'), (error: ChildFailure) => {
    assert.equal(error.partialResult?.text, 'Committed failure')
    assert.deepEqual(error.partialResult?.outcome, { kind: 'returned', status: 'failed' })
    return true
  })
  await child.dispose()
  const extension = join(f.root, 'handled.mjs')
  await writeFile(extension, `export default pi => pi.on('input', () => ({ action: 'handled' }));`)
  const handled = await f.child({ extensions: [extension] })
  await assert.rejects(handled.prompt('Handled'), (error: ChildFailure) => {
    assert.deepEqual(error.partialResult?.outcome, { kind: 'exception' })
    assert.equal(error.partialResult?.text, '')
    return true
  })
})

test('a transient extension failure does not poison later turns of the same child', async (t) => {
  const f = await fixture(t),
    extension = join(f.root, 'transient-input.mjs')
  await writeFile(
    extension,
    `export default pi => pi.on('input', event => {
      if (event.text.endsWith('_TRANSIENT_FAILURE')) throw Error(event.text);
    });`
  )
  const child = await f.child({ extensions: [extension] })
  await assert.rejects(child.prompt('FIRST_TRANSIENT_FAILURE'), /FIRST_TRANSIENT_FAILURE/)
  f.script(() => answer('RECOVERED_CHILD_TURN'))
  assert.equal(
    (await child.prompt('Continue after the transient error')).text,
    'RECOVERED_CHILD_TURN'
  )
  await assert.rejects(child.prompt('NEXT_TRANSIENT_FAILURE'), /NEXT_TRANSIENT_FAILURE/)
})
