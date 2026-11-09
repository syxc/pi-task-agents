import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'
import type { AgentProfile } from '../src/types.ts'
import { answer, fixture, tool } from './pi-backend-test-helpers.ts'

const skill = (name: string, filePath: string, disableModelInvocation = false): Skill => ({
  name,
  description: `${name} description`,
  filePath,
  baseDir: filePath.slice(0, filePath.lastIndexOf('/')),
  sourceInfo: { path: filePath, source: 'fixture', scope: 'user', origin: 'top-level' },
  disableModelInvocation
})

function skillSearchTool(f: Awaited<ReturnType<typeof fixture>>) {
  const tool = f
    .session()
    .extensionRunner.getAllRegisteredTools()
    .find((candidate) => candidate.definition.name === 'task_skill_search')?.definition
  assert.ok(tool)
  return tool
}

test('initial Skill selection filters prompt metadata but keeps authorized search available', async (t) => {
  const fixtureSkills = [
    skill('first', '/authorized/first/SKILL.md'),
    skill('second', '/authorized/second/SKILL.md')
  ]
  const host = {
    getExtensions: () => ({ extensions: [] }),
    getSkills: () => ({ skills: fixtureSkills })
  }
  const f = await fixture(t, { resourceLoader: host })
  let resolved: AgentProfile | undefined
  await f.child({ skills: undefined, initialSkills: ['first'] }, undefined, async (profile) => {
    resolved = profile
  })
  const session = f.session()
  assert.ok(resolved?.toolInventory?.includes('task_skill_search'))
  assert.ok(!resolved?.nativeToolSnapshot?.includes('task_skill_search'))
  assert.ok(
    session.getCallableToolNames().includes('task_skill_search'),
    JSON.stringify({
      tools: session.getCallableToolNames(),
      registered: session.extensionRunner
        .getAllRegisteredTools()
        .map((tool) => tool.definition.name)
    })
  )
  const options = {
    cwd: f.cwd,
    selectedTools: ['read'],
    skills: fixtureSkills
  }
  const result = await session.extensionRunner.emitBeforeAgentStart(
    { messageType: 'user', prompt: 'inspect' },
    options
  )
  assert.deepEqual(
    result.systemPromptOptions.skills.map((entry) => entry.name),
    ['first']
  )
  const definition = skillSearchTool(f)
  const resultMetadata = await definition.execute(
    'search-test',
    { query: 'second' },
    undefined,
    undefined,
    undefined as never
  )
  const metadataText =
    resultMetadata.content[0]?.type === 'text' ? resultMetadata.content[0].text : ''
  const metadata = JSON.parse(metadataText) as {
    total: number
    skills: Array<{ name: string; description: string; path: string }>
  }
  assert.equal(metadata.total, 1)
  assert.deepEqual(
    metadata.skills.map((entry) => entry.name),
    ['second']
  )
  assert.equal(metadata.skills[0]?.path, '/authorized/second/SKILL.md')
})

test('search and prompt metadata re-check the current host resource snapshot', async (t) => {
  const first = skill('first', '/authorized/first/SKILL.md')
  let current = [first, skill('second', '/authorized/second/SKILL.md')]
  const f = await fixture(t, {
    resourceLoader: {
      getExtensions: () => ({ extensions: [] }),
      getSkills: () => ({ skills: current })
    }
  })
  await f.child({ skills: undefined, initialSkills: ['first'] })
  current = [
    { ...first, description: 'latest first description' },
    { ...current[1]!, description: 'latest second description' }
  ]
  const session = f.session()
  const prompt = await session.extensionRunner.emitBeforeAgentStart(
    { messageType: 'user', prompt: 'continue' },
    { cwd: f.cwd, selectedTools: ['read'], skills: [first] }
  )
  assert.equal(prompt.systemPromptOptions.skills[0]?.description, 'latest first description')
  const updated = await skillSearchTool(f).execute(
    'updated-search',
    { query: 'latest second' },
    undefined,
    undefined,
    undefined as never
  )
  assert.match(updated.content[0]?.type === 'text' ? updated.content[0].text : '', /latest second/)
  current = []
  const revoked = await session.extensionRunner.emitBeforeAgentStart(
    { messageType: 'user', prompt: 'after revoke' },
    { cwd: f.cwd, selectedTools: ['read'], skills: [first] }
  )
  assert.deepEqual(revoked.systemPromptOptions.skills, [])
  const result = await skillSearchTool(f).execute(
    'revoked-search',
    {},
    undefined,
    undefined,
    undefined as never
  )
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  assert.match(text, /"total":0/)
  assert.doesNotMatch(text, /second/)
})

