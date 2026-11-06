import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { answer, fixture, tool } from './pi-backend-test-helpers.ts';
import type { AgentProfile } from '../src/types.ts';

test('absent or disabled parent codemode cannot be enabled by role selectors or MCP', async t => {
  const f = await fixture(t);
  for (const role of ['explore', 'worker', 'verifier', 'mavis']) for (const mcp of [false, true]) {
    const child = await f.child({ name: role, tools: ['read', 'codemode'], mcp }, join(f.root, role + '-' + mcp + '.jsonl'));
    assert.equal(f.session().getActiveToolNames().includes('codemode'), false, role);
    assert.equal(f.session().getAllTools().some(tool => tool.name === 'codemode'), false);
    await child.dispose();
  }
});

test('the current parent switch enables native composition independently of MCP and gates later calls', async t => {
  let enabled = true;
  const f = await fixture(t, { isCodemodeEnabled: () => enabled });
  const path = join(f.cwd, 'owned.txt'); await writeFile(path, 'OWNED_NATIVE_RESULT');
  const child = await f.child({ tools: ['read'], mcp: false });
  assert.ok(f.session().getActiveToolNames().includes('codemode'), 'No separate child switch or explicit selector required');
  f.script(step => step === 1 ? tool('codemode', { code: 'text(await tools.read({path:' + JSON.stringify(path) + '}));' }) : answer('composed'));
  assert.equal((await child.prompt('Use parent-enabled composition')).text, 'composed');
  assert.match(JSON.stringify(f.session().messages), /OWNED_NATIVE_RESULT/);
  enabled = false;
  f.script(step => {
    if (step === 1) return tool('codemode', { code: 'text("MUST_NOT_RUN");' });
    const result = f.session().messages.findLast(message => message.role === 'toolResult');
    assert.equal(result?.isError, true);
    assert.match(JSON.stringify(result?.content), /outside the child allowlist/);
    return answer('parent disabled');
  });
  assert.equal((await child.prompt('Parent has disabled composition')).text, 'parent disabled');
  enabled = true;
  f.script(step => step === 1 ? tool('codemode', { code: 'text("REENABLED");' }) : answer('allowed'));
  assert.equal((await child.prompt('Parent reenabled an already authorized tool')).text, 'allowed');
  assert.match(JSON.stringify(f.session().messages), /REENABLED/);
});

test('turning on the parent switch does not expand a child snapshot created while it was off', async t => {
  let enabled = false;
  const f = await fixture(t, { isCodemodeEnabled: () => enabled });
  let frozen!: AgentProfile;
  const first = await f.child({}, undefined, async profile => { frozen = profile; });
  assert.equal(frozen.nativeToolSnapshot?.includes('codemode'), false);
  await first.prompt('Original tool ceiling'); await first.dispose();
  enabled = true;
  const restored = await f.child(frozen);
  assert.equal(f.session().getActiveToolNames().includes('codemode'), false);
  await restored.dispose();
  const fresh = await f.child({}, join(f.root, 'fresh.jsonl'));
  assert.ok(f.session().getActiveToolNames().includes('codemode'));
  await fresh.dispose();
});

test('codemode-only MCP exposure cannot turn on codemode when the parent disabled it', async t => {
  const f = await fixture(t, { isCodemodeEnabled: () => false });
  const audit = join(f.root, 'mcp-audit.jsonl');
  await writeFile(join(f.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { owned: {
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/resource-mcp/owned-server.mjs', import.meta.url)), audit, 'master-off'],
    exposure: 'codemode',
  } } }));
  const child = await f.child({ mcp: true, tools: ['read', 'codemode', 'tool_search'], skills: undefined, extensions: undefined });
  f.script(step => step === 1 ? tool('tool_search', { query: 'owned echo' }) : answer('metadata only'));
  await child.prompt('Check availability without calling the MCP business tool');
  assert.equal(f.session().getActiveToolNames().includes('codemode'), false);
  assert.equal(f.session().getAllTools().some(tool => tool.name === 'codemode'), false);
  const events = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.some(event => event.method === 'tools/call'), false);
});
