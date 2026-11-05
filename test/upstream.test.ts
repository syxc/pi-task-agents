import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { domainRoot, githubSource, main, makeLock, transform, vendorRoot, verify, watches } from '../scripts/upstream.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = '/upstream-fixture';
const nextCommit = 'a'.repeat(40);

async function fixture() {
  const lock = await verify(projectRoot);
  const files = new Map<string, string>();
  const remote = new Map<string, string>();
  for (const entry of lock.files) {
    const content = await readFile(join(projectRoot, entry.target), 'utf8');
    files.set(join(fixtureRoot, entry.target), content);
    remote.set(entry.source, transform(content, entry.transforms, true));
  }
  // Only domain bytes are needed from the real checkout; watch fixtures can be synthetic.
  for (const entry of lock.watch) remote.set(entry.source, `contract fixture: ${entry.source}\n`);
  const fixtureLock = makeLock(lock.commit, remote);
  files.set(join(fixtureRoot, 'upstream.lock.json'), JSON.stringify(fixtureLock, null, 2) + '\n');
  let calls = 0;
  let failRenameAt = 0;
  let renameCount = 0;
  const renames: string[] = [];
  const logs: string[] = [];
  const io = {
    async readFile(path: string) {
      assert.ok(files.has(path), `missing fixture file: ${path}`);
      return files.get(path)!;
    },
    async readdir(path: string) {
      return [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => key.slice(path.length + 1));
    },
    async writeFile(path: string, content: string, options?: { flag?: string }) {
      if (options?.flag === 'wx') assert.ok(!files.has(path));
      files.set(path, content);
    },
    async rename(from: string, to: string) {
      if (++renameCount === failRenameAt) throw new Error('injected rename failure');
      assert.ok(files.has(from));
      files.set(to, files.get(from)!);
      files.delete(from);
      renames.push(to);
    },
    async link(from: string, to: string) {
      if (files.has(to)) throw new Error('EEXIST: ' + to);
      assert.ok(files.has(from));
      files.set(to, files.get(from)!);
      renames.push(to);
    },
    async unlink(path: string) { files.delete(path); },
  };
  const source = {
    async resolve(ref?: string) { calls++; return ref || nextCommit; },
    async list() { return [...remote.keys()]; },
    async read(_commit: string, path: string) {
      assert.ok(remote.has(path));
      return remote.get(path)!;
    },
  };
  return {
    files, remote, logs, renames, io, source, lock: fixtureLock,
    options: { localRoot: fixtureRoot, io, source, log: (line: string) => logs.push(line) },
    snapshot: () => [...files.entries()].filter(([path]) => !path.includes('/.upstream-old-'))
      .sort(([a], [b]) => a.localeCompare(b)),
    recovery: () => [...files.entries()].filter(([path]) => path.includes('/.upstream-old-')),
    calls: () => calls,
    failRename: (at: number) => { failRenameAt = at; },
  };
}

test('upstream monitoring stays within task protocol reference fixtures', () => {
  assert.equal(watches.length, 3);
  assert.ok(watches.every((entry) => entry.kind === 'host'));
  assert.equal(watches.some((entry) => /website|ptc|file-changes|web-fetch|mcp|assets\/agents/.test(entry.source)), false);
});

test('module transforms preserve import-like text in strings, comments and template text', () => {
  const tick = String.fromCharCode(96);
  const unchanged = [
    'export const sample = "import(\'./status.js\')";',
    "const other = 'from \"../types.js\"';",
    "// import './status.js';",
    "/* export { status } from './status.js'; */",
    'const raw = ' + tick + "import('./status.js')" + tick + ';',
    "const escaped = 'it\\'s import(\"./status.js\")';",
  ].join('\n');
  const code = unchanged + '\n' + [
    "import /* a */ { status } from /* b */ './status.js';",
    "export type { Task } from '../types.js';",
    "import './side-effect.js';",
    "const dynamic = import(/* c */ './status.js');",
    'const nested = ' + tick + 'value: [object Promise]' + tick + ';',
  ].join('\n');
  const transforms = ['relative-import-js-to-ts-v1'];
  const adapted = transform(code, transforms);
  assert.ok(adapted.startsWith(unchanged + '\n'));
  assert.match(adapted, /from \/\* b \*\/ '\.\/status\.ts'/);
  assert.match(adapted, /import\(\/\* c \*\/ '\.\/status\.ts'\)/);
  assert.ok(adapted.includes('[object Promise]'));
  assert.equal(transform(adapted, transforms, true), code);
});