test('disabled Skills are neither searchable nor valid initial selections', async (t) => {
  const disabled = skill('disabled', '/authorized/disabled/SKILL.md', true)
  const enabled = skill('enabled', '/authorized/enabled/SKILL.md')
  const resourceLoader = {
    getExtensions: () => ({ extensions: [] }),
    getSkills: () => ({ skills: [disabled, enabled] })
  }
  const f = await fixture(t, { resourceLoader })
  await assert.rejects(
    f.child({ skills: undefined, initialSkills: ['disabled'] }),
    /not authorized or no longer available/
  )
  await f.child(
    { skills: undefined, initialSkills: [] },
    `${f.root}/sessions/disabled-search.jsonl`
  )
  const result = await skillSearchTool(f).execute(
    'disabled-search',
    {},
    undefined,
    undefined,
    undefined as never
  )
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  assert.match(text, /enabled/)
  assert.doesNotMatch(text, /disabled/)
})

test('explicitly loaded Skill paths without a host snapshot expose search metadata', async (t) => {
  const f = await fixture(t)
  const skillsDir = join(f.cwd, 'extra-skills')
  const alphaDir = join(skillsDir, 'alpha')
  const betaDir = join(skillsDir, 'beta')
  await Promise.all([mkdir(alphaDir, { recursive: true }), mkdir(betaDir, { recursive: true })])
  await Promise.all([
    writeFile(join(alphaDir, 'SKILL.md'), '---\nname: alpha\ndescription: first\n---\nAlpha body'),
    writeFile(join(betaDir, 'SKILL.md'), '---\nname: beta\ndescription: second\n---\nBeta body')
  ])
  await f.child({ skills: [skillsDir], initialSkills: ['alpha'] })
  const result = await skillSearchTool(f).execute(
    'path-search',
    { query: 'second' },
    undefined,
    undefined,
    undefined as never
  )
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  assert.match(text, /beta/)
})

test('omitted selection preserves the complete legacy Skill prompt', async (t) => {
  const fixtureSkills = [
    skill('legacy-a', '/authorized/a/SKILL.md'),
    skill('legacy-b', '/authorized/b/SKILL.md')
  ]
  const f = await fixture(t, {
    resourceLoader: {
      getExtensions: () => ({ extensions: [] }),
      getSkills: () => ({ skills: fixtureSkills })
    }
  })
  await f.child({ skills: undefined })
  const result = await f
    .session()
    .extensionRunner.emitBeforeAgentStart(
      { messageType: 'user', prompt: 'inspect' },
      { cwd: f.cwd, selectedTools: ['read'], skills: fixtureSkills }
    )
  assert.deepEqual(
    result.systemPromptOptions.skills.map((entry) => entry.name),
    ['legacy-a', 'legacy-b']
  )
  assert.ok(!f.session().getCallableToolNames().includes('task_skill_search'))
})

test('unauthorized initial Skill names fail before a model turn', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.child({ skills: [], initialSkills: ['not-authorized'] }),
    /not authorized or no longer available/
  )
})

test('restored Skill snapshots cap search and tolerate an initial Skill disappearing', async (t) => {
  const fixtureSkills = [
    skill('still-authorized', '/authorized/one/SKILL.md'),
    skill('new-after-snapshot', '/authorized/two/SKILL.md')
  ]
  const f = await fixture(t, {
    resourceLoader: {
      getExtensions: () => ({ extensions: [] }),
      getSkills: () => ({ skills: fixtureSkills })
    }
  })
  await f.child({
    skills: undefined,
    skillSnapshot: ['still-authorized'],
    initialSkills: ['removed-skill']
  })
  const result = await f
    .session()
    .extensionRunner.emitBeforeAgentStart(
      { messageType: 'user', prompt: 'continue' },
      { cwd: f.cwd, selectedTools: ['read'], skills: fixtureSkills }
    )
  assert.deepEqual(result.systemPromptOptions.skills, [])
  const page = await skillSearchTool(f).execute(
    'snapshot-search',
    {},
    undefined,
    undefined,
    undefined as never
  )
  const text = page.content[0]?.type === 'text' ? page.content[0].text : ''
  assert.match(text, /still-authorized/)
  assert.doesNotMatch(text, /new-after-snapshot/)
})

