import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AgentProfile, TaskAgentsConfig } from '../src/types.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveProfile } from '../src/config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const readonly = ['read', 'grep', 'find', 'ls'];

async function setup(t: TestContext) {
  // Keep fixture resources outside the plugin: children must never load the plugin itself.
  const dir = await mkdtemp(fileURLToPath(new URL('../../.task-agents-config-test-', import.meta.url)));
  const cwd = join(dir, 'project');
  const agentDir = join(dir, 'agent');
  await Promise.all([mkdir(join(cwd, '.pi'), { recursive: true }), mkdir(agentDir)]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, cwd, agentDir, global: join(agentDir, 'task-agents.json'), project: join(cwd, '.pi/task-agents.json') };
}

const save = (path: string, value: unknown): Promise<void> => writeFile(path, JSON.stringify(value));
const profile = (config: TaskAgentsConfig, agent_name: string, input: Record<string, unknown> = {}): AgentProfile => resolveProfile(config, { agent_name, ...input });

function assertFrozen(value: unknown): void {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    Object.values(value).forEach(assertFrozen);
  }
}

test('missing configuration uses the four exact defaults with no inherited resources', async (t) => {
  const paths = await setup(t);
  const config = await loadConfig(paths);
  assert.equal(config.maxConcurrency, 4);
  assert.deepEqual(config.sources, []);
  assert.deepEqual(config.diagnostics, []);
  assert.deepEqual(Object.keys(config.roles), ['explore', 'worker', 'verifier', 'mavis']);
  for (const [name, effort] of Object.entries({ explore: 'medium', worker: 'high', verifier: 'xhigh', mavis: 'xhigh' })) {
    const actual = profile(config, name);
    assert.equal(actual.name, name);
    assert.equal(actual.model, 'openai-codex/gpt-6.1-' + (name === 'explore' ? 'terra' : 'sol'));
    assert.equal(actual.thinking, effort);
    assert.deepEqual(actual.tools, ['explore', 'verifier'].includes(name) ? readonly : [...readonly, 'bash', 'edit', 'write']);
    assert.deepEqual(actual.extensions, []);
    assert.deepEqual(actual.skills, []);
    assert.equal(actual.mcp, false);
    assert.equal(actual.timeoutMs, 0);
    assert.match(actual.instructions, /Leaf Session Contract/);
    assertFrozen(actual);
  }
  assertFrozen(config);
});

test('global and trusted project layers append instructions and replace explicit fields', async (t) => {
  const paths = await setup(t);
  await save(paths.global, { maxConcurrency: 2, roles: { worker: {
    model: 'vendor/global', thinking: 'low', instructions: 'Global note.', tools: ['read', 'bash'], timeoutMs: 500,
  } } });
  await save(paths.project, { maxConcurrency: 6, roles: { worker: {
    model: 'vendor/project/model', instructions: 'Project note.', tools: ['read'], timeoutMs: 900,
  } } });
  const config = await loadConfig({ ...paths, projectTrusted: true });
  const actual = profile(config, 'worker');
  assert.equal(config.maxConcurrency, 6);
  assert.deepEqual(config.sources, [paths.global, paths.project]);
  assert.equal(actual.model, 'vendor/project/model');
  assert.equal(actual.thinking, 'low');
  assert.equal(actual.timeoutMs, 900);
  assert.deepEqual(actual.tools, ['read']);
  assert.match(actual.instructions, /Role: Worker/);
  assert.ok(actual.instructions.endsWith('Global note.\n\nProject note.'));
});

test('untrusted project config is not parsed or executed and gets a clear diagnostic', async (t) => {
  const paths = await setup(t);
  await save(paths.global, { maxConcurrency: 3 });
  await writeFile(paths.project, '{ invalid and untrusted JSON');
  const config = await loadConfig(paths);
  assert.equal(config.maxConcurrency, 3);
  assert.deepEqual(config.sources, [paths.global]);
  assert.equal(config.diagnostics.length, 1);
  assert.match(config.diagnostics[0], /Untrusted project configuration ignored/);
  assert.ok(config.diagnostics[0].includes(paths.project));
  await assert.rejects(loadConfig({ ...paths, projectTrusted: true }), /invalid JSON/);
});

test('an agentDir equal to project .pi cannot bypass project trust', async (t) => {
  const paths = await setup(t);
  await save(paths.project, { maxConcurrency: 8 });
  const options = { cwd: paths.cwd, agentDir: dirname(paths.project) };
  const untrusted = await loadConfig(options);
  assert.equal(untrusted.maxConcurrency, 4);
  assert.deepEqual(untrusted.sources, []);
  assert.equal(untrusted.diagnostics.length, 1);
  const trusted = await loadConfig({ ...options, projectTrusted: true });
  assert.equal(trusted.maxConcurrency, 8);
  assert.deepEqual(trusted.sources, [paths.project]);
});

