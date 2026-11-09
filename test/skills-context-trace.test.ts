import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readContextTrace } from './e2e/skills-context-support.ts'

async function traceFile(rows: unknown[], check: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'skill-trace-diagnostic-'))
  try {
    const path = join(directory, 'session.jsonl')
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    await check(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const prefix = [
  { type: 'thinking_level_change', thinkingLevel: 'high' },
  { message: { role: 'system', sections: {}, toolsAdded: [] } }
]

test('trace diagnostics keep the first-input gate and never expose provider error text', async () => {
  await traceFile(
    [
      ...prefix,
      {
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'SIMULATED_PRIVATE_PROVIDER_DETAIL',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
      },
      {
        message: {
          role: 'assistant',
          stopReason: 'stop',
          usage: { input: 100, output: 5, cacheRead: 20, cacheWrite: 0 }
        }
      }
    ],
    async (path) => {
      await assert.rejects(readContextTrace(path), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /child reported no first-request input/u)
        assert.match(error.message, /assistant_attempts=/u)
        assert.match(error.message, /"stopReason":"error"/u)
        assert.match(error.message, /"hasErrorMessage":true/u)
        assert.doesNotMatch(error.message, /SIMULATED_PRIVATE_PROVIDER_DETAIL/u)
        return true
      })
    }
  )
})

test('valid first usage is unchanged and an absent assistant remains a failure', async () => {
  await traceFile(
    [
      ...prefix,
      {
        message: {
          role: 'assistant',
          stopReason: 'stop',
          usage: { input: 100, output: 5, cacheRead: 20, cacheWrite: 3 }
        }
      }
    ],
    async (path) => {
      const trace = await readContextTrace(path)
      assert.equal(trace.firstPromptTokens, 123)
      assert.equal(trace.requests, 1)
    }
  )
  await traceFile(prefix, async (path) => {
    await assert.rejects(readContextTrace(path), /assistant_attempts=\[\]/u)
  })
})
