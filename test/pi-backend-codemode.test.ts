import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Api, Model } from '@earendil-works/pi-ai'
import * as sdk from '@earendil-works/pi-coding-agent'
import { createPiChildFactory } from '../src/pi-backend.ts'
import type { ChildSession } from '../src/types.ts'
import { answer, fixture, tool } from './pi-backend-test-helpers.ts'

test(
  'production MCP codemode preserves execution without exposing host model services',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-child-codemode-'))
    const agentDir = join(root, 'agent')
    await mkdir(agentDir)
    // oxlint-disable-next-line prefer-const -- Cleanup must still see undefined if async child creation fails.
    let child: ChildSession | undefined
    t.after(async () => {
      try {
        await child?.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    const failures: unknown[] = []
    let calls = 0
    let registrations = 0
    const runtime = {
      getModel: (provider: string, id: string) => ({
        provider,
        id,
        api: 'openai-completions',
        reasoning: false,
        input: ['text'],
        contextWindow: 10000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }),
      getModels: () => [],
      getProviders: () => [],
      hasConfiguredAuth: () => true,
      resolveModel: async (model: Model<Api>) => ({ model, thinkingLevel: 'off' }),
      streamSimple(
        model: Model<Api>,
        context: { messages: { role: string; content?: unknown; isError?: boolean }[] }
      ) {
        calls++
        try {
          if (calls === 2) {
            const result = context.messages.findLast((message) => message.role === 'toolResult')
            assert.ok(result)
            assert.equal(result.isError, false)
            assert.match(JSON.stringify(result.content), /undefined/)
          }
        } catch (error) {
          failures.push(error)
          throw error
        }
        const message = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: calls === 1 ? 'toolUse' : 'stop',
          content:
            calls === 1
              ? [
                  {
                    type: 'toolCall',
                    id: 'fixture-codemode',
                    name: 'codemode',
                    arguments: { code: 'text(typeof models);' }
                  }
                ]
              : [{ type: 'text', text: 'done' }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'done', reason: message.stopReason, message }
          },
          result: async () => message
        }
      }
    }
    const factory = createPiChildFactory({
      agentDir,
      modelRuntime: runtime,
      isCodemodeEnabled: () => true,
      sdk: {
        ...sdk,
        createCodemodeExtension(options: Parameters<typeof sdk.createCodemodeExtension>[0]) {
          registrations++
          assert.equal(options?.models, false)
          return sdk.createCodemodeExtension(options)
        }
      }
    })
    child = await factory({
      cwd: root,
      sessionPath: join(root, 'child.jsonl'),
      profile: {
        name: 'fixture',
        model: 'fixture/local',
        thinking: 'off',
        instructions: 'Use only the local scripted fixture.',
        tools: ['codemode'],
        mcp: true,
        skills: [],
        extensions: []
      }
    })
    assert.equal((await child.prompt('Inspect the sandbox globals')).text, 'done')
    assert.deepEqual(failures, [])
    assert.equal(calls, 2)
    assert.equal(registrations, 1)
  }
)