test('disallowed Skill search and unreadable tools prevent internal search activation', async (t) => {
  const fixtureSkills = [
    skill('one', '/authorized/one/SKILL.md'),
    skill('two', '/authorized/two/SKILL.md')
  ]
  const resourceLoader = {
    getExtensions: () => ({ extensions: [] }),
    getSkills: () => ({ skills: fixtureSkills })
  }
  const f = await fixture(t, { resourceLoader })
  const blocked = await f.child({
    skills: undefined,
    initialSkills: ['one'],
    disallowedTools: ['task_skill_search']
  })
  assert.ok(!f.session().getCallableToolNames().includes('task_skill_search'))
  await blocked.dispose()
  const unreadable = await f.child(
    { skills: undefined, tools: [], initialSkills: ['one'] },
    `${f.root}/sessions/unreadable.jsonl`
  )
  assert.ok(!f.session().getCallableToolNames().includes('task_skill_search'))
  await unreadable.dispose()
})

test('explicitly empty display still permits finding other authorized Skills', async (t) => {
  const fixtureSkills = [
    skill('one', '/authorized/one/SKILL.md'),
    skill('two', '/authorized/two/SKILL.md')
  ]
  const f = await fixture(t, {
    resourceLoader: {
      getExtensions: () => ({ extensions: [] }),
      getSkills: () => ({ skills: fixtureSkills })
    }
  })
  await f.child({ skills: undefined, initialSkills: [] })
  const result = await f
    .session()
    .extensionRunner.emitBeforeAgentStart(
      { messageType: 'user', prompt: 'inspect' },
      { cwd: f.cwd, selectedTools: ['read'], skills: fixtureSkills }
    )
  assert.deepEqual(result.systemPromptOptions.skills, [])
  assert.ok(f.session().getCallableToolNames().includes('task_skill_search'))
})

test('native Bash without read is sufficient to expose Skill metadata search', async (t) => {
  const fixtureSkills = [
    skill('one', '/authorized/one/SKILL.md'),
    skill('two', '/authorized/two/SKILL.md')
  ]
  const f = await fixture(t, {
    resourceLoader: {
      getExtensions: () => ({ extensions: [] }),
      getSkills: () => ({ skills: fixtureSkills })
    }
  })
  await f.child({ skills: undefined, tools: ['bash'], initialSkills: ['one'] })
  assert.ok(f.session().getCallableToolNames().includes('task_skill_search'))
})

test('initially empty Skill display does not add search without a readable hidden Skill', async (t) => {
  const f = await fixture(t)
  const child = await f.child({ skills: [], initialSkills: [] })
  assert.ok(!f.session().getCallableToolNames().includes('task_skill_search'))
  await child.dispose()
})

test('Skills discovered during extension binding remain searchable and readable', async (t) => {
  const f = await fixture(t)
  const skillDir = join(f.root, 'late-skill')
  const skillPath = join(skillDir, 'SKILL.md')
  const extension = join(f.root, 'discover.mjs')
  await mkdir(skillDir)
  await writeFile(
    extension,
    `import { writeFileSync } from 'node:fs';
export default pi => {
  pi.on('resources_discover', () => {
    writeFileSync(${JSON.stringify(skillPath)}, '---\\nname: late-skill\\ndescription: A dynamically discovered Skill\\n---\\nLATE_SKILL_BODY\\n');
    return { skillPaths: [${JSON.stringify(skillDir)}] };
  });
};`
  )
  let resolved: AgentProfile | undefined
  const child = await f.child(
    { skills: [skillDir], extensions: [extension], initialSkills: [] },
    undefined,
    async (profile) => {
      resolved = profile
    }
  )
  const canonicalSkillPath = await realpath(skillPath)
  assert.deepEqual(resolved?.skillSnapshot, ['late-skill'])
  assert.ok(f.session().getCallableToolNames().includes('task_skill_search'))
  assert.ok(resolved?.toolInventory?.includes('task_skill_search'))
  assert.ok(!resolved?.nativeToolSnapshot?.includes('task_skill_search'))

  let requests = 0
  f.script((step, context) => {
    requests = step
    if (step === 1) {
      return tool('task_skill_search', { query: 'late-skill' })
    }
    const result = context.messages.findLast((message) => message.role === 'toolResult')
    assert.ok(result && !result.isError)
    const content = result.content[0]
    assert.ok(content?.type === 'text')
    if (step === 2) {
      const page = JSON.parse(content.text)
      assert.deepEqual(page.skills, [
        {
          name: 'late-skill',
          description: 'A dynamically discovered Skill',
          path: canonicalSkillPath
        }
      ])
      return tool('read', { path: page.skills[0].path })
    }
    assert.equal(step, 3)
    assert.match(content.text, /LATE_SKILL_BODY/)
    return answer('done')
  })
  await child.prompt('Discover the authorized Skill and read its body.')
  assert.equal(requests, 3)
})
