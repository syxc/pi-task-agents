import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRoles, roleOverview, taskElapsed, taskProgress } from '../src/task-presentation.ts';

const profile = { name: 'worker', instructions: 'PRIVATE_ROLE_INSTRUCTIONS', tools: ['read', 'bash'], timeoutMs: 0 };

test('role overview distinguishes inheritance, model defaults and explicit resource selections', () => {
  const roles = { worker: profile, verifier: { ...profile, name: 'verifier', model: 'provider/model',
    skills: [], extensions: ['./one.ts'], mcpServers: [] } };
  const overview = roleOverview(roles);
  assert.equal('model' in overview.worker, false);
  assert.equal('instructions' in overview.worker, false);
  assert.deepEqual(overview.worker.resources, { skills: 'inherit', extensions: 'inherit', mcp: 'inherit' });
  assert.deepEqual(overview.verifier.resources, { skills: 'off', extensions: '1 selected', mcp: 'off' });
  const text = renderRoles(roles);
  assert.match(text, /inherit current conversation/); assert.match(text, /provider\/model \| model default/);
  assert.doesNotMatch(text, /PRIVATE_ROLE_INSTRUCTIONS|timeoutMs/);
});

test('task elapsed times are bounded, readable, and do not invent missing timestamps', () => {
  const created_at = '2026-01-01T00:00:00Z';
  assert.equal(taskElapsed({ created_at }, Date.parse(created_at) + 65000), '1m 5s');
  assert.equal(taskElapsed({ created_at, started_at: '2026-01-01T00:00:05Z', finished_at: '2026-01-01T00:00:07Z' }), '2s');
  assert.equal(taskElapsed({ created_at: 'invalid' }), '');
  assert.equal(taskElapsed({ created_at }, 0), '0s');
});

test('progress shows activity and failure reasons without terminal control characters', () => {
  const line = taskProgress({ task_id: 't1', agent_name: 'worker', status: 'failed', description: 'Check\nfixture',
    created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:10Z', activity: 'bash: failed', error: 'Missing\raccess' } as any);
  assert.match(line, /10s/); assert.match(line, /bash: failed/); assert.match(line, /Missing access/);
  assert.doesNotMatch(line, /[\r\n]/);
});
