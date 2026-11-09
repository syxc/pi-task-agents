import test, { type TestContext } from 'node:test'
import type { AgentProfile, TaskAgentsConfig } from '../src/types.ts'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveProfile } from '../src/config.ts'
import { childToolPolicy, roleAllowsTool, sameFile } from '../src/resource-selection.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const readonly = ['read', 'grep', 'find', 'ls']
const roleTools = (name: string) => [
  ...readonly,
  'bash',
  ...(['worker', 'mavis'].includes(name) ? ['edit', 'write'] : [])
]

async function setup(t: TestContext) {
  // Keep fixture resources outside the plugin: children must never load the plugin itself.
  const dir = await mkdtemp(
    fileURLToPath(new URL('../../.task-agents-config-test-', import.meta.url))
  )
  const cwd = join(dir, 'project')
  const agentDir = join(dir, 'agent')
  await Promise.all([mkdir(join(cwd, '.pi'), { recursive: true }), mkdir(agentDir)])
  t.after(() => rm(dir, { recursive: true, force: true }))
  return {
    dir,
    cwd,
    agentDir,
    global: join(agentDir, 'task-agents.json'),
    project: join(cwd, '.pi/task-agents.json')
  }
}

const save = (path: string, value: unknown): Promise<void> => writeFile(path, JSON.stringify(value))
const profile = (
  config: TaskAgentsConfig,
  agent_name: string,
  input: Record<string, unknown> = {}
): AgentProfile => resolveProfile(config, { agent_name, ...input })

function assertFrozen(value: unknown): void {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value))
    Object.values(value).forEach(assertFrozen)
  }
}

