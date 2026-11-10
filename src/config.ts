import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentProfile, ConfigLoadOptions, TaskAgentsConfig } from './types.ts'
import { isResourceName, isUnavailablePath, sameFile, within } from './resource-selection.ts'
import { DEFAULT_MAX_CONCURRENCY, resolveMaxConcurrency } from './concurrency.ts'
import { isThinkingLevel, thinkingLevels } from './thinking.ts'

export { thinkingLevels } from './thinking.ts'

type RoleOptions = { -readonly [K in keyof Omit<AgentProfile, 'name'>]?: AgentProfile[K] }
type RoleInput = Omit<RoleOptions, 'thinking'> & { thinking?: string }

interface ParsedConfig {
  maxConcurrency?: number
  roles: Record<string, RoleOptions>
}

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const builtins: readonly string[] = ['explore', 'worker', 'verifier', 'mavis']
const readTools: readonly string[] = ['read', 'grep', 'find', 'ls']
const roleKeys: readonly string[] = [
  'model',
  'thinking',
  'effort',
  'instructions',
  'tools',
  'extensions',
  'skills',
  'mcp',
  'mcpServers',
  'disallowedTools',
  'timeoutMs'
]
const taskKeys: readonly string[] = [
  'agent_name',
  'model',
  'effort',
  'prompt',
  'description',
  'run_in_background',
  'skills'
]

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key)
}

function fail(path: string, message: string): never {
  throw new Error(path + ': ' + message)
}

function object(
  value: unknown,
  path: string,
  keys?: readonly string[]
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(path, 'expected an object')
  }
  if (keys) {
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        fail(path + '.' + key, 'unknown key')
      }
    }
  }
}

function text(value: unknown, path: string, empty: boolean = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim())) {
    fail(path, 'expected a string' + (empty ? '' : ' that is not empty'))
  }
}

function integer(value: unknown, path: string, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, 'expected an integer from ' + min + ' to ' + max)
  }
}

function model(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/]+(?:\/[^\s/]+)*$/.test(value)
  ) {
    fail(
      path,
      'expected provider/id (no whitespace or empty segments); models are never substituted'
    )
  }
}

function strings(value: unknown, path: string, unique = true): asserts value is string[] {
  if (!Array.isArray(value)) {
    fail(path, 'expected an array of strings')
  }
  value.forEach((item: unknown, index: number) => text(item, path + '[' + index + ']'))
  if (unique && new Set(value).size !== value.length) {
    fail(path, 'duplicate entries are not allowed')
  }
}

function roleName(value: string, path: string, request = false): string {
  const requested = value.trim()
  const explicit = /^agent:/i.test(requested)
  const name = explicit ? requested.slice(6) : requested
  // Custom names remain explicit even when they collide with a builtin role.
  if (
    !name ||
    name !== name.trim() ||
    name.length > 64 ||
    // oxlint-disable-next-line no-control-regex -- Reject control characters in role names intentionally.
    /[/\\\\\u0000-\u001F\u007F]/u.test(name) ||
    ['.', '..'].includes(name) ||
    name.endsWith('.') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)
  ) {
    fail(path, 'invalid role name')
  }
  const canonical = name.toLowerCase() === 'main' ? 'mavis' : name.toLowerCase()
  if (request && !explicit && builtins.includes(canonical)) {
    return canonical
  }
  return !explicit && builtins.includes(name) ? name : 'agent:' + name
}