test('unsupported module forms fail closed instead of guessing replacements', () => {
  for (const content of [
    'const value = import(path);',
    'const value = import(' + String.fromCharCode(96) + './status.js' + String.fromCharCode(96) + ');',
    "import task = require('./status.js');",
    "import './sta\\tus.js';",
    'const regexp = /import(".\/status.js")/;',
  ]) assert.throws(() => transform(content, ['relative-import-js-to-ts-v1']), /Unsupported module syntax/);
});

test('offline verification checks vendor bytes, original hashes and deterministic transforms', async () => {
  const f = await fixture();
  assert.equal(await main([], f.options), 0);
  assert.equal(f.calls(), 0);
  assert.equal(f.renames.length, 0);
  const entry = f.lock.files[0];
  f.lock.files[0].sha256 = '0'.repeat(64);
  f.files.set(join(fixtureRoot, 'upstream.lock.json'), JSON.stringify(f.lock));
  await assert.rejects(verify(fixtureRoot, f.io), /Source\/transform hash mismatch/);
  f.files.set(join(fixtureRoot, entry.target), 'local edit');
  await assert.rejects(verify(fixtureRoot, f.io), /Local vendor modification/);
});

test('check returns zero for unchanged monitored content and never writes', async () => {
  const f = await fixture();
  const before = f.snapshot();
  assert.equal(await main(['--check'], f.options), 0);
  assert.match(f.logs.join('\n'), /No monitored source changes/);
  assert.deepEqual(f.snapshot(), before);
});

test('syncing the locked commit leaves recorded content unchanged', async () => {
  const f = await fixture();
  const before = f.snapshot();
  assert.equal(await main(['--sync', '--ref', f.lock.commit], f.options), 0);
  assert.deepEqual(f.snapshot(), before);
  await verify(fixtureRoot, f.io);
});

test('module changes are reported and sync preserves transforms with the lock installed last', async () => {
  const f = await fixture();
  const source = `${domainRoot}/manager.ts`;
  f.remote.set(source, `${f.remote.get(source)}\n// Upstream change.\n`);
  assert.equal(await main(['--check', '--ref', nextCommit], f.options), 1);
  assert.match(f.logs.join('\n'), /domain changed: .*manager\.ts/);
  assert.equal(await main(['--sync', '--ref', nextCommit], f.options), 0);
  const updated = await verify(fixtureRoot, f.io);
  assert.equal(updated.commit, nextCommit);
  assert.notEqual(updated.files.find((entry: { source: string }) => entry.source === source).sha256,
    f.lock.files.find((entry: { source: string }) => entry.source === source).sha256);
  assert.equal(f.renames.at(-1), join(fixtureRoot, 'upstream.lock.json'));
  assert.equal(f.snapshot().length, 9);
  assert.match(f.files.get(join(fixtureRoot, vendorRoot, 'errors.ts'))!, /readonly code: string;/);
});

test('task protocol changes block sync until explicitly acknowledged', async () => {
  const f = await fixture();
  const host = f.lock.watch[0];
  f.remote.set(host.source, 'changed task protocol');
  const before = f.snapshot();
  assert.equal(await main(['--check'], f.options), 1);
  assert.match(f.logs.join('\n'), /host contract changed:/);
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /manual adaptation\/review/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(await main(['--sync', '--ref', nextCommit, '--accept-contract-changes'], f.options), 0);
  assert.equal(f.snapshot().length, 9);
  const updated = await verify(fixtureRoot, f.io);
  assert.notEqual(updated.watch[0].sha256, f.lock.watch[0].sha256);
  assert.ok(f.snapshot().every(([path]) => path.includes(vendorRoot) || path.endsWith('upstream.lock.json')));
});

test('local vendor edits stop sync before fetching or writing', async () => {
  const f = await fixture();
  f.files.set(join(fixtureRoot, f.lock.files[0].target), 'unrecorded local edit');
  const before = f.snapshot();
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /Local vendor modification/);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.snapshot(), before);
});

test('local edits made during upstream reads are checked again before install', async () => {
  const f = await fixture();
  const read = f.source.read;
  f.source.read = async (commit: string, path: string) => {
    const content = await read(commit, path);
    f.files.set(join(fixtureRoot, f.lock.files[0].target), 'concurrent edit');
    return content;
  };
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /Local vendor modification/);
  assert.equal(f.renames.length, 0);
  assert.equal(f.files.get(join(fixtureRoot, f.lock.files[0].target)), 'concurrent edit');
});

