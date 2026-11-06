import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPackageDir } from '@earendil-works/pi-coding-agent';
import ts from 'typescript';

const project = fileURLToPath(new URL('../', import.meta.url));
const digest = content => createHash('sha256').update(content).digest('hex');

/** Build the real companion SDK source patch in a private test directory, never in the installed SDK. */
export async function prepareSdkTest(root) {
  const manifest = JSON.parse(await readFile(join(project, 'sdk-patches/manifest.json'), 'utf8'));
  const patch = await readFile(join(project, 'sdk-patches/pi-sdk-1.5.0-resource-snapshot.patch'));
  assert.equal(digest(patch), manifest.patchSha256, 'SDK patch hash mismatch');
  const installed = getPackageDir();
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.version, manifest.sdk.version, 'Test builder requires the pinned SDK release');
  const sourceRoot = join(root, 'source'), runtime = join(root, 'runtime');
  const states = new Set();
  for (const file of manifest.files) {
    assert.match(file.source, /^src\/[a-z0-9/-]+\.ts$/i);
    assert.match(file.map, /^dist\/[a-z0-9/-]+\.js\.map$/i);
    const map = JSON.parse(await readFile(join(installed, file.map), 'utf8'));
    const text = map.sourcesContent?.find(content => content !== null && [file.baseSha256, file.patchedSha256].includes(digest(content)));
    assert.equal(typeof text, 'string', 'Pinned SDK source-map content mismatch: ' + file.source);
    states.add(digest(text) === file.baseSha256 ? 'base' : 'patched');
    const path = join(sourceRoot, 'packages/coding-agent', file.source);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
  }
  assert.equal(states.size, 1, 'Mixed SDK patch state');
  if (states.has('base')) {
    const path = join(project, 'sdk-patches/pi-sdk-1.5.0-resource-snapshot.patch');
    for (const args of [['apply', '--check', '--whitespace=error', path], ['apply', '--whitespace=error', path]]) {
      const result = spawnSync('git', args, { cwd: sourceRoot, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
  await cp(installed, runtime, { recursive: true, dereference: true,
    filter: path => basename(path) !== 'node_modules' });
  // The published SDK and its dependencies already come from npm ci; do not fetch anything during tests.
  await symlink(join(project, 'node_modules'), join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of manifest.files) {
    const source = await readFile(join(sourceRoot, 'packages/coding-agent', file.source), 'utf8');
    assert.equal(digest(source), file.patchedSha256, 'Patched SDK source mismatch: ' + file.source);
    const target = join(runtime, file.map.replace(/\.map$/, ''));
    const compiled = ts.transpileModule(source, { fileName: target.replace(/\.js$/, '.ts'), reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        rewriteRelativeImportExtensions: true, sourceMap: true, inlineSources: true } });
    assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0,
      'SDK source syntax error: ' + file.source);
    await writeFile(target, compiled.outputText);
    await writeFile(target + '.map', compiled.sourceMapText);
  }
  return runtime;
}
