import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const files = (await readdir(join(project, 'test')))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
const child = spawn(
  process.execPath,
  ['--test', ...files.map((name) => join(project, 'test', name))],
  {
    cwd: project,
    stdio: 'inherit',
    env: process.env
  }
)
const interrupt = () => child.kill('SIGINT'),
  terminate = () => child.kill('SIGTERM')
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
}
