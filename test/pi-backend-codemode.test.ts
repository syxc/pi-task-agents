import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createPiChildFactory } from '../src/pi-backend.ts';
import type { ChildSession } from '../src/types.ts';

test('production MCP codemode preserves execution without exposing host model services', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-child-codemode-'));
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  let child: ChildSession | undefined;
  t.after(async () => { try { await child?.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  const failures: unknown[] = [];
  let calls = 0;
  let registrations = 0;
  const runtime = {
    getModel: (provider: string, id: string) => ({ provider, id, api: 'openai-completions', reasoning: false, input: ['text'],
      contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    getModels: () => [], getProviders: () => [], hasConfiguredAuth: () => true,
    resolveModel: async (model: Model<Api>) => ({ model, thinkingLevel: 'off' }),
    streamSimple(model: Model<Api>, context: { messages: { role: string; content?: unknown; isError?: boolean }[] }) {
      calls++;
      try {
        if (calls === 2) {
          const result = context.messages.findLast((message) => message.role === 'toolResult');
          assert.ok(result);
          assert.equal(result.isError, false);
          assert.match(JSON.stringify(result.content), /undefined/);
        }
      } catch (error) { failures.push(error); throw error; }
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: calls === 1 ? 'toolUse' : 'stop',
        content: calls === 1 ? [{ type: 'toolCall', id: 'fixture-codemode', name: 'codemode', arguments: { code: 'text(typeof models);' } }]
          : [{ type: 'text', text: 'done' }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
    },
  };
  const factory = createPiChildFactory({ agentDir, modelRuntime: runtime, sdk: { ...sdk,
    createCodemodeExtension(options: Parameters<typeof sdk.createCodemodeExtension>[0]) {
      registrations++;
      assert.equal(options?.models, false);
      return sdk.createCodemodeExtension(options);
    } } });
  child = await factory({ cwd: root, sessionPath: join(root, 'child.jsonl'), profile: {
    name: 'fixture', model: 'fixture/local', thinking: 'off', instructions: 'Use only the local scripted fixture.',
    tools: ['codemode'], mcp: true, skills: [], extensions: [],
  } });
  assert.equal((await child.prompt('Inspect the sandbox globals')).text, 'done');
  assert.deepEqual(failures, []);
  assert.equal(calls, 2);
  assert.equal(registrations, 1);
});