test('a symlink agentDir alias cannot load an untrusted project config', async (t) => {
  const paths = await setup(t);
  const alias = join(paths.dir, 'project-agent-alias');
  await symlink(dirname(paths.project), alias);
  await save(paths.project, { maxConcurrency: 17, roles: { worker: { tools: ['bash'] } } });
  const config = await loadConfig({ cwd: paths.cwd, agentDir: alias });
  assert.equal(config.maxConcurrency, 4);
  assert.deepEqual(profile(config, 'worker').tools, [...readonly, 'bash', 'edit', 'write']);
  assert.deepEqual(config.sources, []);
  assert.equal(config.diagnostics.length, 1);
  assert.ok(config.diagnostics[0].includes(paths.project));
  assert.match(config.diagnostics[0], /Untrusted project configuration ignored/);
  await writeFile(paths.project, '{ invalid and untrusted JSON');
  const invalid = await loadConfig({ cwd: paths.cwd, agentDir: alias });
  assert.equal(invalid.maxConcurrency, 4);
  assert.deepEqual(invalid.sources, []);
  assert.equal(invalid.diagnostics.length, 1);
});

test('a global config file symlink cannot alias an untrusted project config', async (t) => {
  const paths = await setup(t);
  await save(paths.project, { maxConcurrency: 17 });
  await symlink(paths.project, paths.global);
  const config = await loadConfig(paths);
  assert.equal(config.maxConcurrency, 4);
  assert.deepEqual(config.sources, []);
  assert.equal(config.diagnostics.length, 1);
});

test('an agentDir alias preserves missing-file and dangling-symlink diagnostics', async (t) => {
  const paths = await setup(t);
  const alias = join(paths.dir, 'project-agent-alias');
  await symlink(dirname(paths.project), alias);
  const options = { cwd: paths.cwd, agentDir: alias };
  const missing = await loadConfig(options);
  assert.equal(missing.maxConcurrency, 4);
  assert.deepEqual(missing.sources, []);
  assert.deepEqual(missing.diagnostics, []);
  await symlink(join(paths.dir, 'missing.json'), paths.project);
  const dangling = await loadConfig(options);
  assert.equal(dangling.maxConcurrency, 4);
  assert.deepEqual(dangling.sources, []);
  assert.equal(dangling.diagnostics.length, 1);
  assert.ok(dangling.diagnostics[0].includes(paths.project));
});

test('a dangling untrusted config symlink is still reported', async (t) => {
  const paths = await setup(t);
  await symlink(join(paths.dir, 'missing.json'), paths.project);
  const config = await loadConfig(paths);
  assert.equal(config.diagnostics.length, 1);
});

test('custom namespace preserves builtin collisions and custom roles have isolated generic defaults', async (t) => {
  const paths = await setup(t);
  await save(paths.global, { roles: {
    worker: { instructions: 'Builtin addition.' },
    'agent:worker': { instructions: 'Custom worker.' },
    researcher: { model: 'vendor/research', tools: ['read'] },
    mavis: { tools: ['read'], mcp: true },
  } });
  const config = await loadConfig(paths);
  assert.match(profile(config, 'worker').instructions, /Builtin addition/);
  assert.doesNotMatch(profile(config, 'worker').instructions, /Custom worker/);
  const custom = profile(config, 'agent:worker');
  assert.match(custom.instructions, /Custom worker/);
  assert.doesNotMatch(custom.instructions, /Builtin addition/);
  assert.equal(custom.name, 'agent:worker');
  assert.deepEqual(custom.tools, [...readonly, 'bash', 'edit', 'write']);
  assert.equal(custom.mcp, false);
  assert.equal(profile(config, 'agent:researcher').model, 'vendor/research');
  assert.throws(() => profile(config, 'researcher'), /custom roles require agent:<name>/);
  assert.throws(() => profile(config, 'agent:missing'), /unknown role/);
  assert.throws(() => profile(config, 'agent:explore'), /unknown role/);
});

