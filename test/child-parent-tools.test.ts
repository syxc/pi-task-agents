import assert from 'node:assert/strict'
import test from 'node:test'
import { selectParentTools } from '../src/child-parent-tools.ts'

const profile = { name: 'worker', tools: ['read', 'write'], timeoutMs: 0 }
const tool = (name, source, extra = {}) => ({
  name,
  label: name,
  description: name,
  parameters: { type: 'object' },
  sourceInfo: {
    source: source.startsWith('builtin:') ? 'builtin' : 'extension',
    scope: 'user',
    path: source
  },
  execute: async () => ({ content: [], details: {} }),
  ...extra
})

test('shared tool selection intersects live inventory, role sources and saved ceilings without loading paths', () => {
  const inventory = [
    tool('read', 'builtin:read'),
    tool('owned', '/approved/owned.ts'),
    tool('new_tool', '/approved/new.ts')
  ]
  const selected = selectParentTools(
    inventory,
    {
      ...profile,
      extensions: ['/approved'],
      toolInventory: ['read', 'owned'],
      extensionSnapshot: ['/approved/owned.ts']
    },
    '/project'
  )
  assert.deepEqual(
    selected.tools.map((tool) => tool.name),
    ['read', 'owned']
  )
  assert.deepEqual([...selected.native], ['read'])
  assert.deepEqual(selected.extensionSnapshot, ['/approved/owned.ts'])
  assert.deepEqual(
    selectParentTools(inventory, { ...profile, extensions: [] }, '/project').tools.map(
      (tool) => tool.name
    ),
    ['read']
  )
})

test('MCP selectors use the raw namespace alias and cannot revive a denied registration source', () => {
  const inventory = [
    tool('mcp__owned_server__echo', 'builtin:mcp', {
      namespace: { name: 'mcp__owned_server', aliases: ['owned-server'] },
      mcpRegistrationSource: '<inline:owned-plugin>'
    })
  ]
  const selected = selectParentTools(
    inventory,
    { ...profile, mcpServers: ['owned-server'] },
    '/project'
  )
  assert.equal(selected.tools.length, 1)
  assert.equal(selected.serverFor('mcp__owned_server__echo'), 'owned-server')
  assert.deepEqual(selected.extensionSnapshot, ['<inline:owned-plugin>'])
  assert.equal(
    selectParentTools(inventory, { ...profile, extensions: [] }, '/project').tools.length,
    0
  )
  assert.equal(selectParentTools(inventory, { ...profile, mcp: false }, '/project').tools.length, 0)
})

test('saved MCP registration sources use exact identities, not normalized names', async () => {
  let calls = 0
  const inventory = [
    tool('mcp__owned__echo', 'builtin:mcp', {
      namespace: { name: 'mcp__owned', aliases: ['owned'] },
      mcpRegistrationSource: '/trusted/mcp.ts',
      execute: async () => {
        calls++
        return { content: [], details: {} }
      }
    }),
    tool('list_mcp_resources', 'builtin:mcp', {
      mcpRegistrationSources: [{ name: 'owned', source: '/trusted/mcp.ts' }],
      execute: async () => {
        calls++
        return { content: [], details: {} }
      }
    })
  ]
  const saved = { ...profile, tools: ['list_mcp_resources'] }
  await Promise.all(
    ['/trusted/Mcp.ts', '/trusted/ｍcp.ts'].map(async (source) => {
      const denied = selectParentTools(
        inventory,
        { ...saved, extensionSnapshot: [source] },
        '/project'
      )
      assert.deepEqual(
        denied.tools.map((entry) => entry.name),
        ['list_mcp_resources']
      )
      await assert.rejects(
        denied.tools[0].execute('owned', { server: 'owned' }, undefined, undefined, undefined),
        /allowed server/
      )
    })
  )
  assert.equal(calls, 0)
  const allowed = selectParentTools(
    inventory,
    { ...saved, extensionSnapshot: ['/trusted/mcp.ts'] },
    '/project'
  )
  assert.equal(allowed.tools.length, 2)
  await allowed.tools[1].execute('owned', { server: 'owned' }, undefined, undefined, undefined)
  assert.equal(calls, 1)
})

