import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  E2E_LUNA,
  createEnvironment,
  e2eOptions,
  finishScenario,
  isRecord,
  readChildMetrics,
  readChildTasks,
  readParentMetrics,
  requiredString,
  type PiRpc,
  type UsageTotals
} from './harness.ts'
import {
  readContextTrace,
  skillCases,
  skillFixtures,
  verifyImplementation,
  type SkillArmResult,
  type SkillCase,
  type SkillMode
} from './skills-context-support.ts'

const results: SkillArmResult[] = []
interface SkillArmFailure {
  scenario: string
  round: number
  mode: SkillMode
  parent?: UsageTotals
  child?: UsageTotals
  metricsIncomplete: boolean
}
const failures: SkillArmFailure[] = []

async function saveReport(name: string, value: unknown): Promise<void> {
  const dir = process.env.PI_E2E_REPORT_DIR
  if (!dir) {
    return
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), JSON.stringify(value, null, 2) + '\n')
}

async function runArm(
  scenario: SkillCase,
  round: number,
  mode: SkillMode
): Promise<SkillArmResult> {
  const startedAt = Date.now()
  const environment = await createEnvironment({
    parentModel: E2E_LUNA,
    childModel: null,
    parentThinking: 'high',
    skills: skillFixtures(round)
  })
  let client: PiRpc | undefined
  try {
    client = await environment.spawnRpc()
    const selection =
      mode === 'inherited'
        ? 'For the inherited-catalog baseline, omit the optional skills field entirely. Do not pass an empty list.'
        : 'Choose the smallest initial skills list from the catalog metadata that directly matches the child task. Pass that list in task.skills. Do not read Skill bodies to anticipate dependencies.'
    const { from } = await client.promptAndSettle(
      [
        'This is a bounded delegation acceptance test. Call task exactly once with agent_name worker, description "skills context check", run_in_background false.',
        selection,
        'Use the following exact child prompt without adding Skill paths or copying Skill descriptions or instructions:',
        JSON.stringify(scenario.prompt),
        'Do not use other tools yourself and do not do the child work. After the task returns, reply exactly PARENT_SKILLS_DONE.'
      ].join(' ')
    )
    const [end] = await client.waitForToolEnds('task', 1, { from })
    assert.ok(end, 'parent did not delegate')
    assert.equal(end.isError, false, end.text)
    assert.equal(end.details.status, 'succeeded', end.text)
    assert.equal(String(end.details.final_text).trim(), scenario.expected)
    await client.waitForAssistantText('PARENT_SKILLS_DONE', { from: end.index + 1 })

    const { tasks } = await readChildTasks(environment.agentDir)
    assert.equal(tasks.length, 1, 'expected exactly one admitted child')
    const task = tasks[0]
    assert.ok(task && isRecord(task.input) && isRecord(task.profile))
    assert.equal(task.input.prompt, scenario.prompt, 'parent changed the controlled child prompt')
    assert.equal(task.profile.model, `openai-codex/${E2E_LUNA}`)
    assert.equal(task.profile.thinking, 'high')
    if (mode === 'inherited') {
      assert.equal(task.input.skills, undefined)
    } else {
      assert.deepEqual(task.input.skills, [scenario.initialSkill])
    }
    const trace = await readContextTrace(requiredString(task.childSessionPath, 'childSessionPath'))
    assert.equal(trace.advertisedSkills, mode === 'inherited' ? 100 : 1)
    assert.ok(
      trace.skillReads.some((path) => path.includes(`/${scenario.initialSkill}/SKILL.md`)),
      'child did not read the selected Skill body'
    )
    if (scenario.name === 'discovery') {
      assert.ok(trace.skillReads.some((path) => path.includes('/archive-ledger/SKILL.md')))
      if (mode === 'selected') {
        assert.ok(trace.toolCalls.includes('task_skill_search'), 'hidden Skill was not discovered')
      }
    }
    if (scenario.name === 'implementation') {
      await verifyImplementation(environment.workspace)
    }

    const metrics = await finishScenario(
      `skills-${scenario.name}-${round}-${mode}`,
      startedAt,
      client,
      environment,
      {
        parentTokens: 180_000,
        // Full-catalog implementation arms exceed 180k through repeated cached input.
        childTokens: 240_000,
        costUSD: 0.5,
        assistantMessages: 24,
        maxDurationMs: 220_000
      }
    )
    assert.deepEqual(metrics.child.models, [`openai-codex/${E2E_LUNA}`])
    const result: SkillArmResult = {
      scenario: scenario.name,
      round,
      mode,
      durationMs: metrics.durationMs,
      parent: metrics.parent.usage,
      child: metrics.child.usage,
      trace,
      totalTokens: metrics.totalTokens,
      costUSD: metrics.costUSD
    }
    results.push(result)
    await saveReport(`skills-${scenario.name}-${round}-${mode}.json`, result)
    return result
  } catch (error) {
    const failure: SkillArmFailure = {
      scenario: scenario.name,
      round,
      mode,
      metricsIncomplete: true
    }
    if (client) {
      try {
        failure.parent = (await readParentMetrics(client)).usage
        failure.child = (await readChildMetrics(environment.agentDir)).usage
        const state = await client.getState()
        const { tasks } = await readChildTasks(environment.agentDir)
        failure.metricsIncomplete =
          state.isStreaming !== false ||
          tasks.some(
            (task) => !['succeeded', 'failed', 'canceled', 'lost'].includes(String(task.status))
          )
      } catch {
        // Preserve the original failure; an interrupted run may have incomplete usage.
      }
    }
    failures.push(failure)
    await saveReport(`skills-${scenario.name}-${round}-${mode}-failed.json`, failure)
    throw error
  } finally {
    await environment.dispose()
  }
}

