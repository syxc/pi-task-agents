import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { answer, deferred, fixture } from './pi-backend-test-helpers.ts';

// Auto-compaction uses Agent.streamFunction rather than Agent.prompt.
test('canceled authentication preflight cannot start a compaction model request', async (t) => {
  for (const mode of ['valid', 'abort', 'timeout']) await t.test(mode, async (t) => {
    const f = await fixture(t, { sdk: { SettingsManager: { inMemory(settings: any, options: any) {
      return sdk.SettingsManager.inMemory({ ...settings,
        compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 }, retry: { enabled: false },
      }, options);
    } } } });
    const manager = sdk.SessionManager.create(f.cwd, join(f.root, 'history'));
    for (const message of [
      { role: 'user', content: 'Earlier owned context. '.repeat(800), timestamp: Date.now() },
      answer('Earlier result'),
      { role: 'user', content: 'Recent owned context. '.repeat(80), timestamp: Date.now() },
      answer('Recent result', { usage: { input: 9500, output: 40, cacheRead: 0, cacheWrite: 0,
        totalTokens: 9540, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
    ]) manager.appendMessage(message as any);
    const child = await f.child({ timeoutMs: mode === 'timeout' ? 200 : 0 }, manager.getSessionFile()!);
    const entered = deferred(), release = deferred(), canceled = deferred();
    f.runtime.hasConfiguredAuth = () => false;
    (f.runtime as any).checkAuth = async () => { entered.resolve(); await release.promise; return 'owned-test-auth'; };
    let calls = 0, compactions = 0, authLookups = 0;
    const forwardedKeys: unknown[] = [];
    (f.runtime as any).getAuth = async () => { authLookups++; return { auth: { apiKey: 'owned-oauth-sentinel' }, env: {} }; };
    f.script((_step, _context, options) => {
      calls++; forwardedKeys.push(options?.apiKey); return answer('Owned summary or final result');
    });
    f.session().subscribe(event => { if (event.type === 'compaction_start') compactions++; });
    const abort = f.session().abort.bind(f.session());
    f.session().abort = () => { canceled.resolve(); return abort(); };
    const running = child.prompt('Next owned turn');
    const rejected = mode === 'valid' ? undefined : assert.rejects(running, {
      name: mode === 'timeout' ? 'TimeoutError' : 'AbortError',
    });
    await entered.promise;
    const stopping = mode === 'abort' ? child.abort() : undefined;
    if (mode === 'timeout') await canceled.promise;
    release.resolve();
    await stopping;
    if (mode === 'valid') {
      assert.equal((await running).text, 'Owned summary or final result');
      assert.ok(compactions > 0, 'positive control must actually enter native compaction');
      assert.ok(calls >= 2, 'positive control must execute compaction and the normal model path');
      assert.equal(authLookups, 0, 'SDK must let its runtime resolve OAuth rather than converting it to an explicit key');
      assert.ok(forwardedKeys.every(key => key === undefined), 'compaction must not override runtime authentication');
    } else {
      await rejected;
      assert.equal(calls, 0, 'canceled owner must not invoke even the compaction model');
    }
  });
});
