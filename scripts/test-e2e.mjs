import { spawn, spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const e2eDir = join(project, 'test', 'e2e')
const filters = process.argv.slice(2)
const names = (await readdir(e2eDir)).filter((name) => name.endsWith('.test.ts')).sort()
const selected = filters.length
  ? names.filter((name) => filters.some((filter) => name.includes(filter)))
  : names
if (selected.length === 0) {
  console.error(`No e2e files matched: ${filters.join(', ') || '(all)'}`)
  process.exit(1)
}

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
let provider
try {
  const config = JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8'))
  provider = config?.providers?.['openai-codex']
} catch (error) {
  console.error(`Cannot read ${join(agentDir, 'models.json')}: ${error.message}`)
  process.exit(1)
}
const apiKey = typeof provider?.apiKey === 'string' ? provider.apiKey : ''
const reference = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(apiKey)
const variable = reference?.[1] ?? reference?.[2]
if (!variable) {
  console.error(
    'openai-codex apiKey must be an environment reference such as $OPENAI_CODEX_OAUTH_TOKEN'
  )
  process.exit(1)
}
if (!process.env[variable]) {
  console.error(`Credential environment variable ${variable} is not set`)
  process.exit(1)
}

const pi = process.env.PI_E2E_PI ?? 'pi'
const version = spawnSync(pi, ['--version'], { encoding: 'utf8' })
if (version.status !== 0) {
  console.error(`Pi CLI is not runnable: ${version.stderr?.trim() || pi}`)
  process.exit(1)
}

console.log(
  `Real-model e2e: pi ${version.stdout.trim()}, provider openai-codex, ` +
    `models gpt-6.1-terra/gpt-6-luna, ${selected.length} file(s)`
)
console.log(`Files: ${selected.join(', ')}`)
let child
let interrupted = false
const interrupt = () => {
    interrupted = true
    child?.kill('SIGINT')
  },
  terminate = () => {
    interrupted = true
    child?.kill('SIGTERM')
  }
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
try {
  for (const name of selected) {
    if (interrupted) {
      break
    }
    // Node 22 bounds the whole file; Skills A/B has six eight-minute pairs.
    const timeout = name === 'skills-context.test.ts' ? 3_000_000 : 300_000
    child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', `--test-timeout=${timeout}`, join(e2eDir, name)],
      {
        cwd: project,
        stdio: 'inherit',
        env: { ...process.env, PI_E2E: '1' }
      }
    )
    // oxlint-disable-next-line no-await-in-loop -- Keep real-model files and their budgets sequential.
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode) => resolve(exitCode ?? 1))
    })
    if (interrupted || code !== 0) {
      process.exitCode = code || 1
    }
  }
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
}
