import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getPackageDir } from '@earendil-works/pi-coding-agent';

for (const denied of [false, true]) test('official bundled CLI default plugin task with parent write denial=' + denied, { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-official-task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(agentDir), mkdir(cwd)]);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' }));
  const entry = fileURLToPath(new URL('./fixtures/official-cli-task-probe.ts', import.meta.url));
  const guard = fileURLToPath(new URL('./fixtures/resource-mcp/offline-guard.mjs', import.meta.url));
  const cli = join(getPackageDir(), 'dist/cli.js'), audit = join(root, 'network.jsonl');
  const hash = async () => createHash('sha256').update(await readFile(cli)).digest('hex');
  const before = await hash();
  const child = spawn(process.execPath, [cli, '--mode', 'json', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--no-themes', '-e', entry, '--provider', 'owned-local', '--model', 'scripted', '--thinking', 'off',
    '--session-dir', join(root, 'sessions'), '-p', 'Run the owned task fixture.'], {
    cwd, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, TERM: 'dumb',
      OWNED_FIXTURE_API_KEY: 'fixture-only-not-a-credential', OWNED_DENY_WRITE: denied ? '1' : '0',
      RESOURCE_MCP_NETWORK_AUDIT: audit, NODE_OPTIONS: '--import=' + guard }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr + '\n' + stdout);
    assert.ok(stdout.includes('OFFICIAL_PARENT_OK'), stderr + '\n' + stdout);
    assert.ok(stdout.includes('OFFICIAL_CHILD_OK'), stdout);
    if (denied) {
      await assert.rejects(readFile(join(cwd, 'official-child.txt')), { code: 'ENOENT' });
      // The denial must be in the child transcript, not only claimed by a scripted answer.
      const { readdir } = await import('node:fs/promises');
      const parentDirs = await readdir(join(agentDir, 'task-agents/sessions'));
      let histories = '';
      for (const parentDir of parentDirs) for (const file of await readdir(join(agentDir, 'task-agents/sessions', parentDir))) {
        if (file.endsWith('.jsonl')) histories += await readFile(join(agentDir, 'task-agents/sessions', parentDir, file), 'utf8');
      }
      assert.ok(histories.includes('OWNED_CLI_DENIAL'), histories);
    } else assert.equal(await readFile(join(cwd, 'official-child.txt'), 'utf8'), 'OFFICIAL_WRITTEN');
    assert.equal(await hash(), before);
    const events = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.length > 0);
    assert.ok(events.every(event => event.event === 'guard-installed'), JSON.stringify(events));
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM'); }
});