test('edits after the final verification stop install without overwriting vendor or lock', async () => {
  for (const target of [vendorRoot + '/id.ts', 'upstream.lock.json']) {
    const f = await fixture();
    f.remote.set(domainRoot + '/id.ts', f.remote.get(domainRoot + '/id.ts') + '\n// Upstream edit.\n');
    const readdir = f.io.readdir;
    let reads = 0;
    f.io.readdir = async (path: string) => {
      const names = await readdir(path);
      if (++reads === 2) f.files.set(join(fixtureRoot, target), 'edit after final verify');
      return names;
    };
    await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /Local modification during install/);
    assert.equal(f.files.get(join(fixtureRoot, target)), 'edit after final verify');
    assert.equal(f.renames.length, 0);
    assert.equal(f.recovery().length, 0);
    assert.equal(f.snapshot().length, 9);
  }
});

test('edits during staging are checked again immediately before replacing a target', async () => {
  const f = await fixture();
  const target = join(fixtureRoot, vendorRoot, 'id.ts');
  f.remote.set(domainRoot + '/id.ts', f.remote.get(domainRoot + '/id.ts') + '\n// Upstream edit.\n');
  const writeFile = f.io.writeFile;
  f.io.writeFile = async (path: string, content: string, options?: { flag?: string }) => {
    await writeFile(path, content, options);
    if (path.startsWith(target + '.upstream-')) f.files.set(target, 'edit during staging');
  };
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /Local modification during install/);
  assert.equal(f.files.get(target), 'edit during staging');
  assert.equal(f.renames.length, 0);
  assert.equal(f.snapshot().length, 9);
});

test('edits in the final check/rename window are captured and restored', async () => {
  const f = await fixture();
  const target = join(fixtureRoot, vendorRoot, 'id.ts');
  f.remote.set(domainRoot + '/id.ts', f.remote.get(domainRoot + '/id.ts') + '\n// Upstream edit.\n');
  const rename = f.io.rename;
  f.io.rename = async (from: string, to: string) => {
    if (from === target) f.files.set(target, 'edit before moving original');
    await rename(from, to);
  };
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /recovery copies retained:.*Local modification during install/);
  assert.equal(f.files.get(target), 'edit before moving original');
  assert.ok(f.recovery().some(([, content]) => content === 'edit before moving original'));
});

test('a target recreated by an editor is preserved when installation and rollback cannot link', async () => {
  const f = await fixture();
  const target = join(fixtureRoot, vendorRoot, 'id.ts');
  const original = f.files.get(target);
  f.remote.set(domainRoot + '/id.ts', f.remote.get(domainRoot + '/id.ts') + '\n// Upstream edit.\n');
  const rename = f.io.rename;
  f.io.rename = async (from: string, to: string) => {
    await rename(from, to);
    if (from === target) f.files.set(target, 'editor recreated target');
  };
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /recovery copies retained:.*EEXIST/);
  assert.equal(f.files.get(target), 'editor recreated target');
  assert.ok(f.recovery().some(([, content]) => content === original));
});

test('rollback retains edits made to an installed file before a later install failure', async () => {
  const f = await fixture();
  const target = join(fixtureRoot, vendorRoot, 'id.ts');
  const original = f.files.get(target);
  f.remote.set(domainRoot + '/id.ts', f.remote.get(domainRoot + '/id.ts') + '\n// Upstream edit.\n');
  const link = f.io.link;
  f.io.link = async (from: string, to: string) => {
    await link(from, to);
    if (to === target && from.startsWith(target + '.upstream-')) f.files.set(target, 'edit after install');
  };
  f.failRename(2);
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /recovery copies retained:.*injected rename failure/);
  assert.equal(f.files.get(target), original);
  assert.ok(f.recovery().some(([path, content]) => path.endsWith('.interrupted') && content === 'edit after install'));
});

test('successful installs retain moved originals for writes arriving after the backup check', async () => {
  const f = await fixture();
  const target = join(fixtureRoot, vendorRoot, 'id.ts');
  f.remote.set(domainRoot + '/id.ts', f.remote.get(domainRoot + '/id.ts') + '\n// Upstream edit.\n');
  const link = f.io.link;
  f.io.link = async (from: string, to: string) => {
    if (to === target) {
      const backup = f.recovery().find(([path]) => path.endsWith('-id.ts'))!;
      f.files.set(backup[0], 'late edit through original inode');
    }
    await link(from, to);
  };
  assert.equal(await main(['--sync', '--ref', nextCommit], f.options), 0);
  assert.ok(f.recovery().some(([, content]) => content === 'late edit through original inode'));
  assert.match(f.logs.join('\n'), /Original files retained for recovery:.*\.upstream-old-/);
  await verify(fixtureRoot, f.io);
});

