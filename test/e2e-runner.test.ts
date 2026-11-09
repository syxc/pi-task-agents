import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execute = promisify(execFile)

test('E2E runner completes long Skills files and preserves failures and filters', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-e2e-runner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scripts = join(root, 'scripts')
  const cases = join(root, 'test', 'e2e')
  const agentDir = join(root, 'agent')
  await Promise.all([mkdir(scripts), mkdir(cases, { recursive: true }), mkdir(agentDir)])
  const runner = join(scripts, 'test-e2e.mjs')
  await copyFile(fileURLToPath(new URL('../scripts/test-e2e.mjs', import.meta.url)), runner)
  const marker = join(root, 'completed.txt')
  const preload = join(root, 'scale-timeouts.mjs')
  await Promise.all([
    writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({ providers: { 'openai-codex': { apiKey: '$E2E_RUNNER_AUTH' } } })
    ),
    // Scale the deadlines, not the runner decisions or Node's process isolation.
    writeFile(
      preload,
      `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => spawn(command,
  args.includes('--test') ? args.map(arg => arg.startsWith('--test-timeout=')
    ? '--test-timeout=' + Math.ceil(Number(arg.split('=')[1]) / 150) : arg) : args,
  options);
syncBuiltinESMExports();`
    ),
    writeFile(
      join(cases, 'a-failure.test.ts'),
      `import test from 'node:test';
import { appendFileSync } from 'node:fs';
test('controlled failure', () => {
  appendFileSync(process.env.E2E_RUNNER_MARKER, 'failed\\n');
  throw new Error('controlled failure');
});`
    ),
    // Child fake timers cannot advance Node 22's parent-process file deadline.
    writeFile(
      join(cases, 'skills-context.test.ts'),
      `import test from 'node:test';
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
for (const name of ['skill-one', 'skill-two']) {
  test(name, { timeout: 10000 }, async () => {
    await setTimeout(1250);
    appendFileSync(process.env.E2E_RUNNER_MARKER, name + '\\n');
  });
}`
    ),
    writeFile(
      join(cases, 'z-success.test.ts'),
      `import test from 'node:test';
import { appendFileSync } from 'node:fs';
test('later file', () => appendFileSync(process.env.E2E_RUNNER_MARKER, 'last\\n'));`
    )
  ])
  const options = {
    cwd: root,
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_E2E_PI: process.execPath,
      E2E_RUNNER_AUTH: 'offline-fixture',
      E2E_RUNNER_MARKER: marker,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`
    }
  }
  await assert.rejects(execute(process.execPath, [runner], options), { code: 1 })
  assert.equal(await readFile(marker, 'utf8'), 'failed\nskill-one\nskill-two\nlast\n')

  await writeFile(marker, '')
  await execute(process.execPath, [runner, 'z-success'], options)
  assert.equal(await readFile(marker, 'utf8'), 'last\n')
})
