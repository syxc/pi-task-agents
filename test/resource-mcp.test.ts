import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import { childMcpFactory } from '../src/resource-mcp.ts'
import { createPiChildFactory } from '../src/pi-backend.ts'
import type { AgentProfile } from '../src/types.ts'

const profile: AgentProfile = {
  name: 'worker',
  instructions: '',
  tools: ['read'],
  timeoutMs: 0,
  extensions: [],
  skills: [],
  thinking: 'off'
}

test('MCP config selection preserves explicit false/empty/server/tool deny without connecting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-selection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = {
    servers: ['selected', 'other'].map((name) => ({
      name,
      source: join(root, 'mcp.json'),
      config: { command: process.execPath, exposure: 'direct' }
    })),
    errors: []
  }
  /* oxlint-disable no-await-in-loop -- Cases observe or mutate shared fixture state; retain the ordered execution contract. */
  for (const selection of [
    { mcp: false },
    { mcpServers: [] },
    { mcpServers: ['selected'] },
    { tools: ['mcp__selected__echo'] }
  ]) {
    let options: Parameters<typeof sdk.createMcpExtension>[0]
    const adapter = await childMcpFactory(
      {
        loadMcpConfig: () => config as ReturnType<typeof sdk.loadMcpConfig>,
        createMcpExtension(value) {
          options = value
          return () => {}
        }
      },
      { ...profile, ...selection },
      root,
      root,
      false,
      join(root, 'session.jsonl'),
      100
    )
    const loaded = options.loadConfig()
    if ('mcp' in selection || selection.mcpServers?.length === 0) {
      assert.deepEqual(loaded.servers, [])
    } else if ('mcpServers' in selection) {
      assert.deepEqual(
        loaded.servers.map((entry) => entry.name),
        ['selected']
      )
    } else {
      assert.equal(loaded.servers.find((entry) => entry.name === 'other').config.enabled, false)
    }
    assert.equal('refresh' in adapter, false, 'No per-turn reconnection contract')
    assert.equal(options.createTransport, undefined, 'The SDK owns transports')
  }
  /* oxlint-enable no-await-in-loop */
})

test(
  'real SDK selected stdio tools obey deny policy and SDK shutdown cleans up the process',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-mcp-stdio-')),
      agentDir = join(root, 'agent')
    await mkdir(agentDir)
    const server = join(root, 'server.mjs'),
      marker = join(root, 'closed.txt'),
      unselected = join(root, 'unselected.txt')
    await writeFile(
      server,
      `import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    process.on('exit', () => writeFileSync(${JSON.stringify(marker)}, 'closed'));
    process.on('SIGTERM', () => process.exit(0));
    createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line); if (!('id' in request)) return;
      let result = {};
      if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'owned', version: '1' } };
      if (request.method === 'tools/list') result = { tools: ['echo', 'denied'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) };
      if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'owned stdio bytes' }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });`
    )
    await writeFile(
      join(agentDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          selected: { command: process.execPath, args: [server], exposure: 'direct' },
          other: {
            command: process.execPath,
            args: [
              '-e',
              `require('fs').writeFileSync(${JSON.stringify(unselected)}, 'unexpected')`
            ],
            exposure: 'direct'
          }
        }
      })
    )
    // oxlint-disable-next-line prefer-const -- Cleanup must still see undefined if async child creation fails.
    let child: Awaited<ReturnType<ReturnType<typeof createPiChildFactory>>> | undefined
    t.after(async () => {
      try {
        await child?.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    const model = {
      provider: 'offline',
      id: 'local',
      api: 'test',
      reasoning: false,
      input: ['text'],
      contextWindow: 10000,
      maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
    let calls = 0,
      session: sdk.AgentSession
    const runtime = {
      getModel: () => model,
      getModels: () => [],
      getProviders: () => [],
      hasConfiguredAuth: () => true,
      resolveModel: async () => ({ model, thinkingLevel: 'off' }),
      streamSimple() {
        const first = ++calls === 1
        const message = {
          role: 'assistant',
          api: 'test',
          provider: 'offline',
          model: 'local',
          timestamp: Date.now(),
          stopReason: first ? 'toolUse' : 'stop',
          content: first
            ? [{ type: 'toolCall', id: 'owned-echo', name: 'mcp__selected__echo', arguments: {} }]
            : [{ type: 'text', text: 'done' }],
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
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
      sdk: {
        ...sdk,
        async createAgentSession(options: sdk.CreateAgentSessionOptions) {
          const result = await sdk.createAgentSession(options)
          session = result.session
          return result
        }
      }
    })
    child = await factory({
      cwd: root,
      sessionPath: join(root, 'private', 'history.jsonl'),
      profile: {
        ...profile,
        model: 'offline/local',
        tools: ['mcp__selected__echo', 'mcp__selected__denied'],
        mcpServers: ['selected'],
        disallowedTools: ['mcp__selected__denied']
      }
    })
    assert.equal((await child.prompt('Use the selected local stdio fixture')).text, 'done')
    assert.match(JSON.stringify(session.messages), /owned stdio bytes/)
    assert.ok(session.getCallableToolNames().includes('mcp__selected__echo'))
    assert.equal(session.getCallableToolNames().includes('mcp__selected__denied'), false)
    assert.equal(
      session.getCallableToolNames().some((name: string) => name.startsWith('mcp__other__')),
      false
    )
    await assert.rejects(readFile(unselected), { code: 'ENOENT' })
    await child.dispose()
    /* oxlint-disable no-await-in-loop -- Poll one state transition at a time; the delay bounds retries. */
    for (let i = 0; i < 50; i++) {
      try {
        if ((await readFile(marker, 'utf8')) === 'closed') {
          break
        }
      } catch {}
      await delay(10)
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(await readFile(marker, 'utf8'), 'closed')
  }
)
