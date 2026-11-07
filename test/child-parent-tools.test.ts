import assert from 'node:assert/strict';
import test from 'node:test';
import { selectParentTools } from '../src/child-parent-tools.ts';

const profile = { name: 'worker', tools: ['read', 'write'], timeoutMs: 0 };
const tool = (name, source, extra = {}) => ({ name, label: name, description: name, parameters: { type: 'object' },
  sourceInfo: { source: source.startsWith('builtin:') ? 'builtin' : 'extension', scope: 'user', path: source },
  execute: async () => ({ content: [], details: {} }), ...extra });

test('shared tool selection intersects live inventory, role sources and saved ceilings without loading paths', () => {
  const inventory = [tool('read', 'builtin:read'), tool('owned', '/approved/owned.ts'), tool('new_tool', '/approved/new.ts')];
  const selected = selectParentTools(inventory, { ...profile, extensions: ['/approved'], toolInventory: ['read', 'owned'],
    extensionSnapshot: ['/approved/owned.ts'] }, '/project');
  assert.deepEqual(selected.tools.map(tool => tool.name), ['read', 'owned']);
  assert.deepEqual([...selected.native], ['read']);
  assert.deepEqual(selected.extensionSnapshot, ['/approved/owned.ts']);
  assert.deepEqual(selectParentTools(inventory, { ...profile, extensions: [] }, '/project').tools.map(tool => tool.name), ['read']);
});

test('MCP selectors use the raw namespace alias and cannot revive a denied registration source', () => {
  const inventory = [tool('mcp__owned_server__echo', 'builtin:mcp', { namespace: { name: 'mcp__owned_server', aliases: ['owned-server'] },
    mcpRegistrationSource: '<inline:owned-plugin>' })];
  const selected = selectParentTools(inventory, { ...profile, mcpServers: ['owned-server'] }, '/project');
  assert.equal(selected.tools.length, 1);
  assert.equal(selected.serverFor('mcp__owned_server__echo'), 'owned-server');
  assert.deepEqual(selected.extensionSnapshot, ['<inline:owned-plugin>']);
  assert.equal(selectParentTools(inventory, { ...profile, extensions: [] }, '/project').tools.length, 0);
  assert.equal(selectParentTools(inventory, { ...profile, mcp: false }, '/project').tools.length, 0);
});

test('aggregate MCP resources cannot cross server or extension-source restrictions', async () => {
  let calls = 0;
  const inventory = [tool('list_mcp_resources', 'builtin:mcp', {
    mcpRegistrationSources: [{ name: 'runtime', source: '<inline:runtime-plugin>' }],
    execute: async () => { calls++; return { content: [], details: {} }; },
  })];
  const selected = selectParentTools(inventory, { ...profile, tools: ['read', 'list_mcp_resources'], mcpServers: ['file', 'runtime'], extensions: [] }, '/project');
  const invoke = args => selected.tools[0].execute('owned', args, undefined, undefined, undefined);
  await assert.rejects(invoke({}), /allowed server/);
  await assert.rejects(invoke({ server: 'runtime' }), /allowed server/);
  await assert.rejects(invoke({ server: 'foreign' }), /allowed server/);
  assert.equal(calls, 0);
  await invoke({ server: 'file' });
  assert.equal(calls, 1);
});
