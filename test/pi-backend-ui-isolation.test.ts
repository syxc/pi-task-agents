import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { answer, fixture, profile } from './pi-backend-test-helpers.ts';

test('duplicate registrations within one headless session still fail closed', async t => {
  const f = await fixture(t), extension = join(f.root, 'duplicate.ts');
  await writeFile(extension, `export default pi => {
    const key = Symbol.for('owned-duplicate-ui-session'); let ui;
    for (let i = 0; i < 2; i++) pi.on('session_start', (_event, ctx) => {
      ui = ctx.ui;
      if (Object.hasOwn(ui, key)) throw new Error('Mention sources require unique IDs and triggers within a session.');
      Object.defineProperty(ui, key, { configurable: true, value: true });
    });
    pi.on('session_shutdown', () => { if (ui) delete ui[key]; });
  };\n`);
  let calls = 0; f.script(() => { calls++; return answer('unexpected'); });
  await assert.rejects(f.child({ extensions: [extension] }), /Mention sources require unique IDs/);
  assert.equal(calls, 0);
});

// Session-scoped extension caches commonly use own Symbol properties on ctx.ui.
test('retained headless children have independent UI state while hasUI stays false', async t => {
  const f = await fixture(t), audit = join(f.root, 'ui-sessions.jsonl'), extension = join(f.root, 'mention.ts');
  await writeFile(extension, `import { appendFileSync } from 'node:fs';
export default pi => {
  const key = Symbol.for('owned-child-ui-session'); let ui;
  pi.on('session_start', (_event, ctx) => {
    ui = ctx.ui;
    if (Object.hasOwn(ui, key)) throw new Error('Mention sources require unique IDs and triggers within a session.');
    Object.defineProperty(ui, key, { configurable: true, value: ctx.sessionManager.getSessionId() });
    appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ id: ui[key], hasUI: ctx.hasUI, mode: ctx.mode, theme: !!ui.theme }) + '\\n');
  });
  pi.on('input', (_event, ctx) => {
    if (ctx.ui !== ui || ctx.ui[key] !== ctx.sessionManager.getSessionId()) throw new Error('Child UI ownership changed');
    if (ctx.hasUI) throw new Error('Headless child must not advertise interactive UI');
  });
  pi.on('session_shutdown', () => { if (ui) delete ui[key]; });
};\n`);
  f.script(() => answer('OWNED_UI_OK'));
  let first: any, second: any;
  try {
    first = await f.create({ cwd: f.cwd, sessionPath: join(f.root, 'first.jsonl'), profile: { ...profile, extensions: [extension] } });
    assert.equal((await first.prompt('First retained child')).text, 'OWNED_UI_OK');
    second = await f.create({ cwd: f.cwd, sessionPath: join(f.root, 'second.jsonl'), profile: { ...profile, extensions: [extension] } });
    assert.equal((await second.prompt('Independent second child')).text, 'OWNED_UI_OK');
    await second.dispose(); second = undefined;
    assert.equal((await first.prompt('First child still owns its state')).text, 'OWNED_UI_OK');
    const rows = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
    assert.ok(rows.every(row => row.hasUI === false && row.mode === 'json' && row.theme === true));
  } finally { await second?.dispose(); await first?.dispose(); }
});