test('missing configuration inherits models/resources and selects native Pi tools', async (t) => {
  const paths = await setup(t)
  const config = await loadConfig(paths)
  assert.equal(config.maxConcurrency, 4)
  assert.equal(Object.hasOwn(config, 'maxConcurrency'), true)
  assert.deepEqual(config.sources, [])
  assert.deepEqual(config.diagnostics, [])
  assert.deepEqual(Object.keys(config.roles), ['explore', 'worker', 'verifier', 'mavis'])
  for (const name of ['explore', 'worker', 'verifier', 'mavis']) {
    const actual = profile(config, name)
    assert.equal(actual.name, name)
    assert.equal(actual.model, undefined)
    assert.equal(actual.thinking, undefined)
    assert.deepEqual(actual.tools, roleTools(name))
    assert.equal(actual.extensions, undefined)
    assert.equal(actual.skills, undefined)
    assert.equal(actual.mcp, undefined)
    assert.equal(actual.timeoutMs, 0)
    assert.match(actual.instructions, /## Delegated Task Contract/)
    assertFrozen(actual)
  }
  assertFrozen(config)
})

test('global and trusted project layers append instructions and replace explicit fields', async (t) => {
  const paths = await setup(t)
  await save(paths.global, {
    maxConcurrency: 2,
    roles: {
      worker: {
        model: 'vendor/global',
        thinking: 'low',
        instructions: 'Global note.',
        tools: ['read', 'bash'],
        timeoutMs: 500
      }
    }
  })
  await save(paths.project, {
    maxConcurrency: 6,
    roles: {
      worker: {
        model: 'vendor/project/model',
        instructions: 'Project note.',
        tools: ['read'],
        timeoutMs: 900
      }
    }
  })
  const config = await loadConfig({ ...paths, projectTrusted: true })
  const actual = profile(config, 'worker')
  assert.equal(config.maxConcurrency, 6)
  assert.deepEqual(config.sources, [paths.global, paths.project])
  assert.equal(actual.model, 'vendor/project/model')
  assert.equal(actual.effort, 'low')
  assert.equal(actual.thinking, undefined)
  assert.equal(actual.timeoutMs, 900)
  assert.deepEqual(actual.tools, ['read'])
  assert.match(actual.instructions, /Role: Worker/)
  assert.ok(actual.instructions.endsWith('Global note.\n\nProject note.'))
})

test('concurrency layers inherit defaults and global values without trusting project overrides', async (t) => {
  const paths = await setup(t)
  await save(paths.global, { roles: { worker: { instructions: 'Global role only.' } } })
  await save(paths.project, { roles: { worker: { instructions: 'Project role only.' } } })
  assert.equal((await loadConfig({ ...paths, projectTrusted: true })).maxConcurrency, 4)

  await save(paths.global, { maxConcurrency: 9 })
  assert.equal((await loadConfig({ ...paths, projectTrusted: true })).maxConcurrency, 9)
  await save(paths.project, { maxConcurrency: 2 })
  assert.equal((await loadConfig(paths)).maxConcurrency, 9)
  assert.equal((await loadConfig({ ...paths, projectTrusted: true })).maxConcurrency, 2)

  await save(paths.global, {})
  await save(paths.project, { maxConcurrency: 11 })
  const untrusted = await loadConfig(paths)
  assert.equal(untrusted.maxConcurrency, 4)
  assert.deepEqual(untrusted.sources, [paths.global])
  assert.match(untrusted.diagnostics[0], /Untrusted project configuration ignored/)
  await assert.rejects(
    loadConfig({ ...paths, projectTrusted: true }),
    /maxConcurrency: expected an integer from 1 to 10/
  )
})

test('legacy concurrency values fail their configuration layer instead of falling back', async (t) => {
  const paths = await setup(t)
  await save(paths.global, { maxConcurrency: 4 })
  await save(paths.project, { maxConcurrency: 10 })
  const trusted = { ...paths, projectTrusted: true }
  assert.equal((await loadConfig(trusted)).maxConcurrency, 10)

  /* oxlint-disable no-await-in-loop -- Check each layer before replacing the same configuration file. */
  for (const file of [paths.project, paths.global]) {
    for (const maxConcurrency of [11, 32, 64]) {
      await save(file, { maxConcurrency, roles: { worker: { tools: ['read'] } } })
      await assert.rejects(loadConfig(trusted), {
        message: file + '.maxConcurrency: expected an integer from 1 to 10'
      })
    }
    await save(file, { maxConcurrency: 10 })
    assert.equal((await loadConfig(trusted)).maxConcurrency, 10)
  }
  /* oxlint-enable no-await-in-loop */
})

test('untrusted project config is not parsed or executed and gets a clear diagnostic', async (t) => {
  const paths = await setup(t)
  await save(paths.global, { maxConcurrency: 3 })
  await writeFile(paths.project, '{ invalid and untrusted JSON')
  const config = await loadConfig(paths)
  assert.equal(config.maxConcurrency, 3)
  assert.deepEqual(config.sources, [paths.global])
  assert.equal(config.diagnostics.length, 1)
  assert.match(config.diagnostics[0], /Untrusted project configuration ignored/)
  assert.ok(config.diagnostics[0].includes(paths.project))
  await assert.rejects(loadConfig({ ...paths, projectTrusted: true }), /invalid JSON/)
})

test('an agentDir equal to project .pi cannot bypass project trust', async (t) => {
  const paths = await setup(t)
  await save(paths.project, { maxConcurrency: 8 })
  const options = { cwd: paths.cwd, agentDir: dirname(paths.project) }
  const untrusted = await loadConfig(options)
  assert.equal(untrusted.maxConcurrency, 4)
  assert.deepEqual(untrusted.sources, [])
  assert.equal(untrusted.diagnostics.length, 1)
  const trusted = await loadConfig({ ...options, projectTrusted: true })
  assert.equal(trusted.maxConcurrency, 8)
  assert.deepEqual(trusted.sources, [paths.project])
})

test('a symlink agentDir alias cannot load an untrusted project config', async (t) => {
  const paths = await setup(t)
  const alias = join(paths.dir, 'project-agent-alias')
  await symlink(dirname(paths.project), alias)
  await save(paths.project, { maxConcurrency: 17, roles: { worker: { tools: ['bash'] } } })
  const config = await loadConfig({ cwd: paths.cwd, agentDir: alias })
  assert.equal(config.maxConcurrency, 4)
  assert.deepEqual(profile(config, 'worker').tools, roleTools('worker'))
  assert.deepEqual(config.sources, [])
  assert.equal(config.diagnostics.length, 1)
  assert.ok(config.diagnostics[0].includes(paths.project))
  assert.match(config.diagnostics[0], /Untrusted project configuration ignored/)
  await writeFile(paths.project, '{ invalid and untrusted JSON')
  const invalid = await loadConfig({ cwd: paths.cwd, agentDir: alias })
  assert.equal(invalid.maxConcurrency, 4)
  assert.deepEqual(invalid.sources, [])
  assert.equal(invalid.diagnostics.length, 1)
})

test('a global config file symlink cannot alias an untrusted project config', async (t) => {
  const paths = await setup(t)
  await save(paths.project, { maxConcurrency: 17 })
  await symlink(paths.project, paths.global)
  const config = await loadConfig(paths)
  assert.equal(config.maxConcurrency, 4)
  assert.deepEqual(config.sources, [])
  assert.equal(config.diagnostics.length, 1)
})

test('a trusted project config aliased to the global file is merged once', async (t) => {
  const paths = await setup(t)
  await save(paths.global, {
    maxConcurrency: 3,
    roles: { worker: { instructions: 'Shared note.' } }
  })
  await symlink(paths.global, paths.project)
  const config = await loadConfig({ ...paths, projectTrusted: true })
  assert.equal(config.maxConcurrency, 3)
  assert.deepEqual(config.sources, [paths.global])
  assert.equal(profile(config, 'worker').instructions.match(/Shared note\./g)?.length, 1)
})

test('an agentDir alias preserves missing-file and dangling-symlink diagnostics', async (t) => {
  const paths = await setup(t)
  const alias = join(paths.dir, 'project-agent-alias')
  await symlink(dirname(paths.project), alias)
  const options = { cwd: paths.cwd, agentDir: alias }
  const missing = await loadConfig(options)
  assert.equal(missing.maxConcurrency, 4)
  assert.deepEqual(missing.sources, [])
  assert.deepEqual(missing.diagnostics, [])
  await symlink(join(paths.dir, 'missing.json'), paths.project)
  const dangling = await loadConfig(options)
  assert.equal(dangling.maxConcurrency, 4)
  assert.deepEqual(dangling.sources, [])
  assert.equal(dangling.diagnostics.length, 1)
  assert.ok(dangling.diagnostics[0].includes(paths.project))
})

test('a dangling untrusted config symlink is still reported', async (t) => {
  const paths = await setup(t)
  await symlink(join(paths.dir, 'missing.json'), paths.project)
  const config = await loadConfig(paths)
  assert.equal(config.diagnostics.length, 1)
})

test('a non-directory .pi entry cannot disable global configuration loading', async (t) => {
  const paths = await setup(t)
  await save(paths.global, { maxConcurrency: 7 })
  await rm(join(paths.cwd, '.pi'), { recursive: true })
  await writeFile(join(paths.cwd, '.pi'), 'not a directory')
  const untrusted = await loadConfig(paths)
  assert.equal(untrusted.maxConcurrency, 7)
  assert.deepEqual(untrusted.sources, [paths.global])
  assert.deepEqual(untrusted.diagnostics, [])
  const trusted = await loadConfig({ ...paths, projectTrusted: true })
  assert.equal(trusted.maxConcurrency, 7)
  assert.deepEqual(trusted.sources, [paths.global])
  assert.deepEqual(trusted.diagnostics, [])
})

test('alias detection treats unresolvable workspace paths as distinct files', async (t) => {
  const paths = await setup(t)
  const file = join(paths.dir, 'file')
  await writeFile(file, 'content')
  assert.equal(await sameFile(file, join(file, 'child')), false)
  const loop = join(paths.dir, 'loop.json')
  await symlink(loop, loop)
  assert.equal(await sameFile(loop, paths.dir), false)
})

test('an unresolvable project config symlink cannot disable global configuration loading', async (t) => {
  const paths = await setup(t)
  await save(paths.global, { maxConcurrency: 5 })
  await symlink(paths.project, paths.project)
  const untrusted = await loadConfig(paths)
  assert.equal(untrusted.maxConcurrency, 5)
  assert.deepEqual(untrusted.sources, [paths.global])
  assert.equal(untrusted.diagnostics.length, 1)
  assert.ok(untrusted.diagnostics[0].includes(paths.project))
  const trusted = await loadConfig({ ...paths, projectTrusted: true })
  assert.equal(trusted.maxConcurrency, 5)
  assert.deepEqual(trusted.sources, [paths.global])
  assert.deepEqual(trusted.diagnostics, [])
})

test('custom namespace preserves builtin collisions and custom roles have isolated generic defaults', async (t) => {
  const paths = await setup(t)
  await save(paths.global, {
    roles: {
      worker: { instructions: 'Builtin addition.' },
      'agent:worker': { instructions: 'Custom worker.' },
      researcher: { model: 'vendor/research', tools: ['read'] },
      mavis: { tools: ['read'], mcp: true }
    }
  })
  const config = await loadConfig(paths)
  assert.match(profile(config, 'worker').instructions, /Builtin addition/)
  assert.doesNotMatch(profile(config, 'worker').instructions, /Custom worker/)
  const custom = profile(config, 'agent:worker')
  assert.match(custom.instructions, /Custom worker/)
  assert.doesNotMatch(custom.instructions, /Builtin addition/)
  assert.equal(custom.name, 'agent:worker')
  assert.deepEqual(custom.tools, roleTools('mavis'))
  assert.equal(custom.mcp, undefined)
  assert.equal(profile(config, 'agent:researcher').model, 'vendor/research')
  assert.equal(profile(config, 'researcher').model, 'vendor/research')
  assert.throws(() => profile(config, 'agent:missing'), /unknown role/)
  assert.throws(() => profile(config, 'agent:explore'), /unknown role/)
})

test('input model and Pi thinking overrides produce independent frozen profiles', async (t) => {
  const paths = await setup(t)
  const config = await loadConfig(paths)
  for (const effort of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const actual = profile(config, 'worker', { model: 'custom-provider/model/version', effort })
    assert.equal(actual.model, 'custom-provider/model/version')
    assert.equal(actual.effort, effort)
    assert.equal(actual.thinking, undefined)
    assertFrozen(actual)
    assert.notEqual(actual.tools, config.roles.worker.tools)
    assert.throws(() => {
      ;(actual.tools as string[]).push('other')
    }, TypeError)
  }
  assert.equal(config.roles.worker.model, undefined)
  assert.equal(config.roles.worker.thinking, undefined)
  for (const model of [
    'bare',
    '/id',
    'provider/',
    'provider//id',
    'provider/id/',
    ' provider/id',
    'provider/id with spaces',
    '',
    null,
    5
  ]) {
    assert.throws(() => profile(config, 'worker', { model }), /expected provider\/id/)
  }
  for (const effort of ['', ' \t', null, 5]) {
    assert.throws(() => profile(config, 'worker', { effort }), /expected a string/)
  }
  for (const effort of ['on', 'light', 'ULTRA']) {
    assert.throws(() => profile(config, 'worker', { effort }), /Pi thinking level/)
  }
  assert.throws(
    () => resolveProfile(config, { agent_name: 'worker', tools: ['write'] }),
    /unknown key/
  )
  assert.throws(
    () => resolveProfile(config, { agent_name: 'worker', run_in_background: 1 }),
    /expected a boolean/
  )
  assert.deepEqual(
    resolveProfile(config, { agent_name: 'worker', skills: ['  Ａ ', 'A', 'B'] }).initialSkills,
    ['A', 'B']
  )
  for (const skills of [null, [''], ['../escape'], ['..'], ['C:skill'], ['skill\\path']]) {
    assert.throws(() => resolveProfile(config, { agent_name: 'worker', skills }), /input\.skills/)
  }
  assert.throws(
    () => resolveProfile(config, { agent_name: 'worker', prompt: 5 }),
    /expected a string/
  )
  assert.throws(() => resolveProfile(config, {}), /agent_name/)
})

test('strict JSON schema rejects unknown keys, wrong types, invalid names, and integer boundaries', async (t) => {
  const paths = await setup(t)
  const cases: Array<[unknown, RegExp]> = [
    [null, /expected an object/],
    [[], /expected an object/],
    [{ maxConcurency: 2 }, /unknown key/],
    [{ auth: {} }, /unknown key/],
    ...[0, 11, 64, 65, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4', null].map(
      (maxConcurrency): [unknown, RegExp] => [{ maxConcurrency }, /expected an integer/]
    ),
    [{ roles: [] }, /expected an object/],
    [{ roles: { 'agent:': {} } }, /invalid role name/],
    [{ roles: { 'bad/name': {} } }, /invalid role name/],
    [{ roles: { CON: {} } }, /invalid role name/],
    [{ roles: { worker: null } }, /expected an object/],
    [{ roles: { worker: { effort: '' } } }, /expected a string/],
    [{ roles: { worker: { model: 'invalid' } } }, /provider\/id/],
    [{ roles: { worker: { thinking: 3 } } }, /expected a string/],
    [{ roles: { worker: { instructions: [] } } }, /expected a string/],
    [{ roles: { worker: { tools: 'read' } } }, /expected an array/],
    [{ roles: { worker: { tools: ['read', 3] } } }, /expected a string/],
    [{ roles: { worker: { extensions: [null] } } }, /expected a string/],
    [{ roles: { worker: { skills: {} } } }, /expected an array/],
    [{ roles: { worker: { mcp: {} } } }, /expected a boolean/],
    ...[-1, 2147483648, 2.5, '100', null].map((timeoutMs): [unknown, RegExp] => [
      { roles: { worker: { timeoutMs } } },
      /expected an integer/
    ]),
    [{ roles: { researcher: {}, 'agent:researcher': {} } }, /duplicate normalized role name/]
  ]
  /* oxlint-disable no-await-in-loop -- Cases overwrite the same config file; save, load and assert in order. */
  for (const [value, error] of cases) {
    await save(paths.global, value)
    await assert.rejects(loadConfig(paths), error, JSON.stringify(value))
  }
  /* oxlint-enable no-await-in-loop */
  /* oxlint-disable no-await-in-loop -- Cases overwrite the same config file; save, load and assert in order. */
  for (const [maxConcurrency, timeoutMs] of [
    [1, 0],
    [10, 2147483647]
  ]) {
    await save(paths.global, {
      maxConcurrency,
      roles: { worker: { timeoutMs, thinking: 'xhigh' } }
    })
    const config = await loadConfig(paths)
    assert.equal(config.maxConcurrency, maxConcurrency)
    assert.equal(config.roles.worker.timeoutMs, timeoutMs)
  }
  /* oxlint-enable no-await-in-loop */
  await assert.rejects(
    loadConfig({ ...paths, projectTrusted: 'true' as unknown as boolean }),
    /expected a boolean/
  )
})

test('trusted project schema is just as strict as global schema', async (t) => {
  const paths = await setup(t)
  await save(paths.project, { roles: { worker: { unknown: true } } })
  await assert.rejects(loadConfig({ ...paths, projectTrusted: true }), /unknown key/)
})

test('selectors do not grant readonly mutation, delegation, or wildcard expansion', async (t) => {
  const paths = await setup(t)
  /* oxlint-disable no-await-in-loop -- Cases overwrite the same config file; save, load and assert in order. */
  for (const name of ['explore', 'verifier', 'worker', 'mavis', 'agent:custom']) {
    const tools = ['write', 'edit', 'task', 'task_append', 'mcp__server__task', '*', 'mcp__*']
    await save(paths.global, { roles: { [name]: { tools } } })
    const selected = profile(await loadConfig(paths), name)
    const allows = childToolPolicy(selected, selected.tools)
    assert.equal(allows('task'), false)
    assert.equal(allows('task_append'), false)
    assert.equal(allows('mcp__server__task'), true)
    assert.equal(allows('read'), false)
    assert.equal(allows('mcp__server__read'), false)
    if (['explore', 'verifier'].includes(name)) {
      assert.equal(allows('write'), false)
      assert.equal(allows('edit'), false)
    }
  }
  /* oxlint-enable no-await-in-loop */
})

test('parent task controls remain unavailable and MCP business names are not overblocked', () => {
  for (const name of [
    'task',
    'task_append',
    'task_send',
    'task_query',
    'task_output',
    'task_stop',
    'task_agents',
    'subagent'
  ]) {
    assert.equal(roleAllowsTool('worker', name), false, name)
  }
  for (const name of [
    'task_update',
    'subagent_status',
    'mcp__tracker__task',
    'mcp__tracker__task_update'
  ]) {
    assert.equal(roleAllowsTool('worker', name), true, name)
  }
  const selected = {
    name: 'verifier',
    instructions: 'Owned selector fixture',
    tools: ['read'],
    timeoutMs: 0
  }
  const allow = childToolPolicy(
    selected,
    selected.tools,
    new Set(['write', 'edit', 'task_query', 'search_docs'])
  )
  for (const name of ['write', 'edit', 'task_query']) {
    assert.equal(allow(name), false, name)
  }
  assert.equal(allow('search_docs'), true)
})

test('explicit readonly Bash and MCP opt-in remains visible and requires matching permissions', async (t) => {
  const paths = await setup(t)
  await save(paths.global, {
    roles: { explore: { tools: ['read', 'bash', 'mcp__server__search'], mcp: true } }
  })
  const config = await loadConfig(paths)
  assert.equal(profile(config, 'explore').mcp, true)
  assert.equal(config.diagnostics.length, 1)
  assert.match(config.diagnostics[0], /not a sandbox/)
  await save(paths.global, { roles: { worker: { tools: ['mcp__server__search'], mcp: false } } })
  const disabled = profile(await loadConfig(paths), 'worker')
  assert.equal(childToolPolicy(disabled, disabled.tools)('mcp__server__search'), false)
})

test('resource paths resolve at the declaring config, replace by layer, and never execute during loading', async (t) => {
  const paths = await setup(t)
  const globalExtension = join(paths.agentDir, 'global.mjs')
  const projectExtension = join(dirname(paths.project), 'project.js')
  const skills = join(paths.agentDir, 'skills')
  await mkdir(skills)
  await Promise.all([
    writeFile(globalExtension, 'throw new Error("config must not execute extensions");'),
    writeFile(projectExtension, 'throw new Error("config must not execute extensions");'),
    writeFile(join(skills, 'SKILL.md'), 'A fixture skill.')
  ])
  await save(paths.global, {
    roles: { worker: { extensions: ['./global.mjs'], skills: ['skills'] } }
  })
  await save(paths.project, { roles: { worker: { extensions: ['./project.js'], skills: [] } } })
  const global = await loadConfig(paths)
  assert.deepEqual(profile(global, 'worker').extensions, [globalExtension])
  assert.deepEqual(profile(global, 'worker').skills, [skills])
  const trusted = await loadConfig({ ...paths, projectTrusted: true })
  assert.deepEqual(profile(trusted, 'worker').extensions, [projectExtension])
  assert.deepEqual(profile(trusted, 'worker').skills, [])
})

test('resource loading rejects own plugin paths, symlink aliases, packages, missing entries, and directories as extensions', async (t) => {
  const paths = await setup(t)
  const alias = join(paths.agentDir, 'alias')
  await symlink(root, alias)
  const cases: Array<['extensions' | 'skills', string[], RegExp]> = [
    ['extensions', [join(root, 'src/config.ts')], /cannot load itself/],
    ['extensions', ['./alias/src/config.ts'], /cannot load itself/],
    ['skills', ['./alias'], /cannot load itself/],
    ['extensions', ['npm:some-extension'], /explicit local paths/],
    ['extensions', ['https://example.com/extension.js'], /explicit local paths/],
    ['skills', ['git:example/repo'], /explicit local paths/],
    ['skills', ['~/some-skill'], /explicit local paths/],
    ['extensions', ['./*.js'], /explicit local paths/],
    ['extensions', ['./missing.js'], /must exist/],
    ['extensions', ['C:\\extensions\\demo.js'], /must exist/],
    ['extensions', [paths.agentDir], /explicit local JavaScript or TypeScript entry files/]
  ]
  /* oxlint-disable no-await-in-loop -- Cases overwrite the same config file; save, load and assert in order. */
  for (const [key, entries, error] of cases) {
    await save(paths.global, { roles: { worker: { [key]: entries } } })
    await assert.rejects(loadConfig(paths), error)
  }
  /* oxlint-enable no-await-in-loop */
})

test('config loads the maintained role instructions', async (t) => {
  const paths = await setup(t)
  const config = await loadConfig(paths)
  /* oxlint-disable no-await-in-loop -- Keep fixture reads and their assertions in deterministic case order. */
  for (const name of ['explore', 'worker', 'verifier', 'mavis']) {
    const generated = (await readFile(resolve(root, 'prompts/' + name + '.md'), 'utf8')).trim()
    const instructions = profile(config, name).instructions
    assert.equal(instructions, generated)
    assert.match(instructions, /## Delegated Task Contract/)
    assert.doesNotMatch(
      instructions,
      /Leaf Session Contract|Bash is disabled by default|or use task or subagent tools/
    )
  }
  /* oxlint-enable no-await-in-loop */
})

test('named resources, MCP selectors and deny patterns preserve omission versus explicit empty', async (t) => {
  const paths = await setup(t)
  await save(paths.global, {
    roles: {
      worker: {
        skills: ['code-review'],
        extensions: ['permission-gate'],
        mcpServers: ['docs'],
        disallowedTools: ['mcp__docs__delete*', 'write']
      },
      verifier: { tools: ['bash', 'task_query', 'task_output', 'task_stop'] },
      disabled: { skills: [], extensions: [], mcp: false }
    }
  })
  const config = await loadConfig(paths)
  assert.deepEqual(config.roles.worker.skills, ['code-review'])
  assert.deepEqual(config.roles.worker.extensions, ['permission-gate'])
  assert.deepEqual(config.roles.worker.mcpServers, ['docs'])
  assert.deepEqual(config.roles.worker.disallowedTools, ['mcp__docs__delete*', 'write'])
  assert.deepEqual(config.roles['agent:disabled'].skills, [])
  assert.deepEqual(config.roles['agent:disabled'].extensions, [])
  assert.equal(config.roles['agent:disabled'].mcp, false)
  /* oxlint-disable no-await-in-loop -- Cases overwrite the same config file; save, load and assert in order. */
  for (const change of [{ mcpServers: [{}] }, { mcpServers: [3] }, { disallowedTools: [null] }]) {
    await save(paths.global, { roles: { worker: change } })
    await assert.rejects(loadConfig(paths))
  }
  /* oxlint-enable no-await-in-loop */
})

test('explicit model clears inherited profile effort unless the task sets effort', async (t) => {
  const paths = await setup(t)
  await save(paths.global, { roles: { worker: { model: 'test/old', thinking: 'high' } } })
  const config = await loadConfig(paths)
  assert.equal(profile(config, 'worker').effort, 'high')
  assert.equal(profile(config, 'worker', { model: 'test/new' }).effort, undefined)
  assert.equal(profile(config, 'worker', { model: 'test/new' }).thinking, undefined)
  assert.equal(profile(config, 'worker', { model: 'test/new', effort: 'low' }).effort, 'low')
})

test('custom names accept bare refs and retain explicit aliases', async (t) => {
  const paths = await setup(t)
  await save(paths.global, {
    roles: {
      reviewer: { effort: 'low' },
      'acme:reviewer': { effort: 'high' },
      'Custom Reviewer': {},
      审核员: {},
      'agent:worker': { effort: 'medium' },
      main: { effort: 'high' },
      constructor: {}
    }
  })
  const config = await loadConfig(paths)
  for (const name of ['reviewer', 'acme:reviewer', 'Custom Reviewer', '审核员', 'constructor']) {
    assert.equal(profile(config, name).name, 'agent:' + name)
    assert.equal(profile(config, 'agent:' + name).name, 'agent:' + name)
  }
  assert.equal(profile(config, ' AGENT:reviewer ').effort, 'low')
  assert.equal(profile(config, 'acme:reviewer').effort, 'high')
  assert.equal(profile(config, 'agent:worker').effort, 'medium')
  assert.equal(profile(config, 'worker').effort, undefined)
  assert.equal(profile(config, 'WORKER').name, 'worker')
  assert.equal(profile(config, 'main').name, 'mavis')
  assert.equal(profile(config, 'agent:main').effort, 'high')
  assert.throws(() => profile(config, 'unknown-plugin:reviewer'), /unknown role/)
  for (const name of ['..', 'name.', 'con', 'bad\\\\name', 'bad/name', 'bad\u0000name']) {
    assert.throws(() => profile(config, name), /invalid role name/)
  }
})

test('effort config normalizes the thinking alias and rejects conflicting selectors', async (t) => {
  const paths = await setup(t)
  await save(paths.global, {
    roles: { worker: { effort: ' high ' }, verifier: { thinking: 'minimal' } }
  })
  let config = await loadConfig(paths)
  assert.equal(config.roles.worker.effort, 'high')
  assert.equal(config.roles.verifier.effort, 'minimal')
  assert.equal(config.roles.verifier.thinking, undefined)
  await save(paths.global, { roles: { worker: { effort: 'low', thinking: 'high' } } })
  await assert.rejects(loadConfig(paths), /thinking and effort conflict/)
  await save(paths.global, {})
  config = await loadConfig(paths)
  assert.equal(config.maxConcurrency, 4)
  await save(paths.global, { maxConcurrency: 10 })
  assert.equal((await loadConfig(paths)).maxConcurrency, 10)
})

test('selector comparison is exact after trim/NFKC/en-US case normalization, never wildcard expansion', async (t) => {
  const paths = await setup(t)
  await save(paths.global, {
    roles: {
      worker: {
        tools: [' ＲＥＡＤ ', 'read'],
        disallowedTools: [' READ '],
        mcpServers: [' ＤＯＣＳ ']
      }
    }
  })
  const selected = profile(await loadConfig(paths), 'worker')
  const policy = childToolPolicy(selected, selected.tools, undefined, () => 'Docs')
  assert.equal(policy('read'), false)
  assert.equal(policy('mcp__Docs__read'), true)
  const literal = childToolPolicy(
    { ...selected, disallowedTools: ['mcp__docs__delete*'] },
    selected.tools,
    undefined,
    () => 'Docs'
  )
  assert.equal(literal('mcp__docs__delete_item'), true)
  const exact = childToolPolicy(
    { ...selected, disallowedTools: [' ＭＣＰ__ＤＯＣＳ__ＤＥＬＥＴＥ_ＩＴＥＭ '] },
    selected.tools,
    undefined,
    () => 'Docs'
  )
  assert.equal(exact('mcp__docs__delete_item'), false)
  assert.equal(childToolPolicy(selected, selected.tools)('mcp__docs__read'), false)
  const distinct = childToolPolicy(
    { ...selected, mcpServers: ['my_docs'] },
    selected.tools,
    undefined,
    () => 'my-docs'
  )
  assert.equal(distinct('mcp__my_docs__read'), false)
})
