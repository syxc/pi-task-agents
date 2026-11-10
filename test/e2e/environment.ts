import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TestOptions } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PiRpc } from './rpc.ts'
import { isRecord, type JsonRecord } from './support.ts'

/** Real-model e2e coverage is opt-in; the offline suite must never spend tokens. */
export const E2E_ENABLED = process.env.PI_E2E === '1'

export const e2eOptions = (timeout: number): TestOptions => ({
  skip: E2E_ENABLED ? false : 'set PI_E2E=1 to run real-model e2e',
  timeout
})

export const E2E_PROVIDER = 'openai-codex'
export const E2E_TERRA = 'gpt-6.1-terra'
export const E2E_LUNA = 'gpt-6-luna'

const APPROVED_MODELS = new Set([E2E_TERRA, E2E_LUNA])
const EXTENSION_PATH = fileURLToPath(new URL('../../src/extension.ts', import.meta.url))
const BUILTIN_ROLES = ['explore', 'worker', 'verifier', 'mavis'] as const

export interface SkillFixture {
  name: string
  description: string
  instructions: string
}

export interface EnvironmentOptions {
  /** Parent model id; defaults to luna. */
  parentModel?: string
  /** Child role model id; null keeps roles unset so children inherit the parent model. */
  childModel?: string | null
  /** Parent and inherited-child thinking; existing scenarios keep their off default. */
  parentThinking?: 'off' | 'high'
  maxConcurrency?: number
  skills?: readonly SkillFixture[]
  sessionId?: string
}

export interface SpawnOptions {
  sessionId?: string
  model?: string
}

export interface E2EEnvironment {
  root: string
  home: string
  agentDir: string
  workspace: string
  sessionsDir: string
  spawnRpc(options?: SpawnOptions): Promise<PiRpc>
  dispose(): Promise<void>
}

function credentialVariable(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value)
  if (braced?.[1]) {
    return braced[1]
  }
  return /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(value)?.[1]
}

function approvedModel(model: string): string {
  if (!APPROVED_MODELS.has(model)) {
    throw new Error(
      `E2E model ${model} is not approved. Use one of: ${[...APPROVED_MODELS].join(', ')}`
    )
  }
  return model
}

async function prepareModels(agentDir: string): Promise<void> {
  const source = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'))
  const file = join(source, 'models.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(
      `Cannot read Pi model configuration at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.providers) ||
    !isRecord(parsed.providers[E2E_PROVIDER])
  ) {
    throw new Error(`Pi model configuration has no ${E2E_PROVIDER} provider`)
  }
  const provider = parsed.providers[E2E_PROVIDER]
  const variable = credentialVariable(provider.apiKey)
  if (!variable) {
    throw new Error(
      `${E2E_PROVIDER} apiKey must be an environment reference (for example $OPENAI_CODEX_OAUTH_TOKEN)`
    )
  }
  if (!process.env[variable]) {
    throw new Error(`Credential environment variable ${variable} is not set`)
  }
  if (!Array.isArray(provider.models)) {
    throw new TypeError(`${E2E_PROVIDER} provider has no model list`)
  }
  const filtered = provider.models.filter(
    (model) => isRecord(model) && typeof model.id === 'string' && APPROVED_MODELS.has(model.id)
  )
  if (filtered.length !== APPROVED_MODELS.size) {
    throw new Error(`Pi model configuration must include ${[...APPROVED_MODELS].join(' and ')}`)
  }
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({ providers: { [E2E_PROVIDER]: { ...provider, models: filtered } } }),
    { mode: 0o600 }
  )
}

async function prepareSettings(agentDir: string): Promise<void> {
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: 'off'
    })
  )
}

async function prepareConfig(
  agentDir: string,
  childModel: string | null,
  maxConcurrency: number | undefined
): Promise<void> {
  const config: JsonRecord = {}
  if (maxConcurrency !== undefined) {
    config.maxConcurrency = maxConcurrency
  }
  if (childModel !== null) {
    const model = `${E2E_PROVIDER}/${childModel}`
    config.roles = Object.fromEntries(BUILTIN_ROLES.map((role) => [role, { model }]))
  }
  if (Object.keys(config).length > 0) {
    await writeFile(join(agentDir, 'task-agents.json'), JSON.stringify(config))
  }
}

async function prepareSkills(agentDir: string, skills: readonly SkillFixture[]): Promise<void> {
  await Promise.all(
    skills.map(async (skill) => {
      const dir = join(agentDir, 'skills', skill.name)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'SKILL.md'),
        [
          '---',
          `name: ${skill.name}`,
          `description: ${skill.description}`,
          '---',
          '',
          skill.instructions,
          ''
        ].join('\n')
      )
    })
  )
}

export async function createEnvironment(options: EnvironmentOptions = {}): Promise<E2EEnvironment> {
  const parentModel = approvedModel(options.parentModel ?? E2E_LUNA)
  const childModel =
    options.childModel === undefined
      ? E2E_LUNA
      : options.childModel === null
        ? null
        : approvedModel(options.childModel)
  const root = await mkdtemp(join(tmpdir(), 'pi-task-e2e-'))
  const home = join(root, 'home')
  const agentDir = join(root, 'agent')
  const workspace = join(root, 'workspace')
  const sessionsDir = join(root, 'sessions')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(sessionsDir, { recursive: true })
  ])
  await prepareModels(agentDir)
  await prepareSettings(agentDir)
  await prepareConfig(agentDir, childModel, options.maxConcurrency)
  await prepareSkills(agentDir, options.skills ?? [])
  const clients = new Set<PiRpc>()
  const baseSessionId = options.sessionId ?? 'e2e-main'
  const skillsEnabled = (options.skills?.length ?? 0) > 0

  const environment: E2EEnvironment = {
    root,
    home,
    agentDir,
    workspace,
    sessionsDir,
    async spawnRpc(spawnOptions: SpawnOptions = {}): Promise<PiRpc> {
      const model = approvedModel(spawnOptions.model ?? parentModel)
      const args = [
        '--mode',
        'rpc',
        '--no-extensions',
        '-e',
        EXTENSION_PATH,
        '--no-prompt-templates',
        '--no-context-files',
        '--no-themes',
        '--no-mcp',
        ...(skillsEnabled ? [] : ['--no-skills']),
        '--provider',
        E2E_PROVIDER,
        '--model',
        model,
        '--thinking',
        options.parentThinking ?? 'off',
        '--session-dir',
        sessionsDir,
        '--session-id',
        spawnOptions.sessionId ?? baseSessionId,
        '--approve'
      ]
      const client = new PiRpc({
        command: process.env.PI_E2E_PI ?? 'pi',
        args,
        cwd: workspace,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          TERM: 'dumb',
          NO_COLOR: '1'
        }
      })
      clients.add(client)
      try {
        await client.start()
      } catch (error) {
        clients.delete(client)
        await client.stop()
        throw error
      }
      return client
    },
    async dispose(): Promise<void> {
      const active = [...clients]
      clients.clear()
      try {
        await Promise.all(active.map(async (client) => client.stop()))
      } finally {
        if (process.env.PI_E2E_KEEP === '1') {
          console.error(`[e2e] kept environment at ${root}`)
        } else {
          await rm(root, { recursive: true, force: true, maxRetries: 2 })
        }
      }
    }
  }
  return environment
}