test('PTC equivalent codemode composes native and extension tools when MCP is explicitly disabled', async (t) => {
  const f = await fixture(t, { isCodemodeEnabled: () => true })
  const paths = [join(f.cwd, 'one.txt'), join(f.cwd, 'two.txt')]
  await Promise.all(paths.map((path, index) => writeFile(path, index ? 'two' : 'one')))
  const extension = join(f.root, 'owned-codemode.mjs')
  await writeFile(
    extension,
    `export default pi => pi.registerTool({ name: 'plugin_owned', label: 'Owned', description: 'Owned fixture',
    parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'PLUGIN_OK' }], details: {} }) });`
  )
  const code = `const values = await Promise.all(${JSON.stringify(paths)}.map(path => tools.read({ path })));
    text(values.join('+')); text(await tools.plugin_owned({})); text(typeof models);`
  /* oxlint-disable no-await-in-loop -- Cases reuse the scripted runtime and current session; complete each case in order. */
  for (const role of ['explore', 'worker', 'verifier', 'mavis']) {
    for (const selection of [{ mcp: false }, { mcp: true, mcpServers: [] }]) {
      const child = await f.child(
        { name: role, tools: ['read', 'codemode'], extensions: [extension], ...selection },
        join(f.root, role + '-' + selection.mcp + '.jsonl')
      )
      assert.ok(
        f.session().getActiveToolNames().includes('codemode'),
        JSON.stringify({ role, selection })
      )
      f.script((step) => {
        if (step === 1) {
          return tool('codemode', { code })
        }
        const result = f.session().messages.findLast((message) => message.role === 'toolResult')
        assert.equal(result?.isError, false)
        assert.match(JSON.stringify(result?.content), /one\+two/)
        assert.match(JSON.stringify(result?.content), /PLUGIN_OK/)
        assert.match(JSON.stringify(result?.content), /undefined/)
        return answer('composed')
      })
      assert.equal((await child.prompt('Compose only the owned tools')).text, 'composed')
      await child.dispose()
    }
  }
  /* oxlint-enable no-await-in-loop */
})

test('codemode cannot bypass readonly tools, parent controls, permission hooks or saved ceilings', async (t) => {
  const f = await fixture(t, { isCodemodeEnabled: () => true })
  const denied = join(f.cwd, 'denied.txt'),
    target = join(f.cwd, 'forbidden.txt')
  await writeFile(denied, 'owned fixture')
  const extension = join(f.root, 'codemode-permission.mjs')
  await writeFile(
    extension,
    `export default pi => {
    pi.on('tool_call', e => e.toolName === 'read' ? { block: true, reason: 'OWNED_READ_DENIED' } : undefined);
    pi.registerTool({ name: 'create_goal', label: 'Goal', description: 'Forbidden parent control',
      parameters: { type: 'object', properties: {} }, execute: async () => { throw Error('PARENT_CONTROL_EXECUTED'); } });
  };`
  )
  const child = await f.child({
    name: 'explore',
    tools: ['read', 'write', 'edit', 'codemode', 'create_goal'],
    extensions: [extension]
  })
  const code = `const attempts = [async () => tools.write({path:${JSON.stringify(target)},content:'forbidden'}),
    async () => tools.create_goal({}), async () => tools.read({path:${JSON.stringify(denied)}})];
    text(await Promise.allSettled(attempts.map(call => call())).then(results => results.map(result => ({status:result.status,
      error:result.status === 'rejected' ? String(result.reason) : 'UNEXPECTED_SUCCESS'}))));`
  f.script((step) => {
    if (step === 1) {
      return tool('codemode', { code })
    }
    const text = JSON.stringify(
      f.session().messages.findLast((message) => message.role === 'toolResult')?.content
    )
    assert.equal((text.match(/rejected/g) ?? []).length, 3)
    assert.match(text, /OWNED_READ_DENIED/)
    assert.doesNotMatch(text, /PARENT_CONTROL_EXECUTED|UNEXPECTED_SUCCESS/)
    return answer('bounded')
  })
  assert.equal((await child.prompt('Check tool boundaries')).text, 'bounded')
  await assert.rejects(readFile(target), { code: 'ENOENT' })
  await child.dispose()
  /* oxlint-disable no-await-in-loop -- Cases reuse the scripted runtime and current session; complete each case in order. */
  for (const limits of [{ nativeToolSnapshot: ['read'] }, { disallowedTools: ['codemode'] }]) {
    const bounded = await f.child(
      { tools: ['read', 'codemode'], ...limits },
      join(f.root, Object.keys(limits)[0] + '.jsonl')
    )
    assert.equal(f.session().getActiveToolNames().includes('codemode'), false)
    await bounded.dispose()
  }
  /* oxlint-enable no-await-in-loop */
})