test('added TypeScript files and missing/moved modules require manifest review', async () => {
  const f = await fixture();
  f.remote.set(`${domainRoot}/new-helper.ts`, 'export {};');
  f.remote.delete(`${domainRoot}/id.ts`);
  f.remote.set('packages/moved/id.ts', 'export {};');
  assert.equal(await main(['--check'], f.options), 1);
  assert.match(f.logs.join('\n'), /added module: .*new-helper\.ts/);
  assert.match(f.logs.join('\n'), /missing\/moved module: .*id\.ts/);
  const before = f.snapshot();
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /Module inventory changed/);
  assert.deepEqual(f.snapshot(), before);
});

test('missing watched contracts cannot be accepted without updating watch paths', async () => {
  const f = await fixture();
  f.remote.delete(f.lock.watch[0].source);
  assert.equal(await main(['--check'], f.options), 1);
  await assert.rejects(main(['--sync', '--ref', nextCommit, '--accept-contract-changes'], f.options), /missing\/moved/);
  assert.equal(f.renames.length, 0);
});

test('changed constructor or incomplete fetch fails before any vendor writes', async () => {
  const f = await fixture();
  const before = f.snapshot();
  const path = `${domainRoot}/errors.ts`;
  f.remote.set(path, f.remote.get(path)!.replace('readonly code: string', 'readonly code: number'));
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /constructor changed/);
  assert.deepEqual(f.snapshot(), before);
  f.source.read = async () => { throw new Error('injected download failure'); };
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /injected download failure/);
  assert.deepEqual(f.snapshot(), before);
});

test('a failed install restores previous vendor and lock content', async () => {
  const f = await fixture();
  const before = f.snapshot();
  f.remote.set(`${domainRoot}/id.ts`, `${f.remote.get(`${domainRoot}/id.ts`)}\n// Changed upstream.\n`);
  f.failRename(2);
  await assert.rejects(main(['--sync', '--ref', nextCommit], f.options), /injected rename failure/);
  assert.deepEqual(f.snapshot(), before);
  await verify(fixtureRoot, f.io);
});

test('GitHub adapter uses fixed-repository execFile arguments and full commit pins', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const source = githubSource(async (command: string, args: string[]) => {
    calls.push({ command, args });
    const endpoint = args[1];
    if (endpoint.includes('/commits/')) return { stdout: JSON.stringify({ sha: nextCommit }) };
    if (endpoint.includes('/git/trees/')) return { stdout: JSON.stringify({ tree: [{ type: 'blob', path: 'file.ts' }] }) };
    return { stdout: 'raw source bytes\n' };
  });
  assert.equal(await source.resolve(), nextCommit);
  assert.deepEqual(await source.list(nextCommit), ['file.ts']);
  assert.equal(await source.read(nextCommit, `${domainRoot}/id.ts`), 'raw source bytes\n');
  assert.ok(calls.every((call) => call.command === 'gh' && call.args[0] === 'api' &&
    call.args[1].startsWith('repos/MiniMax-AI/minimax-code/')));
  assert.ok(calls[0].args[1].endsWith('/commits/HEAD'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--hostname') + 1], 'github.com');
  assert.equal(calls[0].args[calls[0].args.indexOf('--method') + 1], 'GET');
  assert.ok(calls[2].args.includes('Accept: application/vnd.github.raw+json'));
  await assert.rejects(source.resolve('HEAD; echo unsafe'), /40-character commit/);
  assert.equal(calls.length, 3);
});

test('GitHub adapter rejects incomplete trees and keeps runner errors out of diagnostics', async () => {
  const partial = githubSource(async () => ({ stdout: JSON.stringify({ truncated: true, tree: [] }) }));
  await assert.rejects(partial.list(nextCommit), /Incomplete GitHub tree/);
  const failed = githubSource(async () => { throw new Error('private diagnostic'); });
  await assert.rejects(failed.resolve(), (error: Error) => {
    assert.match(error.message, /GitHub API request failed/);
    assert.doesNotMatch(error.message, /private diagnostic/);
    return true;
  });
});

test('invalid CLI combinations fail before any network call', async () => {
  const f = await fixture();
  for (const args of [
    ['--sync'], ['--check', '--ref', 'HEAD'], ['--verify', '--ref', nextCommit],
    ['--check', '--accept-contract-changes'], ['--sync', '--ref', nextCommit, '--check'],
  ]) await assert.rejects(main(args, f.options));
  assert.equal(f.calls(), 0);
});