test('legacy tool inventory without extension identities cannot acquire sourced tools or MCP registrations', async () => {
  let calls = 0
  const execute = async () => {
    calls++
    return { content: [], details: {} }
  }
  const inventory = [
    tool('read', 'builtin:read'),
    tool('owned_plugin', '/replacement/plugin.ts', { execute }),
    tool('mcp__owned__echo', 'builtin:mcp', {
      namespace: { name: 'mcp__owned', aliases: ['owned'] },
      mcpRegistrationSource: '<inline:replacement>',
      execute
    }),
    tool('mcp__file__echo', 'builtin:mcp', {
      namespace: { name: 'mcp__file', aliases: ['file'] },
      execute
    }),
    tool('list_mcp_resources', 'builtin:mcp', {
      mcpRegistrationSources: [{ name: 'owned', source: '<inline:replacement>' }],
      execute
    })
  ]
  const saved = {
    ...profile,
    tools: ['read', 'list_mcp_resources'],
    toolInventory: inventory.map((entry) => entry.name)
  }
  const selected = selectParentTools(inventory, saved, '/project')
  assert.deepEqual(
    selected.tools.map((entry) => entry.name),
    ['read', 'mcp__file__echo', 'list_mcp_resources']
  )
  assert.deepEqual(selected.extensionSnapshot, [])
  const resources = selected.tools.find((entry) => entry.name === 'list_mcp_resources')!
  await assert.rejects(
    resources.execute('owned', { server: 'owned' }, undefined, undefined, undefined),
    /allowed server/
  )
  await assert.rejects(
    resources.execute('all', {}, undefined, undefined, undefined),
    /allowed server/
  )
  assert.equal(calls, 0)
  await resources.execute('file', { server: 'file' }, undefined, undefined, undefined)
  await selected.tools
    .find((entry) => entry.name === 'mcp__file__echo')!
    .execute('file-tool', {}, undefined, undefined, undefined)
  assert.equal(calls, 2, 'source-less file MCP remains usable by historical profiles')
  const oldSelector = selectParentTools(
    inventory,
    { ...saved, extensions: ['replacement'] },
    '/project'
  )
  assert.equal(
    oldSelector.tools.some((entry) => entry.name === 'mcp__owned__echo'),
    false
  )
  const fresh = selectParentTools(
    inventory,
    { ...profile, tools: saved.tools, extensions: ['replacement'] },
    '/project'
  )
  assert.ok(fresh.tools.some((entry) => entry.name === 'mcp__owned__echo'))
})

test('historical extension selectors are not fresh source authorization', async (t) => {
  const source = '/replacement/group/owned.ts'
  /* oxlint-disable no-await-in-loop -- Each selector proves old and fresh behavior before advancing to the next case. */
  for (const selector of ['owned', 'group', '/replacement/group']) {
    await t.test(selector, async () => {
      let calls = 0
      const execute = async () => {
        calls++
        return { content: [], details: {} }
      }
      const inventory = [
        tool('mcp__owned__echo', 'builtin:mcp', {
          namespace: { name: 'mcp__owned', aliases: ['owned'] },
          mcpRegistrationSource: source,
          execute
        }),
        tool('list_mcp_resources', 'builtin:mcp', {
          mcpRegistrationSources: [{ name: 'owned', source }],
          execute
        })
      ]
      const configured = { ...profile, tools: ['list_mcp_resources'], extensions: [selector] }
      const historical = selectParentTools(
        inventory,
        { ...configured, toolInventory: inventory.map((entry) => entry.name) },
        '/project'
      )
      assert.deepEqual(
        historical.tools.map((entry) => entry.name),
        ['list_mcp_resources']
      )
      assert.deepEqual(historical.extensionSnapshot, [])
      await assert.rejects(
        historical.tools[0].execute('old', { server: 'owned' }, undefined, undefined, undefined),
        /allowed server/
      )
      assert.equal(calls, 0)
      assert.equal('toolInventory' in configured, false)
      assert.equal('extensionSnapshot' in configured, false)
      const fresh = selectParentTools(inventory, configured, '/project')
      assert.deepEqual(
        fresh.tools.map((entry) => entry.name),
        ['mcp__owned__echo', 'list_mcp_resources']
      )
      assert.deepEqual(fresh.extensionSnapshot, [source])
      await fresh.tools[0].execute('new', {}, undefined, undefined, undefined)
      await fresh.tools[1].execute(
        'new-resource',
        { server: 'owned' },
        undefined,
        undefined,
        undefined
      )
      assert.equal(calls, 2)
    })
  }
  /* oxlint-enable no-await-in-loop */
})

test('aggregate MCP resources cannot cross server or extension-source restrictions', async () => {
  let calls = 0
  const inventory = [
    tool('list_mcp_resources', 'builtin:mcp', {
      mcpRegistrationSources: [{ name: 'runtime', source: '<inline:runtime-plugin>' }],
      execute: async () => {
        calls++
        return { content: [], details: {} }
      }
    })
  ]
  const selected = selectParentTools(
    inventory,
    {
      ...profile,
      tools: ['read', 'list_mcp_resources'],
      mcpServers: ['file', 'runtime'],
      extensions: []
    },
    '/project'
  )
  const invoke = (args) => selected.tools[0].execute('owned', args, undefined, undefined, undefined)
  await assert.rejects(invoke({}), /allowed server/)
  await assert.rejects(invoke({ server: 'runtime' }), /allowed server/)
  await assert.rejects(invoke({ server: 'foreign' }), /allowed server/)
  assert.equal(calls, 0)
  await invoke({ server: 'file' })
  assert.equal(calls, 1)
})