for (const round of [0, 1]) {
  for (const scenario of skillCases(round)) {
    test(
      `Skills context A/B ${scenario.name} round ${round + 1} with luna high`,
      e2eOptions(480_000),
      async () => {
        // Reverse order in the second round so one arm does not always run against warmer caches.
        const firstMode = round === 0 ? 'inherited' : 'selected'
        const secondMode = round === 0 ? 'selected' : 'inherited'
        const first = await runArm(scenario, round, firstMode)
        const second = await runArm(scenario, round, secondMode)
        const inherited = first.mode === 'inherited' ? first : second
        const selected = first.mode === 'selected' ? first : second
        const reduction = 1 - selected.trace.firstPromptTokens / inherited.trace.firstPromptTokens
        assert.ok(
          reduction >= 0.3,
          `first child input decreased by only ${(reduction * 100).toFixed(1)}%`
        )
        assert.ok(selected.trace.systemChars < inherited.trace.systemChars)
        console.log(
          `[skills-ab] ${scenario.name} round=${round + 1} ` +
            `first_input=${inherited.trace.firstPromptTokens}->${selected.trace.firstPromptTokens} ` +
            `reduction=${(reduction * 100).toFixed(1)}% ` +
            `total=${inherited.totalTokens}->${selected.totalTokens} ` +
            `child_tools=${inherited.trace.toolCalls.length}->${selected.trace.toolCalls.length}`
        )
      }
    )
  }
}

after(async () => {
  if (results.length === 0 && failures.length === 0) {
    return
  }
  const totals = (mode: SkillMode) => {
    const arms = results.filter((result) => result.mode === mode)
    return {
      arms: arms.length,
      firstChildPromptTokens: arms.reduce((sum, arm) => sum + arm.trace.firstPromptTokens, 0),
      parentTokens: arms.reduce((sum, arm) => sum + arm.parent.totalTokens, 0),
      childTokens: arms.reduce((sum, arm) => sum + arm.child.totalTokens, 0),
      totalTokens: arms.reduce((sum, arm) => sum + arm.totalTokens, 0),
      costUSD: arms.reduce((sum, arm) => sum + arm.costUSD, 0),
      durationMs: arms.reduce((sum, arm) => sum + arm.durationMs, 0),
      childToolCalls: arms.reduce((sum, arm) => sum + arm.trace.toolCalls.length, 0)
    }
  }
  const inherited = totals('inherited')
  const selected = totals('selected')
  const complete = failures.length === 0 && inherited.arms === 6 && selected.arms === 6
  const summary = {
    model: `openai-codex/${E2E_LUNA}`,
    thinking: 'high',
    skillCount: 100,
    rounds: 2,
    complete,
    failures,
    reportedExperimentCostUSD:
      results.reduce((sum, result) => sum + result.costUSD, 0) +
      failures.reduce(
        (sum, failure) => sum + (failure.parent?.costUSD ?? 0) + (failure.child?.costUSD ?? 0),
        0
      ),
    inherited,
    selected,
    firstChildInputReduction: complete
      ? 1 - selected.firstChildPromptTokens / inherited.firstChildPromptTokens
      : null,
    combinedTokenReduction: complete ? 1 - selected.totalTokens / inherited.totalTokens : null,
    note: 'Controlled synthetic catalog. Input includes cacheRead and cacheWrite; character counts are not token counts. Incomplete runs are not a savings conclusion.'
  }
  await saveReport('skills-context-summary.json', summary)
  console.log(`[skills-ab-summary] ${JSON.stringify(summary)}`)
  if (complete) {
    assert.ok(
      selected.totalTokens < inherited.totalTokens,
      'selection did not save combined parent/child tokens'
    )
  }
})