function checkRole(role: unknown, path: string): asserts role is RoleInput {
  object(role, path, roleKeys)
  if (role.model !== undefined) {
    model(role.model, path + '.model')
  }
  if (role.thinking !== undefined) {
    text(role.thinking, path + '.thinking')
  }
  if (role.effort !== undefined) {
    text(role.effort, path + '.effort')
  }
  for (const key of ['thinking', 'effort']) {
    if (typeof role[key] === 'string' && !isThinkingLevel(role[key].trim())) {
      fail(path + '.' + key, 'expected a Pi thinking level: ' + thinkingLevels.join(', '))
    }
  }
  if (
    typeof role.thinking === 'string' &&
    typeof role.effort === 'string' &&
    role.thinking.trim() !== role.effort.trim()
  ) {
    fail(path, 'thinking and effort conflict')
  }
  if (own(role, 'instructions')) {
    text(role.instructions, path + '.instructions', true)
  }
  const tools = own(role, 'tools') ? role.tools : []
  strings(tools, path + '.tools', false)
  for (const key of ['extensions', 'skills', 'mcpServers', 'disallowedTools']) {
    if (own(role, key)) {
      strings(role[key], path + '.' + key, key === 'extensions')
    }
  }
  if (own(role, 'mcp') && typeof role.mcp !== 'boolean') {
    fail(path + '.mcp', 'expected a boolean')
  }
  if (own(role, 'timeoutMs')) {
    integer(role.timeoutMs, path + '.timeoutMs', 0, 2147483647)
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach((child: unknown) => freeze(child))
    Object.freeze(value)
  }
  return value
}

async function resourcePaths(
  paths: readonly string[],
  file: string,
  key: string
): Promise<string[]> {
  const result: string[] = []
  const root = await realpath(pluginRoot)
  for (const path of paths) {
    if (isResourceName(path)) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Preserve configuration order and stop at the first invalid resource.
        await stat(resolve(dirname(file), path))
      } catch (error) {
        if (!isUnavailablePath(error)) {
          throw error
        }
        result.push(path)
        continue
      }
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(path) || path.startsWith('~') || /[*?{}]/.test(path)) {
      fail(
        file + '.' + key,
        'resources require explicit local paths, not packages, URLs, or patterns'
      )
    }
    let actual: string
    try {
      // oxlint-disable-next-line no-await-in-loop -- Preserve configuration order and stop at the first invalid resource.
      actual = await realpath(resolve(dirname(file), path))
    } catch {
      fail(file + '.' + key, 'resource path must exist: ' + path)
    }
    // Canonical paths prevent symlink aliases from loading this plugin into a child.
    if (within(root, actual)) {
      fail(file + '.' + key, 'the task plugin cannot load itself in a child')
    }
    // oxlint-disable-next-line no-await-in-loop -- Preserve configuration order and stop at the first invalid resource.
    const info = await stat(actual)
    if (key.endsWith('.extensions') && (!info.isFile() || !/\.(?:[cm]?js|ts)$/.test(actual))) {
      fail(
        file + '.' + key,
        'extensions require explicit local JavaScript or TypeScript entry files'
      )
    }
    if (!info.isFile() && !info.isDirectory()) {
      fail(file + '.' + key, 'expected a regular file or directory')
    }
    if (result.includes(actual)) {
      if (key.endsWith('.skills')) {
        continue
      }
      fail(file + '.' + key, 'duplicate resource paths are not allowed')
    }
    result.push(actual)
  }
  return result
}

async function readConfig(file: string): Promise<ParsedConfig | undefined> {
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (isUnavailablePath(error)) {
      return
    }
    throw error
  }
  let config: unknown
  try {
    config = JSON.parse(content)
  } catch {
    fail(file, 'invalid JSON')
  }
  object(config, file, ['maxConcurrency', 'roles'])
  let maxConcurrency: number | undefined
  if (own(config, 'maxConcurrency')) {
    maxConcurrency = resolveMaxConcurrency(config.maxConcurrency, file + '.maxConcurrency')
  }
  if (own(config, 'roles')) {
    object(config.roles, file + '.roles')
  }
  const roles: Record<string, RoleOptions> = Object.create(null)
  const configuredRoles = config.roles ?? {}
  object(configuredRoles, file + '.roles')
  for (const [key, value] of Object.entries(configuredRoles)) {
    const name = roleName(key, file + '.roles.' + key)
    if (own(roles, name)) {
      fail(file + '.roles.' + key, 'duplicate normalized role name: ' + name)
    }
    checkRole(value, file + '.roles.' + key)
    const rawEffort = value.effort ?? value.thinking
    const override: RoleOptions = {
      ...value,
      thinking: undefined,
      ...(rawEffort === undefined ? {} : { effort: rawEffort.trim() })
    }
    for (const resource of ['extensions', 'skills'] as const) {
      const paths = value[resource]
      if (own(value, resource) && paths !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- Preserve configuration order and stop at the first invalid resource.
        override[resource] = await resourcePaths(paths, file, 'roles.' + key + '.' + resource)
      }
    }
    roles[name] = override
  }
  return { ...(maxConcurrency === undefined ? {} : { maxConcurrency }), roles }
}

