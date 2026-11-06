import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { answer, deferred, fixture, tool } from './pi-backend-test-helpers.ts';

for (const name of ['worker', 'mavis']) {
  test(`${name} captures native write targets and reports actual changes without a model verdict`, async t => {
    const f = await fixture(t);
    f.script(step => step === 1 ? tool('write', { path: 'owned.txt', content: 'owned evidence' }) : answer('Implemented'));
    const child = await f.child({ name, tools: ['write'] });
    const result = await child.prompt('Write only the owned fixture target.');
    assert.equal(await readFile(join(f.cwd, 'owned.txt'), 'utf8'), 'owned evidence');
    assert.equal(result.verification?.fileChange, 'change_observed', JSON.stringify(result.verification));
    assert.deepEqual(result.verification?.changedFiles, ['owned.txt']);
    assert.equal(result.verification?.modelVerdict, undefined);
  });
}

test('dynamic Bash targets preserve uncertainty while retaining observed changed paths', async t => {
  const f = await fixture(t);
  f.script(step => step === 1 ? tool('bash', { command: 'name=owned.txt; printf evidence > "$name"' }) : answer('done'));
  const child = await f.child({ tools: ['bash'] });
  const result = await child.prompt('Run only the owned fixture command.');
  assert.equal(result.verification?.fileChange, 'uncertain');
  assert.ok(result.verification?.changedFiles?.includes('owned.txt'));
  assert.ok(result.verification?.observationNotes.some(note => note.includes('ambiguous')));
});

test('nested codemode write is observed through the native tool lifecycle', { timeout: 10000 }, async t => {
  const f = await fixture(t, { isCodemodeEnabled: () => true });
  f.script(step => step === 1 ? tool('codemode', {
    code: 'await tools.write({path:"nested.txt",content:"nested evidence"});text("saved");',
  }) : answer('done'));
  const child = await f.child({ tools: ['write'] });
  const result = await child.prompt('Use the enabled codemode only for the owned fixture.');
  assert.equal(await readFile(join(f.cwd, 'nested.txt'), 'utf8'), 'nested evidence');
  assert.equal(result.verification?.fileChange, 'change_observed');
  assert.deepEqual(result.verification?.changedFiles, ['nested.txt']);
});

test('an excluded or out-of-workspace write does not become a clean-workspace claim', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'owned-outside-workspace.txt');
  f.script(step => step === 1 ? tool('write', { path, content: 'owned outside evidence' }) : answer('done'));
  const child = await f.child({ tools: ['write'] });
  const result = await child.prompt('Write only the explicitly owned outside-workspace fixture.');
  assert.equal(await readFile(path, 'utf8'), 'owned outside evidence');
  assert.equal(result.verification?.fileChange, 'uncertain');
  assert.ok(!result.verification?.changedFiles?.includes(path));
});

test('a denied writer never reports its intended target as an observed change', async t => {
  const f = await fixture(t);
  const extension = join(f.root, 'deny-owned-write.mjs');
  await writeFile(extension, `export default pi => pi.on('tool_call', event => event.toolName === 'write'
    ? {block:true,reason:'Owned denial fixture'} : undefined);`);
  f.script(step => step === 1 ? tool('write', { path: 'denied.txt', content: 'not written' }) : answer('denied'));
  const child = await f.child({ tools: ['write'], extensions: [extension] });
  const result = await child.prompt('Attempt only the owned denied target.');
  await assert.rejects(readFile(join(f.cwd, 'denied.txt')), /ENOENT/);
  assert.notEqual(result.verification?.fileChange, 'change_observed');
  assert.deepEqual(result.verification?.changedFiles, []);
});

test('a failed editor reports uncertainty without changing execution outcome or inventing a verdict', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'owned.txt'), 'original');
  f.script(step => step === 1 ? tool('edit', { path: 'owned.txt', oldText: 'missing', newText: 'never written' }) : answer('VERDICT: PASS'));
  const child = await f.child({ tools: ['edit'] });
  const result = await child.prompt('Attempt only the owned editor fixture.');
  assert.equal(await readFile(join(f.cwd, 'owned.txt'), 'utf8'), 'original');
  assert.equal(result.outcome?.status, 'succeeded');
  assert.equal(result.verification?.fileChange, 'uncertain');
  assert.equal(result.verification?.modelVerdict, undefined);
  assert.ok(result.verification?.observationNotes.includes('failed_tool_capture'));
});

test('aborted native Bash retains partial write evidence without claiming a clean workspace', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.script(step => step === 1 ? tool('bash', { command: 'printf evidence > owned.txt; printf OWNED_ABORT_READY; sleep 30' }) : answer('not reached'));
  const child = await f.child({ tools: ['bash'] });
  const ready = deferred();
  const unsubscribe = f.session().subscribe(event => {
    if (event.type === 'tool_execution_update' && JSON.stringify(event.partialResult).includes('OWNED_ABORT_READY')) ready.resolve();
  });
  const result = child.prompt('Run only the owned abort fixture.').catch(error => error.partialResult);
  try {
    await ready.promise;
    await child.abort();
    const partial = await result;
    assert.equal(await readFile(join(f.cwd, 'owned.txt'), 'utf8'), 'evidence');
    assert.equal(partial.outcome.status, 'aborted');
    assert.equal(partial.verification.fileChange, 'uncertain');
    assert.ok(partial.verification.changedFiles.includes('owned.txt'));
  } finally { unsubscribe(); }
});

test('first-before and last-after target facts do not attribute an unrelated concurrent file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'owned.txt'), 'initial');
  f.script(async step => {
    if (step === 1) return tool('write', { path: 'owned.txt', content: 'first' });
    if (step === 2) {
      await writeFile(join(f.cwd, 'unrelated.txt'), 'external actor');
      return tool('write', { path: 'owned.txt', content: 'last' });
    }
    return answer('done');
  });
  const child = await f.child({ tools: ['write'] });
  const result = await child.prompt('Modify only owned.txt.');
  assert.equal(result.verification?.fileChange, 'change_observed');
  assert.deepEqual(result.verification?.changedFiles, ['owned.txt']);
});
