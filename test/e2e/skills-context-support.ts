import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isRecord, type SkillFixture, type UsageTotals } from './harness.ts'

export type SkillScenario = 'direct' | 'implementation' | 'discovery'
export type SkillMode = 'inherited' | 'selected'

const execute = promisify(execFile)

export interface SkillCase {
  name: SkillScenario
  initialSkill: string
  prompt: string
  expected: string
}

export interface ContextTrace {
  firstPromptTokens: number
  systemChars: number
  skillsChars: number
  advertisedSkills: number
  toolsSchemaChars: number
  toolCalls: string[]
  skillReads: string[]
  thinkingLevels: string[]
  requests: number
}

export interface SkillArmResult {
  scenario: SkillScenario
  round: number
  mode: SkillMode
  durationMs: number
  parent: UsageTotals
  child: UsageTotals
  trace: ContextTrace
  totalTokens: number
  costUSD: number
}

export function skillCases(round: number): SkillCase[] {
  return [
    {
      name: 'direct',
      initialSkill: 'release-routing',
      prompt:
        'Find and read the Skill for the release routing codeword. Follow its instructions and return only that codeword. Use the native read tool directly for Skill files. Do not modify files.',
      expected: `ROUTE_CEDAR_${round}_7319`
    },
    {
      name: 'implementation',
      initialSkill: 'stable-labels',
      prompt:
        'Implement the project stable-labels contract in solution.mjs and solution.test.mjs in the workspace. Read the relevant Skill with the native read tool, follow its implementation and verification instructions, run the tests, then reply only IMPLEMENTATION_OK. Do not use network or modify other files.',
      expected: 'IMPLEMENTATION_OK'
    },
    {
      name: 'discovery',
      initialSkill: 'bootstrap-code',
      prompt:
        'Find and read the Skill for the bootstrap completion code. Follow any Skill dependency it specifies, then return only the required completion code. Use the native read tool directly for Skill files. Do not scan skill directories or modify files.',
      expected: `BOOTSTRAP_MAPLE_${round}_9247`
    }
  ]
}

export function skillFixtures(round: number): SkillFixture[] {
  const domains = [
    'dns',
    'typography',
    'calendar',
    'translation',
    'diagrams',
    'inventory',
    'audio',
    'mail',
    'charts',
    'packaging',
    'geography',
    'accessibility'
  ]
  const distractors = Array.from({ length: 96 }, (_, index) => {
    const domain = domains[index % domains.length]
    return {
      name: `reference-${domain}-${String(index).padStart(3, '0')}`,
      description:
        `Specialized ${domain} reference ${index} for reviewing ${domain} source material and checking terminology against supplied evidence. ` +
        `Use for dedicated ${domain} documentation requests that need domain constraints and a concise evidence-backed explanation. Do not use for unrelated tasks.`,
      instructions: `This Skill covers ${domain} documentation only. It has no completion code or implementation contract.`
    }
  })
  return [
    ...distractors,
    {
      name: 'release-routing',
      description: 'Provides the release routing codeword. Use when asked for that exact codeword.',
      instructions: `The release routing codeword is ROUTE_CEDAR_${round}_7319. Return exactly this codeword and no other text.`
    },
    {
      name: 'stable-labels',
      description:
        'Defines the project stable-labels JavaScript implementation contract and required tests.',
      instructions: [
        'Implement and export normalizeLabels(value) from solution.mjs.',
        'Require an array of strings or throw TypeError. Trim each string, remove empty values, deduplicate case-sensitively, and preserve first occurrence order. Never modify the input.',
        'Use only Node standard libraries. Do not print anything when the module is imported.',
        'Write solution.test.mjs using node:test and node:assert/strict. Cover mixed case, duplicate labels, Chinese, empty arrays, invalid inputs, and input immutability.',
        'Run node --test solution.test.mjs and confirm success. Do not access network or add dependencies.'
      ].join('\n')
    },
    {
      name: 'bootstrap-code',
      description:
        'Provides the bootstrap completion procedure. Use for bootstrap completion requests.',
      instructions:
        'The bootstrap code is not in this file. Find the already authorized Skill named archive-ledger, read its SKILL.md using the native read tool, and follow it. Use the available Skill metadata lookup if its location is not advertised. Do not guess paths or scan directories.'
    },
    {
      name: 'archive-ledger',
      description: 'Contains internal ledger values for archive maintenance requests.',
      instructions: `The bootstrap completion code is BOOTSTRAP_MAPLE_${round}_9247. Return exactly this codeword and no other text.`
    }
  ]
}