test('input model and effort overrides are explicit, support max, and produce independent frozen profiles', async (t) => {
  const paths = await setup(t);
  const config = await loadConfig(paths);
  for (const effort of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const actual = profile(config, 'worker', { model: 'custom-provider/model/version', effort });
    assert.equal(actual.model, 'custom-provider/model/version');
    assert.equal(actual.thinking, effort);
    assertFrozen(actual);
    assert.notEqual(actual.tools, config.roles.worker.tools);
    assert.throws(() => { actual.tools.push('other'); }, TypeError);
  }
  assert.equal(config.roles.worker.model, 'openai-codex/gpt-6.1-sol');
  assert.equal(config.roles.worker.thinking, 'high');
  for (const model of ['bare', '/id', 'provider/', 'provider//id', 'provider/id/', ' provider/id', 'provider/id with spaces', '', null, 5]) {
    assert.throws(() => profile(config, 'worker', { model }), /expected provider\/id/);
  }
  for (const effort of ['ultra', 'MAX', '', null, 5]) {
    assert.throws(() => profile(config, 'worker', { effort }), /expected one of/);
  }
  assert.throws(() => resolveProfile(config, { agent_name: 'worker', tools: ['write'] }), /unknown key/);
  assert.throws(() => resolveProfile(config, { agent_name: 'worker', run_in_background: 1 }), /expected a boolean/);
  assert.throws(() => resolveProfile(config, { agent_name: 'worker', prompt: 5 }), /expected a string/);
  assert.throws(() => resolveProfile(config, {}), /agent_name/);
});

test('strict JSON schema rejects unknown keys, wrong types, invalid names, and integer boundaries', async (t) => {
  const paths = await setup(t);
  const cases = [
    [null, /expected an object/],
    [[], /expected an object/],
    [{ maxConcurency: 2 }, /unknown key/],
    [{ auth: {} }, /unknown key/],
    ...[0, 65, -1, 1.5, '4', null].map((maxConcurrency) => [{ maxConcurrency }, /expected an integer/]),
    [{ roles: [] }, /expected an object/],
    [{ roles: { 'agent:': {} } }, /invalid role name/],
    [{ roles: { 'bad/name': {} } }, /invalid role name/],
    [{ roles: { constructor: {} } }, /invalid role name/],
    [{ roles: { worker: null } }, /expected an object/],
    [{ roles: { worker: { effort: 'high' } } }, /unknown key/],
    [{ roles: { worker: { model: 'invalid' } } }, /provider\/id/],
    [{ roles: { worker: { thinking: 'unsupported' } } }, /expected one of/],
    [{ roles: { worker: { instructions: [] } } }, /expected a string/],
    [{ roles: { worker: { tools: 'read' } } }, /expected an array/],
    [{ roles: { worker: { tools: ['read', 3] } } }, /expected a string/],
    [{ roles: { worker: { tools: ['read', 'read'] } } }, /duplicate entries/],
    [{ roles: { worker: { extensions: [null] } } }, /expected a string/],
    [{ roles: { worker: { skills: {} } } }, /expected an array/],
    [{ roles: { worker: { mcp: {} } } }, /expected a boolean/],
    ...[-1, 2147483648, 2.5, '100', null].map((timeoutMs) => [{ roles: { worker: { timeoutMs } } }, /expected an integer/]),
    [{ roles: { researcher: {}, 'agent:researcher': {} } }, /duplicate normalized role name/],
  ];
  for (const [value, error] of cases) {
    await save(paths.global, value);
    await assert.rejects(loadConfig(paths), error, JSON.stringify(value));
  }
  for (const [maxConcurrency, timeoutMs] of [[1, 0], [64, 2147483647]]) {
    await save(paths.global, { maxConcurrency, roles: { worker: { timeoutMs, thinking: 'max' } } });
    const config = await loadConfig(paths);
    assert.equal(config.maxConcurrency, maxConcurrency);
    assert.equal(config.roles.worker.timeoutMs, timeoutMs);
  }
  await assert.rejects(loadConfig({ ...paths, projectTrusted: 'true' }), /expected a boolean/);
});

test('trusted project schema is just as strict as global schema', async (t) => {
  const paths = await setup(t);
  await save(paths.project, { roles: { worker: { unknown: true } } });
  await assert.rejects(loadConfig({ ...paths, projectTrusted: true }), /unknown key/);
});

test('read-only builtins never enable write or edit; every role rejects recursive and pattern tools', async (t) => {
  const paths = await setup(t);
  for (const name of ['explore', 'verifier']) for (const tool of ['write', 'edit']) {
    await save(paths.global, { roles: { [name]: { tools: ['read', tool] } } });
    await assert.rejects(loadConfig(paths), /read-only builtins cannot enable/);
  }
  for (const name of ['worker', 'mavis', 'agent:custom']) {
    for (const tool of ['task', 'task_append', 'TASK_output', 'subagent', 'subagent_run', 'mcp__server__task', 'mcp__server__task_append', 'mcp__x__subagent_run']) {
      await save(paths.global, { roles: { [name]: { tools: [tool] } } });
      await assert.rejects(loadConfig(paths), /recursive task and subagent tools are forbidden/);
    }
    for (const tool of ['*', 'task_*', 'mcp__*', 'read write']) {
      await save(paths.global, { roles: { [name]: { tools: [tool] } } });
      await assert.rejects(loadConfig(paths), /use exact tool names/);
    }
  }
});

