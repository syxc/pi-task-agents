import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import { answer, fixture, tool } from './pi-backend-test-helpers.ts'

test(
  'official MCP registration view excludes effective file-configured servers',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t)
    const server = fileURLToPath(
      new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url)
    )
    const audit = join(f.root, 'owned-mcp.jsonl')
    const settings = sdk.SettingsManager.inMemory(
      { compaction: { enabled: false }, retry: { enabled: false } },
      { projectTrusted: false }
    )
    let api: sdk.ExtensionAPI | undefined
    const config = (label: string) => ({
      command: process.execPath,
      args: [server, audit, label],
      exposure: 'direct' as const
    })
    const loader = new sdk.DefaultResourceLoader({
      cwd: f.cwd,
      agentDir: f.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        sdk.createMcpExtension({
          startupWaitMs: 5000,
          logPath: join(f.root, 'mcp.log'),
          loadConfig: () => ({
            servers: [
              {
                name: 'file-owned',
                scope: 'global',
                source: 'owned fixture',
                config: config('file')
              }
            ],
            errors: []
          })
        }),
        {
          name: 'owned-registration',
          factory: (pi) => {
            api = pi
            pi.registerMcpServer('runtime-owned', config('runtime'))
          }
        }
      ]
    })
    await loader.reload()
    f.script((step, context) => {
      if (step === 1) {
        return tool('mcp__file_owned__echo', { value: 'file' })
      }
      if (step === 2) {
        return tool('mcp__runtime_owned__echo', { value: 'runtime' })
      }
      const replies = context.messages
        .filter((message) => message.role === 'toolResult')
        .map((message) => JSON.stringify(message.content))
      assert.ok(replies.some((text) => /OWNED_MCP_ECHO:file:\d+:file/.test(text)))
      assert.ok(replies.some((text) => /OWNED_MCP_ECHO:runtime:\d+:runtime/.test(text)))
      return answer('OWNED_MCP_OK')
    })
    const { session } = await sdk.createAgentSession({
      cwd: f.cwd,
      agentDir: f.agentDir,
      resourceLoader: loader,
      settingsManager: settings,
      model: f.model as sdk.CreateAgentSessionOptions['model'],
      modelRuntime: f.runtime as unknown as sdk.ModelRuntime,
      sessionManager: sdk.SessionManager.create(f.cwd, join(f.root, 'parent'))
    })
    try {
      await session.bindExtensions({
        mode: 'json',
        onError: (error) => {
          throw new Error(error.error)
        },
        abortHandler() {},
        shutdownHandler() {}
      })
      await session.prompt('Call only the two owned stdio fixture tools.')
      assert.ok(api)
      const names = api.getMcpServers().map((server) => server.name)
      assert.deepEqual(names, ['runtime-owned'])
      const visible = new Set(api.getAllTools().map((entry) => entry.name))
      assert.ok(visible.has('mcp__file_owned__echo'))
      assert.ok(visible.has('mcp__runtime_owned__echo'))
      const records = (await readFile(audit, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(records.filter((record) => record.method === 'tools/call').length, 2)
    } finally {
      try {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      } finally {
        await session.dispose()
      }
    }
  }
)

test(
  'identical public MCP tool metadata does not establish server identity',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t)
    const server = fileURLToPath(
      new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url)
    )
    const audit = join(f.root, 'identity-audit.jsonl')
    const views: unknown[] = [],
      replies: string[] = []
    /* oxlint-disable no-await-in-loop -- Cases reuse the scripted runtime and current session; complete each case in order. */
    for (const label of ['one', 'two']) {
      const settings = sdk.SettingsManager.inMemory(
        { compaction: { enabled: false }, retry: { enabled: false } },
        { projectTrusted: false }
      )
      let api: sdk.ExtensionAPI | undefined
      const loader = new sdk.DefaultResourceLoader({
        cwd: f.cwd,
        agentDir: f.agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          sdk.createMcpExtension({
            startupWaitMs: 5000,
            logPath: join(f.root, 'identity-mcp.log'),
            loadConfig: () => ({
              servers: [
                {
                  name: 'owned',
                  scope: 'global',
                  source: 'owned fixture',
                  config: {
                    command: process.execPath,
                    args: [server, audit, label],
                    exposure: 'direct'
                  }
                }
              ],
              errors: []
            })
          }),
          (pi) => {
            api = pi
          }
        ]
      })
      await loader.reload()
      f.script((step, context) => {
        if (step === 1) {
          return tool('mcp__owned__echo', { value: 'same' })
        }
        const reply = context.messages.findLast(
          (message) => message.role === 'toolResult' && message.toolName === 'mcp__owned__echo'
        )
        assert.ok(reply)
        replies.push(
          typeof reply.content === 'string'
            ? reply.content
            : reply.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
        )
        return answer('OWNED_MCP_OK')
      })
      const { session } = await sdk.createAgentSession({
        cwd: f.cwd,
        agentDir: f.agentDir,
        resourceLoader: loader,
        settingsManager: settings,
        model: f.model as sdk.CreateAgentSessionOptions['model'],
        modelRuntime: f.runtime as unknown as sdk.ModelRuntime,
        sessionManager: sdk.SessionManager.inMemory(f.cwd)
      })
      try {
        await session.bindExtensions({
          mode: 'json',
          onError: (error) => {
            throw new Error(error.error)
          },
          abortHandler() {},
          shutdownHandler() {}
        })
        await session.prompt('Call only the owned stdio fixture.')
        assert.ok(api)
        const info = api.getAllTools().find((item) => item.name === 'mcp__owned__echo')
        assert.ok(info)
        views.push({ registered: api.getMcpServers(), tool: info })
      } finally {
        try {
          await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
        } finally {
          await session.dispose()
        }
      }
    }
    /* oxlint-enable no-await-in-loop */
    assert.deepEqual(views[0], views[1])
    assert.match(replies[0], /OWNED_MCP_ECHO:one:\d+:same/)
    assert.match(replies[1], /OWNED_MCP_ECHO:two:\d+:same/)
  }
)
