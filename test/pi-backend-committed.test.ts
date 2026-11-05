import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import type { AgentSession, CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { createPiChildFactory } from '../src/pi-backend.ts';
import type { AgentProfile, ChildFailure } from '../src/types.ts';

const answer = (text: string, extra: Record<string, unknown> = {}) => ({ role: 'assistant', api: 'test',
  provider: 'offline', model: 'model', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra });
const textOf = (message: any) => typeof message.content === 'string' ? message.content :
  message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
const firstRead = (text: string) => answer(text, { stopReason: 'toolUse', content: [
  { type: 'text', text }, { type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'owned.txt' } },
] });

async function fixture(t: TestContext, retry = false) {
  const root = await mkdtemp(join(tmpdir(), 'pi-committed-'));
  const workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(workspace, 'owned.txt'), 'Only owned fixture bytes\n');
  let session!: AgentSession;
  let script: (step: number, context: any) => any = () => answer('Initial');
  let step = 0;
  const observed: any[] = [], output: string[] = [], activity: string[] = [];
  const model = { provider: 'offline', id: 'model', api: 'test', reasoning: false, input: ['text'], contextWindow: 10000,
    maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = { getModel: () => model, getModels: () => [], getProviders: () => [], hasConfiguredAuth: () => true,
    resolveModel: async () => ({ model, thinkingLevel: 'off' }),
    streamSimple(_model: unknown, context: any) {
      const result = Promise.resolve(script(++step, context));
      return { async *[Symbol.asyncIterator]() { const message = await result; yield { type: 'done', reason: message.stopReason, message }; }, result: () => result };
    } };
  const create = createPiChildFactory({ agentDir, modelRuntime: runtime,
    sdk: { ...sdk, SettingsManager: { ...sdk.SettingsManager,
      inMemory(settings: Parameters<typeof sdk.SettingsManager.inMemory>[0]) {
        return sdk.SettingsManager.inMemory({ ...settings, compaction: { enabled: false },
          retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } });
      },
    }, async createAgentSession(options: CreateAgentSessionOptions) {
      const result = await sdk.createAgentSession(options); session = result.session;
      session.subscribe((event) => { if (event.type === 'message_end' && event.message.role === 'assistant') observed.push(event.message); });
      return result;
    } } });
  const profile: AgentProfile = { name: 'verifier', model: 'offline/model', thinking: 'off', timeoutMs: 0,
    tools: ['read'], skills: [], extensions: [], mcp: false };
  const child = await create({ profile, cwd: workspace, sessionPath: join(root, 'private', 'history.jsonl'),
    onOutput: (text) => output.push(text), onActivity: (text) => activity.push(text) });
  t.after(async () => { await child.dispose(); await rm(root, { recursive: true, force: true }); });
  return { child, session: () => session, observed, output, activity,
    script(value: typeof script) { script = value; step = 0; } };
}

test('real SDK retry red/green: observed failed text stays raw but durable omission removes it from Task final text', async (t) => {
  const f = await fixture(t, true);
  f.script((step) => step === 1 ? answer('VERDICT: FAIL', { stopReason: 'error', errorMessage: '429 rate limit: scripted retry' }) : answer('VERDICT: PASS'));
  const result = await f.child.prompt('Run the real SDK retry path offline', { turnId: 'turn_task_bg_retry' });
  assert.deepEqual(f.observed.map(textOf), ['VERDICT: FAIL', 'VERDICT: PASS'], 'The old event-only producer is demonstrably wrong');
  const raw = f.session().sessionManager.getEntries();
  const failed = raw.find((entry) => entry.type === 'message' && entry.message === f.observed[0])!;
  assert.ok(raw.some((entry) => entry.type === 'context_edit' && entry.targetId === failed.id && entry.replacement === null));
  assert.equal(f.session().sessionManager.getBranch().some((entry) => entry.id === failed.id), true, 'Raw history retention is not effective completion');
  assert.equal(result.text, 'VERDICT: PASS');
  assert.deepEqual(result.outcome, { kind: 'returned', status: 'succeeded' });
  assert.deepEqual(f.output, [], 'Model Task.output receives no running assistant/status stream');
  assert.ok(f.activity.includes('Retrying model request'));
});

