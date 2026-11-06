import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSdkTest } from './prepare-sdk-test.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pi-task-sdk-'));
try {
  const sdk = await prepareSdkTest(root);
  const loader = new URL('../test/fixtures/sdk-resource-snapshot/loader.mjs', import.meta.url).href;
  const files = (await readdir(join(project, 'test'))).filter(name => name.endsWith('.test.ts')).sort();
  const child = spawn(process.execPath, ['--test', ...files.map(name => join(project, 'test', name))], {
    cwd: project, stdio: 'inherit', env: { ...process.env, PI_TASK_AGENTS_TEST_SDK_ROOT: sdk,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + loader].filter(Boolean).join(' ') },
  });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
} finally { await rm(root, { recursive: true, force: true }); }