export async function readContextTrace(path: string): Promise<ContextTrace> {
  const rows: unknown[] = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line: string): unknown => JSON.parse(line))
  const trace: ContextTrace = {
    firstPromptTokens: 0,
    systemChars: 0,
    skillsChars: 0,
    advertisedSkills: 0,
    toolsSchemaChars: 0,
    toolCalls: [],
    skillReads: [],
    thinkingLevels: [],
    requests: 0
  }
  let sawSystem = false
  for (const row of rows) {
    if (!isRecord(row)) {
      continue
    }
    if (row.type === 'thinking_level_change' && typeof row.thinkingLevel === 'string') {
      trace.thinkingLevels.push(row.thinkingLevel)
    }
    if (!isRecord(row.message)) {
      continue
    }
    const message = row.message
    if (message.role === 'system' && !sawSystem) {
      sawSystem = true
      const sections = isRecord(message.sections) ? message.sections : {}
      trace.systemChars = Object.values(sections).reduce<number>(
        (sum, value) => sum + (typeof value === 'string' ? value.length : 0),
        typeof message.content === 'string' ? message.content.length : 0
      )
      const skills = typeof sections.skills === 'string' ? sections.skills : ''
      trace.skillsChars = skills.length
      trace.advertisedSkills = [...skills.matchAll(/<skill>/gu)].length
      trace.toolsSchemaChars = JSON.stringify(message.toolsAdded ?? []).length
    }
    if (message.role !== 'assistant') {
      continue
    }
    if (isRecord(message.usage)) {
      if (trace.requests === 0) {
        for (const key of ['input', 'cacheRead', 'cacheWrite']) {
          const value = message.usage[key]
          trace.firstPromptTokens += typeof value === 'number' ? value : 0
        }
      }
      trace.requests++
    }
    if (!Array.isArray(message.content)) {
      continue
    }
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'toolCall' || typeof block.name !== 'string') {
        continue
      }
      trace.toolCalls.push(block.name)
      if (block.name === 'read' && isRecord(block.arguments)) {
        const path = block.arguments.path ?? block.arguments.file_path
        if (typeof path === 'string' && path.endsWith('SKILL.md')) {
          trace.skillReads.push(path)
        }
      }
    }
  }
  assert.ok(sawSystem, 'child has no persisted system message')
  assert.ok(trace.firstPromptTokens > 0, 'child reported no first-request input')
  assert.ok(trace.thinkingLevels.includes('high'), 'child did not use high thinking')
  return trace
}

export async function verifyImplementation(workspace: string): Promise<void> {
  // Model-produced verification code gets no provider credentials in its environment.
  const options = { cwd: workspace, env: { PATH: process.env.PATH }, timeout: 20_000 }
  await execute(process.execPath, ['--test', 'solution.test.mjs'], options)
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import assert from 'node:assert/strict';",
        "import {normalizeLabels} from './solution.mjs';",
        "const input=Object.freeze([' A ','A','a',' 中文 ','中文','']);",
        "assert.deepEqual(normalizeLabels(input),['A','a','中文']);",
        "assert.deepEqual(input,[' A ','A','a',' 中文 ','中文','']);",
        'assert.deepEqual(normalizeLabels([]),[]);',
        'for(const value of [null,{},1,[1],new Array(1)])assert.throws(()=>normalizeLabels(value),TypeError);'
      ].join('')
    ],
    options
  )
}