test('explicit readonly Bash and MCP opt-in remains visible and requires matching permissions', async (t) => {
  const paths = await setup(t);
  await save(paths.global, { roles: { explore: { tools: ['read', 'bash', 'mcp__server__search'], mcp: true } } });
  const config = await loadConfig(paths);
  assert.equal(profile(config, 'explore').mcp, true);
  assert.equal(config.diagnostics.length, 1);
  assert.match(config.diagnostics[0], /not a sandbox/);
  await save(paths.global, { roles: { worker: { tools: ['mcp__server__search'] } } });
  await assert.rejects(loadConfig(paths), /MCP tools require mcp: true/);
});

test('resource paths resolve at the declaring config, replace by layer, and never execute during loading', async (t) => {
  const paths = await setup(t);
  const globalExtension = join(paths.agentDir, 'global.mjs');
  const projectExtension = join(dirname(paths.project), 'project.js');
  const skills = join(paths.agentDir, 'skills');
  await mkdir(skills);
  await Promise.all([
    writeFile(globalExtension, 'throw new Error("config must not execute extensions");'),
    writeFile(projectExtension, 'throw new Error("config must not execute extensions");'),
    writeFile(join(skills, 'SKILL.md'), 'A fixture skill.'),
  ]);
  await save(paths.global, { roles: { worker: { extensions: ['./global.mjs'], skills: ['./skills'] } } });
  await save(paths.project, { roles: { worker: { extensions: ['./project.js'], skills: [] } } });
  const global = await loadConfig(paths);
  assert.deepEqual(profile(global, 'worker').extensions, [globalExtension]);
  assert.deepEqual(profile(global, 'worker').skills, [skills]);
  const trusted = await loadConfig({ ...paths, projectTrusted: true });
  assert.deepEqual(profile(trusted, 'worker').extensions, [projectExtension]);
  assert.deepEqual(profile(trusted, 'worker').skills, []);
});

test('resource loading rejects own plugin paths, symlink aliases, packages, missing entries, and directories as extensions', async (t) => {
  const paths = await setup(t);
  const alias = join(paths.agentDir, 'alias');
  await symlink(root, alias);
  const cases = [
    ['extensions', [join(root, 'src/config.ts')], /cannot load itself/],
    ['extensions', ['./alias/src/config.ts'], /cannot load itself/],
    ['skills', ['./alias'], /cannot load itself/],
    ['extensions', ['npm:some-extension'], /explicit local paths/],
    ['extensions', ['https://example.com/extension.js'], /explicit local paths/],
    ['skills', ['git:example/repo'], /explicit local paths/],
    ['skills', ['~/some-skill'], /explicit local paths/],
    ['extensions', ['./*.js'], /explicit local paths/],
    ['extensions', ['./missing.js'], /must exist/],
    ['extensions', [paths.agentDir], /explicit local JavaScript or TypeScript entry files/],
  ];
  for (const [key, entries, error] of cases) {
    await save(paths.global, { roles: { worker: { [key]: entries } } });
    await assert.rejects(loadConfig(paths), error);
  }
});

test('all role prompts retain deliverable gates and reports without host-specific APIs or root routing', async () => {
  const prompts = Object.fromEntries(await Promise.all(['explore', 'worker', 'verifier', 'mavis'].map(async (name) =>
    [name, await readFile(resolve(root, 'prompts/' + name + '.md'), 'utf8')])));
  for (const prompt of Object.values(prompts)) {
    assert.match(prompt, /do not inherit/);
    assert.match(prompt, /Do not delegate/);
    assert.match(prompt, /Return:/);
    assert.doesNotMatch(prompt, /task_output|run_in_background|final_text|deliver-assets|<media|\{\{|Task Routing|ROLE_DIRECTORY|\bglob\b/);
  }
  assert.match(prompts.explore, /ROLE_MISMATCH/);
  assert.match(prompts.explore, /Inferences/);
  assert.match(prompts.worker, /Validation run and observed results/);
  assert.match(prompts.verifier, /ROLE_MISMATCH/);
  assert.match(prompts.verifier, /VERDICT: PASS \| FAIL \| PARTIAL/);
  assert.match(prompts.verifier, /explicitly designated temporary location/);
  assert.match(prompts.mavis, /Core Judgment/);
  assert.match(prompts.mavis, /unverified/);
});