function mergeRole(base: AgentProfile, override: RoleOptions): AgentProfile {
  return {
    ...base,
    ...override,
    instructions: [base.instructions, override.instructions].filter(Boolean).join('\n\n')
  }
}

function checkEffective(role: AgentProfile, name: string): void {
  const {
    name: _ignored,
    initialSkills,
    skillSnapshot,
    nativeToolSnapshot,
    toolInventory,
    ...options
  } = role
  checkRole(
    role.effort === undefined ? options : { ...options, thinking: undefined },
    'roles.' + name
  )
  for (const [field, value] of Object.entries({
    initialSkills,
    skillSnapshot,
    nativeToolSnapshot,
    toolInventory
  })) {
    if (value !== undefined) {
      strings(value, 'roles.' + name + '.' + field)
    }
  }
}

/**
 * Strict JSON schema: { maxConcurrency?: integer 1..10, roles?: Record<string, {
 * model?: provider/id, effort?: Pi thinking level, thinking?: legacy effort alias,
 * instructions?: string, tools?: string[], extensions?: (name|localPath)[],
 * skills?: (name|localPath)[], mcp?: boolean, mcpServers?: string[],
 * disallowedTools?: string[], timeoutMs?: integer 0..2147483647
 * }> }. Unknown keys and duplicate normalized role names fail. Selector arrays
 * allow duplicates and match exact normalized names; they are not wildcard patterns.
 *
 * Builtin bare keys override builtins; every other key defines an agent:<name>.
 * agent:worker is independent of builtin worker. Custom roles inherit mavis defaults.
 * Layers: defaults < global < trusted project. Instructions append; other fields
 * replace. Paths must exist and are relative to their declaring config file.
 * Project trust allows explicit capability changes. Bash, MCP, and executable
 * extensions are not sandboxed; the parent remains responsible for their effects.
 * Credentials and parent runtime settings are never read or copied here.
 */
export async function loadConfig({
  cwd,
  agentDir,
  projectTrusted = false
}: Partial<ConfigLoadOptions> = {}): Promise<TaskAgentsConfig> {
  text(cwd, 'cwd')
  text(agentDir, 'agentDir')
  if (typeof projectTrusted !== 'boolean') {
    fail('projectTrusted', 'expected a boolean')
  }
  const roles: Record<string, AgentProfile> = Object.create(null)
  const prompts = await Promise.all(
    builtins.map((name: string) =>
      readFile(new URL('../prompts/' + name + '.md', import.meta.url), 'utf8')
    )
  )
  builtins.forEach((name: string, index: number) => {
    roles[name] = {
      name,
      instructions: prompts[index].trim(),
      tools: [
        ...readTools,
        'bash',
        ...(['worker', 'mavis'].includes(name) ? ['edit', 'write'] : [])
      ],
      timeoutMs: 0
    }
  })
  // Snapshot the generic default so builtin overrides cannot implicitly grant
  // capabilities to new custom roles.
  const customBase: AgentProfile = { ...roles.mavis }
  const result: {
    cwd: string
    agentDir: string
    maxConcurrency: number
    roles: Record<string, AgentProfile>
    diagnostics: string[]
    sources: string[]
  } = {
    cwd: resolve(cwd),
    agentDir: resolve(agentDir),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    roles,
    diagnostics: [] as string[],
    sources: [] as string[]
  }
  const globalFile = resolve(agentDir, 'task-agents.json')
  const projectFile = resolve(cwd, '.pi/task-agents.json')
  // File identity covers aliases in either the filename or an ancestor directory.
  const aliased = await sameFile(globalFile, projectFile)
  // An untrusted alias is skipped entirely; a trusted alias is one configuration layer, not two.
  const files = [
    ...(!aliased || projectTrusted ? [globalFile] : []),
    ...(projectTrusted && !aliased ? [projectFile] : [])
  ]
  for (const file of new Set(files)) {
    // oxlint-disable-next-line no-await-in-loop -- Preserve configuration order and stop at the first invalid resource.
    const config = await readConfig(file)
    if (!config) {
      continue
    }
    result.sources.push(file)
    if (config.maxConcurrency !== undefined) {
      result.maxConcurrency = config.maxConcurrency
    }
    for (const [name, override] of Object.entries(config.roles)) {
      roles[name] = mergeRole(roles[name] ?? { ...customBase, name }, override)
    }
  }
  if (!projectTrusted) {
    try {
      await lstat(projectFile)
      result.diagnostics.push(
        'Untrusted project configuration ignored: ' +
          projectFile +
          '. Set projectTrusted: true only after reviewing its instructions, tools, extensions, skills, and MCP access.'
      )
    } catch (error: unknown) {
      if (!isUnavailablePath(error)) {
        throw error
      }
    }
  }
  for (const [name, role] of Object.entries(roles)) {
    checkEffective(role, name)
    if (
      ['explore', 'verifier'].includes(name) &&
      (role.mcp === true || (role.extensions?.length ?? 0) > 0)
    ) {
      result.diagnostics.push(
        'Read-only role ' +
          name +
          ' has Bash and may inherit trusted MCP or extensions; ' +
          'these are not a sandbox. Read-only instructions and host permission gates still apply.'
      )
    }
  }
  return freeze(result)
}