test('real SDK non-retried failed response remains current committed text rather than every error being erased', async (t) => {
  const f = await fixture(t);
  f.script(() => answer('Committed failure detail', { stopReason: 'error', errorMessage: 'SCRIPTED_NONRETRYABLE_FAILURE' }));
  await assert.rejects(f.child.prompt('Do not infer recall from an error', { turnId: 'turn_task_bg_failed_committed' }), (error: ChildFailure) => {
    assert.equal(error.partialResult?.text, 'Committed failure detail'); return true;
  });
  assert.equal(f.session().sessionManager.getEntries().some((entry) => entry.type === 'context_edit'), false);
});

test('real SDK active branch excludes recalled observed entries, old turns and orphan branches', async (t) => {
  const f = await fixture(t);
  f.script(() => answer('HISTORICAL'));
  await f.child.prompt('Historical turn', { turnId: 'turn_task_bg_history' });
  const prior = new Set(f.session().sessionManager.getEntries().map((entry) => entry.id));
  f.script((step) => {
    if (step === 1) return firstRead('ORPHANED ATTEMPT');
    const currentUser = f.session().sessionManager.getBranch().findLast((entry) => entry.type === 'message' &&
      entry.message.role === 'user' && !prior.has(entry.id))!;
    // This is the public durable branch operation, not a synthesized event or ID.
    // Agent live state still contains the observed attempt; the producer must not.
    f.session().sessionManager.branch(currentUser.id);
    return answer('Committed final');
  });
  const result = await f.child.prompt('Recall this turn through real SessionManager branching', { turnId: 'turn_task_bg_branch' });
  assert.equal(f.observed.map(textOf).includes('ORPHANED ATTEMPT'), true);
  const raw = f.session().sessionManager.getEntries();
  assert.equal(raw.some((entry) => entry.type === 'message' && textOf(entry.message).includes('ORPHANED ATTEMPT')), true);
  assert.equal(result.text, 'Committed final');
  const branch = f.session().sessionManager.getBranch();
  assert.equal(branch.some((entry) => entry.type === 'message' && textOf(entry.message).includes('ORPHANED ATTEMPT')), false);
  f.script(() => answer('NEXT ONLY'));
  assert.equal((await f.child.prompt('Next admitted turn', { turnId: 'turn_task_bg_next' })).text, 'NEXT ONLY');
  assert.deepEqual(f.output, []);
  assert.ok(f.activity.includes('read: running'));
});

test('real SDK durable content edits apply without treating normal compaction as recall', async (t) => {
  for (const mode of ['edit', 'compaction']) await t.test(mode, async (t) => {
    const f = await fixture(t);
    f.script((step) => {
      if (step === 1) return firstRead('Earlier committed answer');
      const branch = f.session().sessionManager.getBranch();
      const first = branch.find((entry) => entry.type === 'message' && entry.message === f.observed[0])!;
      if (mode === 'edit') f.session().sessionManager.appendContextEdit(first.id, { content: [{ type: 'text', text: 'Revised committed answer' }] });
      else {
        const kept = branch.findLast((entry) => entry.type === 'message' && entry.message.role === 'toolResult')!;
        f.session().sessionManager.appendCompaction('Owned fixture compaction checkpoint', kept.id, 10);
      }
      return answer('Final committed answer');
    });
    const result = await f.child.prompt('Read only the owned fixture and finish', { turnId: `turn_task_bg_${mode}` });
    assert.equal(result.text, `${mode === 'edit' ? 'Revised' : 'Earlier'} committed answer\nFinal committed answer`);
    assert.deepEqual(f.output, []);
  });
});
