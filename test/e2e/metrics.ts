import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { E2E_PROVIDER, type E2EEnvironment } from './environment.ts'
import type { PiRpc } from './rpc.ts'
import { isRecord, type JsonRecord } from './support.ts'

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  costUSD: number
}

export interface ParentMetrics {
  usage: UsageTotals
  assistantMessages: number
  toolCalls: number
}

export interface ChildMetrics {
  usage: UsageTotals
  assistantMessages: number
  sessionFiles: number
  models: string[]
}

export interface ScenarioMetrics {
  name: string
  durationMs: number
  parent: ParentMetrics
  child: ChildMetrics
  totalTokens: number
  costUSD: number
}

export interface BudgetOptions {
  parentTokens?: number
  childTokens?: number
  costUSD?: number
  assistantMessages?: number
  maxDurationMs?: number
  requiresChildSession?: boolean
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUSD: 0 }
}

function addUsage(target: UsageTotals, value: unknown): void {
  if (!isRecord(value)) {
    return
  }
  const input = numberOf(value.input)
  const output = numberOf(value.output)
  const cacheRead = numberOf(value.cacheRead)
  const cacheWrite = numberOf(value.cacheWrite)
  const total = numberOf(value.totalTokens)
  target.input += input
  target.output += output
  target.cacheRead += cacheRead
  target.cacheWrite += cacheWrite
  target.totalTokens += total || input + output + cacheRead + cacheWrite
  target.costUSD += isRecord(value.cost) ? numberOf(value.cost.total) : numberOf(value.cost)
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

export async function readParentMetrics(client: PiRpc): Promise<ParentMetrics> {
  const stats = await client.getSessionStats()
  const usage = emptyUsage()
  addUsage(usage, stats.tokens)
  const tokens = isRecord(stats.tokens) ? stats.tokens : {}
  usage.totalTokens = numberOf(tokens.total) || usage.totalTokens
  usage.costUSD = numberOf(stats.cost) || usage.costUSD
  return {
    usage,
    assistantMessages: numberOf(stats.assistantMessages),
    toolCalls: numberOf(stats.toolCalls)
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return []
    }
    throw error
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        return filesUnder(path)
      }
      return entry.isFile() ? [path] : []
    })
  )
  return nested.flat()
}

async function jsonlFiles(dir: string): Promise<string[]> {
  return (await filesUnder(dir)).filter((file) => file.endsWith('.jsonl'))
}

export async function readChildMetrics(agentDir: string): Promise<ChildMetrics> {
  const root = join(agentDir, 'task-agents', 'sessions')
  const files = await jsonlFiles(root)
  const models = new Set<string>()
  const usage = emptyUsage()
  let assistantMessages = 0
  const contents = await Promise.all(files.map(async (file) => readFile(file, 'utf8')))
  for (const content of contents) {
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue
      }
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(row) || row.type !== 'message' || !isRecord(row.message)) {
        continue
      }
      const message = row.message
      if (message.role !== 'assistant') {
        continue
      }
      assistantMessages++
      addUsage(usage, message.usage)
      if (typeof message.model === 'string') {
        models.add(
          `${typeof message.provider === 'string' ? message.provider : E2E_PROVIDER}/${message.model}`
        )
      }
    }
  }
  return { usage, assistantMessages, sessionFiles: files.length, models: [...models].sort() }
}

export async function readChildTasks(
  agentDir: string
): Promise<{ tasks: JsonRecord[]; stores: number }> {
  const root = join(agentDir, 'task-agents', 'sessions')
  const files = (await filesUnder(root)).filter((file) => file.endsWith('tasks.json'))
  const contents = await Promise.all(files.map(async (file) => readFile(file, 'utf8')))
  const tasks: JsonRecord[] = []
  for (const content of contents) {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      continue
    }
    if (isRecord(parsed) && Array.isArray(parsed.tasks)) {
      for (const task of parsed.tasks) {
        if (isRecord(task)) {
          tasks.push(task)
        }
      }
    }
  }
  return { tasks, stores: files.length }
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export async function finishScenario(
  name: string,
  startedAt: number,
  client: PiRpc,
  environment: Pick<E2EEnvironment, 'agentDir'>,
  options: BudgetOptions = {}
): Promise<ScenarioMetrics> {
  const durationMs = Date.now() - startedAt
  const parent = await readParentMetrics(client)
  const child = await readChildMetrics(environment.agentDir)
  const totalTokens = parent.usage.totalTokens + child.usage.totalTokens
  const costUSD = parent.usage.costUSD + child.usage.costUSD
  const assistantMessages = parent.assistantMessages + child.assistantMessages
  const budget = {
    parentTokens: options.parentTokens ?? envNumber('PI_E2E_MAX_PARENT_TOKENS', 48_000),
    childTokens: options.childTokens ?? envNumber('PI_E2E_MAX_CHILD_TOKENS', 24_000),
    costUSD: options.costUSD ?? envNumber('PI_E2E_MAX_COST_USD', 0.05),
    assistantMessages: options.assistantMessages ?? envNumber('PI_E2E_MAX_ASSISTANT_MESSAGES', 16),
    maxDurationMs: options.maxDurationMs ?? envNumber('PI_E2E_MAX_SCENARIO_MS', 180_000)
  }
  assert.ok(
    parent.usage.totalTokens <= budget.parentTokens,
    `${name}: parent used ${parent.usage.totalTokens} tokens (budget ${budget.parentTokens})`
  )
  assert.ok(
    child.usage.totalTokens <= budget.childTokens,
    `${name}: children used ${child.usage.totalTokens} tokens (budget ${budget.childTokens})`
  )
  assert.ok(
    costUSD <= budget.costUSD,
    `${name}: cost $${costUSD.toFixed(4)} exceeded budget $${budget.costUSD}`
  )
  assert.ok(
    assistantMessages <= budget.assistantMessages,
    `${name}: ${assistantMessages} assistant messages exceeded budget ${budget.assistantMessages}`
  )
  assert.ok(
    durationMs <= budget.maxDurationMs,
    `${name}: ${durationMs}ms exceeded budget ${budget.maxDurationMs}ms`
  )
  if (options.requiresChildSession !== false) {
    assert.ok(child.sessionFiles > 0, `${name}: no child session was recorded`)
  }
  const report: ScenarioMetrics = {
    name,
    durationMs,
    parent,
    child,
    totalTokens,
    costUSD
  }
  console.log(
    `[e2e] ${name} duration=${(durationMs / 1_000).toFixed(1)}s ` +
      `tokens=${totalTokens} (parent=${parent.usage.totalTokens}, child=${child.usage.totalTokens}) ` +
      `cost=$${costUSD.toFixed(4)} messages=${assistantMessages} ` +
      `parent_tools=${parent.toolCalls} child_sessions=${child.sessionFiles}`
  )
  return report
}
