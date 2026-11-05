import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import type { AgentSession, CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { createPiChildFactory, type PiChildFactoryOptions } from '../src/pi-backend.ts';
import type { AgentProfile, ChildSession } from '../src/types.ts';

export const answer = (text = 'done', extra: Record<string, unknown> = {}) => ({ role: 'assistant', api: 'test',
  provider: 'offline', model: 'local', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
  usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } }, ...extra });
export const tool = (name: string, args: unknown) => answer('', { stopReason: 'toolUse',
  content: [{ type: 'toolCall', id: `owned-${name}`, name, arguments: args }] });
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
export const profile: AgentProfile = { name: 'worker', instructions: 'Only operate on the owned fixture.',
  thinking: 'off', tools: ['read'], skills: [], extensions: [], mcp: false, timeoutMs: 0 };

export async function fixture(t: TestContext, extra: Partial<PiChildFactoryOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-native-child-'));
  const agentDir = join(root, 'agent'), cwd = join(root, 'workspace');
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const model = { provider: 'offline', id: 'local', api: 'test', reasoning: false, input: ['text'], contextWindow: 10000,
    maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let step = 0, events = 0, session!: AgentSession, options!: CreateAgentSessionOptions;
  let script: (step: number, context: any, options: any) => any = () => answer();
  const runtime = { getModel: () => model, getModels: () => [], getProviders: () => [], hasConfiguredAuth: () => true,
    resolveModel: async () => ({ model, thinkingLevel: 'off' }),
    streamSimple(_model: unknown, context: unknown, options: unknown) {
      const result = Promise.resolve(script(++step, context, options));
      return { async *[Symbol.asyncIterator]() { const message = await result; yield { type: 'done', reason: message.stopReason, message }; }, result: () => result };
    } };
  const create = createPiChildFactory({ agentDir, modelRuntime: runtime, inheritedModel: model as any, ...extra,
    sdk: { ...sdk, SettingsManager: { ...sdk.SettingsManager, fromStorage: sdk.SettingsManager.fromStorage,
      create: sdk.SettingsManager.create,
      inMemory(settings: any, options?: Parameters<typeof sdk.SettingsManager.inMemory>[1]) { return sdk.SettingsManager.inMemory({ ...settings, compaction: { enabled: false }, retry: { enabled: false } }, options); } },
      async createAgentSession(value: CreateAgentSessionOptions) {
        options = value;
        const result = await sdk.createAgentSession(value);
        session = result.session; session.subscribe(() => { events++; });
        return result;
      }, ...(extra.sdk as object ?? {}) } });
  const children: ChildSession[] = [];
  t.after(async () => {
    try { for (const child of children) await child.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, cwd, agentDir, runtime, model, create,
    session: () => session, options: () => options, events: () => events,
    script(value: typeof script) { script = value; step = 0; },
    async child(overrides: Partial<AgentProfile> = {}, path = join(root, 'sessions', 'owned.jsonl'), onProfileResolved?: (profile: AgentProfile) => Promise<void>) {
      const child = await create({ profile: { ...profile, ...overrides }, cwd, sessionPath: path, onProfileResolved });
      children.push(child); return child;
    } };
}
