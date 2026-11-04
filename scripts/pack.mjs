import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--ignore-scripts', '--pack-destination', 'artifacts'], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
