import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scenarios = fileURLToPath(new URL('./fixtures/default-sdk-chain/scenarios.mjs', import.meta.url));
const guard = new URL('./fixtures/resource-mcp/offline-guard.mjs', import.meta.url).href;

// Keep native SDK socket paths short on macOS; all identities and artifacts belong to this fresh root.
test('default SDK Engine chain executes all five isolated offline acceptance cases with zero skips', { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'pds-'));
  const audit = join(root, 'network.jsonl');
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let didClose = false;
  const kill = () => {
    if (!child?.pid || didClose) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  try {
    for (const name of ['home', 'global-agent', 'tmp', 'config', 'cache', 'data', 'state', 'run', 'cases']) {
      await mkdir(join(root, name), { mode: 0o700 });
    }
    child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', scenarios], {
      cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin', HOME: join(root, 'home'), PWD: root,
        PI_CODING_AGENT_DIR: join(root, 'global-agent'), TMPDIR: join(root, 'tmp'),
        XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
        XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'run'),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'config', 'gitconfig'),
        NODE_OPTIONS: `--import ${guard}`, DEFAULT_SDK_CHAIN_TEST_ROOT: root, RESOURCE_MCP_NETWORK_AUDIT: audit,
      },
    });
    let output = '';
    child.stdout!.on('data', (chunk) => { output += chunk; });
    child.stderr!.on('data', (chunk) => { output += chunk; });
    closed = new Promise((resolve) => child!.once('close', (code, signal) => { didClose = true; resolve({ code, signal }); }));
    const spawnError = new Promise<never>((_resolve, reject) => child!.once('error', reject));
    let timedOut = false;
    timer = setTimeout(() => { timedOut = true; kill(); }, 90000);
    const exit = await Promise.race([closed, spawnError]);
    clearTimeout(timer);
    t.diagnostic(output.trim());
    assert.equal(timedOut, false, `Default SDK acceptance process timed out\n${output}`);
    assert.equal(exit.signal, null, output);
    assert.equal(exit.code, 0, output);
    for (const [name, count] of [['tests', 5], ['pass', 5], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]] as const) {
      assert.match(output, new RegExp(`^# ${name} ${count}\\r?$`, 'm'), `Missing required TAP count: ${name}=${count}\n${output}`);
    }
    const events = (await readFile(audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.event === 'network-attempt').length, 0, 'SDK chain must remain offline');
    assert.ok(new Set(events.filter((event) => event.event === 'guard-installed').map((event) => event.pid)).size >= 3,
      'SDK test process and independent replay processes must load the network guard');
  } finally {
    clearTimeout(timer);
    try { kill(); }
    finally {
      if (closed) await closed;
      await rm(root, { recursive: true, force: true });
    }
  }
});