/** Resolve task input into an independent, deeply frozen effective profile. */
export function resolveProfile(config: TaskAgentsConfig, input: unknown): AgentProfile {
  object(input, 'input', taskKeys)
  text(input.agent_name, 'input.agent_name')
  const name = roleName(input.agent_name, 'input.agent_name', true)
  if (!config?.roles || !own(config.roles, name)) {
    fail('input.agent_name', 'unknown role: ' + name)
  }
  let requestedModel: string | undefined
  if (own(input, 'model')) {
    model(input.model, 'input.model')
    requestedModel = input.model
  }
  let requestedEffort: string | undefined
  if (own(input, 'effort')) {
    text(input.effort, 'input.effort')
    requestedEffort = input.effort.trim()
    if (!isThinkingLevel(requestedEffort)) {
      fail('input.effort', 'expected a Pi thinking level')
    }
  }
  for (const key of ['prompt', 'description']) {
    if (own(input, key)) {
      text(input[key], 'input.' + key, true)
    }
  }
  if (own(input, 'run_in_background') && typeof input.run_in_background !== 'boolean') {
    fail('input.run_in_background', 'expected a boolean')
  }
  let initialSkills: string[] | undefined
  if (own(input, 'skills')) {
    if (
      !Array.isArray(input.skills) ||
      input.skills.some((skillName) => typeof skillName !== 'string')
    ) {
      fail('input.skills', 'expected an array of Skill names')
    }
    initialSkills = [
      ...new Set(input.skills.map((skillName) => skillName.trim().normalize('NFKC')))
    ]
    if (
      initialSkills.some(
        (skillName) =>
          !skillName ||
          skillName === '.' ||
          skillName === '..' ||
          skillName.includes('/') ||
          skillName.includes('\\') ||
          skillName.includes(':')
      )
    ) {
      fail('input.skills', 'expected nonempty Skill names, not paths')
    }
  }
  const base = config.roles[name]
  const profile: AgentProfile = {
    ...base,
    model: requestedModel ?? base.model,
    effort: requestedEffort ?? (requestedModel ? undefined : base.effort),
    thinking: requestedEffort !== undefined || requestedModel ? undefined : base.thinking,
    tools: [...base.tools],
    ...(initialSkills !== undefined ? { initialSkills } : {}),
    ...(base.extensions ? { extensions: [...base.extensions] } : {}),
    ...(base.skills ? { skills: [...base.skills] } : {}),
    ...(base.mcpServers ? { mcpServers: [...base.mcpServers] } : {}),
    ...(base.disallowedTools ? { disallowedTools: [...base.disallowedTools] } : {})
  }
  checkEffective(profile, name)
  return freeze(profile)
}
