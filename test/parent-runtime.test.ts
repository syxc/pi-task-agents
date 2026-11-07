import assert from 'node:assert/strict'
import test from 'node:test'
import { captureParentRuntime } from '../src/parent-runtime.ts'
import { childResources } from '../src/resource-loader.ts'

const extension = (name, extra = {}) => ({
  path: '<inline:' + name + '>',
  resolvedPath: '<inline:' + name + '>',
  sourceInfo: { scope: 'user', kind: 'extension', path: '<inline:' + name + '>' },
  factory() {},
  ...extra
})
const profile = { name: 'worker', instructions: '', tools: ['read'], timeoutMs: 0, mcp: false }
const host = (extensions) => ({
  getExtensions: () => ({ extensions }),
  getSkills: () => ({ skills: [] })
})
const api = (snapshot) => ({
  captureResources: async () => snapshot,
  getAllTools: () => [],
  getSettings: () => ({})
})

test('parent snapshot absence fails explicitly rather than rediscovering disk resources', async () => {
  await assert.rejects(
    captureParentRuntime({
      getAllTools() {
        assert.fail('No metadata guessing')
      },
      getSettings() {
        assert.fail('No disk fallback')
      }
    }),
    { code: 'PARENT_RESOURCE_SNAPSHOT_REQUIRED' }
  )
})

test('parent capture preserves hook-only factories and copies only necessary native settings', async () => {
  const hook = extension('hook-only'),
    mcp = extension('mcp', { mcpConnector: true })
  const snapshot = {
    extensions: [hook, mcp, extension('self'), extension('code'), extension('search')],
    skills: [],
    mcp: { servers: [], errors: [] }
  }
  const runtime = await captureParentRuntime({
    ...api(snapshot),
    getAllTools: () =>
      [
        ['task', 'self'],
        ['codemode', 'code'],
        ['tool_search', 'search']
      ].map(([name, source]) => ({ name, sourceInfo: { path: '<inline:' + source + '>' } })),
    getSettings: () => ({
      shellPath: '/bin/sh',
      shellCommandPrefix: 'export OWNED_PREFIX=FIXTURE',
      packages: ['must-not-copy'],
      codemode: 'off',
      compaction: { enabled: false }
    })
  })
  assert.deepEqual(runtime.resources.getExtensions().extensions, [hook])
  assert.equal(runtime.resources.getExtensions().extensions[0].factory, hook.factory)
  assert.deepEqual(runtime.settings, {
    shellPath: '/bin/sh',
    shellCommandPrefix: 'export OWNED_PREFIX=FIXTURE'
  })
  assert.equal(runtime.mcp, snapshot.mcp)
})

test('capture rejects malformed resource and native setting contracts', async () => {
  await assert.rejects(captureParentRuntime(api({ extensions: [], skills: [], mcp: {} })), {
    code: 'PARENT_RESOURCE_SNAPSHOT_REQUIRED'
  })
  await assert.rejects(
    captureParentRuntime({
      ...api({ extensions: [], skills: [], mcp: null }),
      getSettings: () => ({ shellCommandPrefix: 12 })
    }),
    /Invalid inherited native shell setting/
  )
})

test('capture cancellation does not wait for a held connector or expose its late value', async () => {
  let release
  const held = new Promise((resolve) => {
      release = resolve
    }),
    cancel = new AbortController()
  const result = captureParentRuntime({ ...api(null), captureResources: () => held }, cancel.signal)
  cancel.abort()
  await assert.rejects(result, { name: 'AbortError' })
  release({ extensions: [extension('late')], skills: [], mcp: null })
  await Promise.resolve()
  const already = new AbortController()
  already.abort()
  await assert.rejects(
    captureParentRuntime(
      {
        ...api(null),
        captureResources() {
          assert.fail('No late snapshot reads')
        }
      },
      already.signal
    ),
    { name: 'AbortError' }
  )
})

test('saved extension identities do not acquire newly accepted hook-only factories', async () => {
  const owned = extension('owned'),
    added = extension('added')
  const first = await childResources(profile, '/owned', '/owned/agent', true, host([owned]))
  assert.deepEqual(first.extensionSnapshot, [owned.path])
  const restored = await childResources(
    { ...profile, toolInventory: ['read'], extensionSnapshot: first.extensionSnapshot },
    '/owned',
    '/owned/agent',
    true,
    host([owned, added])
  )
  assert.deepEqual(restored.extensionSnapshot, [owned.path])
  assert.equal(restored.inlineExtensions.length, 1)
  assert.equal(restored.inlineExtensions[0].factory, owned.factory)
})

test('anonymous factory reordering cannot transfer old approval to the replacement ordinal', async () => {
  const original = extension('0', { factoryId: 'owned-original' }),
    replacement = extension('0', { factoryId: 'owned-replacement' })
  const first = await childResources(profile, '/owned', '/owned/agent', true, host([original]))
  const moved = { ...original, path: '<inline:1>', resolvedPath: '<inline:1>' }
  const restored = await childResources(
    { ...profile, toolInventory: ['read'], extensionSnapshot: first.extensionSnapshot },
    '/owned',
    '/owned/agent',
    true,
    host([replacement, moved])
  )
  assert.equal(restored.inlineExtensions.length, 1)
  assert.equal(restored.inlineExtensions[0].factory, original.factory)
  const afterRestart = await childResources(
    { ...profile, toolInventory: ['read'], extensionSnapshot: first.extensionSnapshot },
    '/owned',
    '/owned/agent',
    true,
    host([replacement])
  )
  assert.equal(afterRestart.inlineExtensions.length, 0)
})

test('historical automatic extension inheritance without identities requires explicit reauthorization', async () => {
  await assert.rejects(
    childResources(
      { ...profile, toolInventory: ['read'] },
      '/owned',
      '/owned/agent',
      true,
      host([extension('unknown-old-owner')])
    ),
    { code: 'LEGACY_RESOURCE_SNAPSHOT_REQUIRED' }
  )
})

test('role disables and current project trust narrow even saved extension identities', async () => {
  const entry = extension('project', {
    sourceInfo: { scope: 'project', kind: 'extension', path: '<inline:project>' }
  })
  const saved = { ...profile, extensionSnapshot: [entry.path] }
  const untrusted = await childResources(saved, '/owned', '/owned/agent', false, host([entry]))
  assert.deepEqual(untrusted.extensionSnapshot, [])
  const disabled = await childResources(
    { ...saved, extensions: [] },
    '/owned',
    '/owned/agent',
    true,
    host([entry])
  )
  assert.deepEqual(disabled.extensionSnapshot, [])
})
