import type { BigIntStats } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProfile, ConfigLoadOptions, TaskAgentsConfig } from './types.ts';

type RoleOptions = Partial<Omit<AgentProfile, 'name'>>;

interface ParsedConfig {
  maxConcurrency?: number;
  roles: Record<string, RoleOptions>;
}

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const builtins: readonly string[] = ['explore', 'worker', 'verifier', 'mavis'];
// Pi 1.5.0: @earendil-works/pi-agent-core/dist/types.d.ts, ThinkingLevel.
const thinkingLevels: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const readTools: readonly string[] = ['read', 'grep', 'find', 'ls'];
const roleKeys: readonly string[] = [
  'model', 'thinking', 'instructions', 'tools', 'extensions', 'skills', 'mcp', 'timeoutMs',
];
const taskKeys: readonly string[] = [
  'agent_name', 'model', 'effort', 'prompt', 'description', 'run_in_background',
];

function recursive(name: string): boolean {
  return /(?:^|__)(?:task(?:_|$)|subagent(?:_|$))/i.test(name);
}

function isMcp(name: string): boolean {
  return name.startsWith('mcp__') ||
    ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name);
}

function own(object: object, key: PropertyKey): boolean {
  return Object.hasOwn(object, key);
}

function fail(path: string, message: string): never {
  throw new Error(path + ': ' + message);
}

function object(
  value: unknown,
  path: string,
  keys?: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(path, 'expected an object');
  }
  if (keys) {
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) fail(path + '.' + key, 'unknown key');
    }
  }
}

function text(value: unknown, path: string, empty: boolean = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim())) {
    fail(path, 'expected a string' + (empty ? '' : ' that is not empty'));
  }
}

function integer(value: unknown, path: string, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, 'expected an integer from ' + min + ' to ' + max);
  }
}

function model(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/]+(?:\/[^\s/]+)*$/.test(value)) {
    fail(path, 'expected provider/id (no whitespace or empty segments); models are never substituted');
  }
}

function thinking(value: unknown, path: string): asserts value is AgentProfile['thinking'] {
  if (typeof value !== 'string' || !thinkingLevels.includes(value)) {
    fail(path, 'expected one of ' + thinkingLevels.join(', '));
  }
}

function strings(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) fail(path, 'expected an array of strings');
  value.forEach((item: unknown, index: number) => text(item, path + '[' + index + ']'));
  if (new Set(value).size !== value.length) fail(path, 'duplicate entries are not allowed');
}

function roleName(value: string, path: string): string {
  const name = value.startsWith('agent:') ? value.slice(6) : value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ||
      ['__proto__', 'constructor', 'prototype'].includes(name)) {
    fail(path, 'invalid role name');
  }
  return builtins.includes(value) ? value : 'agent:' + name;
}

function checkRole(role: unknown, name: string, path: string): asserts role is RoleOptions {
  object(role, path, roleKeys);
  if (own(role, 'model')) model(role.model, path + '.model');
  if (own(role, 'thinking')) thinking(role.thinking, path + '.thinking');
  if (own(role, 'instructions')) text(role.instructions, path + '.instructions', true);
  const tools = own(role, 'tools') ? role.tools : [];
  strings(tools, path + '.tools');
  for (const key of ['extensions', 'skills']) {
    if (own(role, key)) strings(role[key], path + '.' + key);
  }
  if (own(role, 'mcp') && typeof role.mcp !== 'boolean') fail(path + '.mcp', 'expected a boolean');
  if (own(role, 'timeoutMs')) integer(role.timeoutMs, path + '.timeoutMs', 0, 2147483647);
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tool)) {
      fail(path + '.tools', 'use exact tool names, without patterns');
    }
    if (recursive(tool)) fail(path + '.tools', 'recursive task and subagent tools are forbidden');
    if (['explore', 'verifier'].includes(name) && /^(?:write|edit)$/i.test(tool)) {
      fail(path + '.tools', 'read-only builtins cannot enable write or edit');
    }
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach((child: unknown) => freeze(child));
    Object.freeze(value);
  }
  return value;
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
}

async function resourcePaths(paths: readonly string[], file: string, key: string): Promise<string[]> {
  const result: string[] = [];
  const root = await realpath(pluginRoot);
  for (const path of paths) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('~') || /[*?{}]/.test(path)) {
      fail(file + '.' + key, 'resources require explicit local paths, not packages, URLs, or patterns');
    }
    let actual: string;
    try {
      actual = await realpath(resolve(dirname(file), path));
    } catch {
      fail(file + '.' + key, 'resource path must exist: ' + path);
    }
    // Canonical paths prevent symlink aliases from loading this plugin into a child.
    if (within(root, actual)) fail(file + '.' + key, 'the task plugin cannot load itself in a child');
    const info = await stat(actual);
    if (key.endsWith('.extensions') && (!info.isFile() || !/\.(?:[cm]?js|ts)$/.test(actual))) {
      fail(file + '.' + key, 'extensions require explicit local JavaScript or TypeScript entry files');
    }
    if (!info.isFile() && !info.isDirectory()) fail(file + '.' + key, 'expected a regular file or directory');
    if (result.includes(actual)) fail(file + '.' + key, 'duplicate resource paths are not allowed');
    result.push(actual);
  }
  return result;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function sameConfigFile(first: string, second: string): Promise<boolean> {
  if (first === second) return true;
  const identity = async (file: string): Promise<BigIntStats | undefined> => {
    try {
      return await stat(file, { bigint: true });
    } catch (error: unknown) {
      if (isMissing(error)) return;
      throw error;
    }
  };
  // File identity covers aliases in either the filename or an ancestor directory.
  const [left, right] = await Promise.all([identity(first), identity(second)]);
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

async function readConfig(file: string): Promise<ParsedConfig | undefined> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch {
    fail(file, 'invalid JSON');
  }
  object(config, file, ['maxConcurrency', 'roles']);
  let maxConcurrency: number | undefined;
  if (own(config, 'maxConcurrency')) {
    integer(config.maxConcurrency, file + '.maxConcurrency', 1, 64);
    maxConcurrency = config.maxConcurrency;
  }
  if (own(config, 'roles')) object(config.roles, file + '.roles');
  const roles: Record<string, RoleOptions> = Object.create(null);
  const configuredRoles = config.roles ?? {};
  object(configuredRoles, file + '.roles');
  for (const [key, value] of Object.entries(configuredRoles)) {
    const name = roleName(key, file + '.roles.' + key);
    if (own(roles, name)) fail(file + '.roles.' + key, 'duplicate normalized role name: ' + name);
    checkRole(value, name, file + '.roles.' + key);
    const override = { ...value };
    for (const resource of ['extensions', 'skills'] as const) {
      if (own(value, resource)) {
        override[resource] = await resourcePaths(value[resource]!, file, 'roles.' + key + '.' + resource);
      }
    }
    roles[name] = override;
  }
  return { ...(maxConcurrency === undefined ? {} : { maxConcurrency }), roles };
}

function mergeRole(base: AgentProfile, override: RoleOptions): AgentProfile {
  return {
    ...base,
    ...override,
    instructions: [base.instructions, override.instructions].filter(Boolean).join('\n\n'),
  };
}

function checkEffective(role: AgentProfile, name: string): void {
  const { name: ignored, ...options } = role;
  checkRole(options, name, 'roles.' + name);
  if (!role.mcp && role.tools.some(isMcp)) fail('roles.' + name + '.tools', 'MCP tools require mcp: true');
}

/**
 * Strict JSON schema: { maxConcurrency?: integer 1..64, roles?: Record<string, {
 * model?: provider/id, thinking?: off|minimal|low|medium|high|xhigh|max,
 * instructions?: string, tools?: string[], extensions?: localPath[],
 * skills?: localPath[], mcp?: boolean, timeoutMs?: integer 0..2147483647
 * }> }. All unknown keys, duplicate list entries and normalized role names fail.
 *
 * Builtin bare keys override builtins; every other key defines an agent:<name>.
 * agent:worker is independent of builtin worker. Custom roles inherit mavis defaults.
 * Layers: defaults < global < trusted project. Instructions append; other fields
 * replace. Paths must exist and are relative to their declaring config file.
 * Project trust allows explicit capability changes. Bash, MCP, and executable
 * extensions are not sandboxed; the parent remains responsible for their effects.
 * Credentials and parent runtime settings are never read or copied here.
 */
export async function loadConfig({
  cwd,
  agentDir,
  projectTrusted = false,
}: Partial<ConfigLoadOptions> = {}): Promise<TaskAgentsConfig> {
  text(cwd, 'cwd');
  text(agentDir, 'agentDir');
  if (typeof projectTrusted !== 'boolean') fail('projectTrusted', 'expected a boolean');
  const roles: Record<string, AgentProfile> = Object.create(null);
  const prompts = await Promise.all(builtins.map((name: string) =>
    readFile(new URL('../prompts/' + name + '.md', import.meta.url), 'utf8')));
  builtins.forEach((name: string, index: number) => {
    roles[name] = {
      name,
      model: 'openai-codex/gpt-6.1-' + (name === 'explore' ? 'terra' : 'sol'),
      thinking: name === 'explore' ? 'medium' : name === 'worker' ? 'high' : 'xhigh',
      instructions: prompts[index].trim(),
      tools: [...readTools, ...(['worker', 'mavis'].includes(name) ? ['bash', 'edit', 'write'] : [])],
      extensions: [],
      skills: [],
      mcp: false,
      timeoutMs: 0,
    };
  });
  // Snapshot the generic default so builtin overrides cannot implicitly grant
  // capabilities to new custom roles.
  const customBase: AgentProfile = { ...roles.mavis };
  const result = {
    cwd: resolve(cwd),
    agentDir: resolve(agentDir),
    maxConcurrency: 4,
    roles,
    diagnostics: [] as string[],
    sources: [] as string[],
  };
  const globalFile = resolve(agentDir, 'task-agents.json');
  const projectFile = resolve(cwd, '.pi/task-agents.json');
  const globalIsProject = !projectTrusted && await sameConfigFile(globalFile, projectFile);
  const files = [...(globalIsProject ? [] : [globalFile]), ...(projectTrusted ? [projectFile] : [])];
  for (const file of new Set(files)) {
    const config = await readConfig(file);
    if (!config) continue;
    result.sources.push(file);
    if (config.maxConcurrency !== undefined) result.maxConcurrency = config.maxConcurrency;
    for (const [name, override] of Object.entries(config.roles)) {
      roles[name] = mergeRole(roles[name] ?? { ...customBase, name }, override);
    }
  }
  if (!projectTrusted) {
    try {
      await lstat(projectFile);
      result.diagnostics.push('Untrusted project configuration ignored: ' + projectFile +
        '. Set projectTrusted: true only after reviewing its instructions, tools, extensions, skills, and MCP access.');
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
  }
  for (const [name, role] of Object.entries(roles)) {
    checkEffective(role, name);
    if (['explore', 'verifier'].includes(name) && (role.tools.includes('bash') || role.mcp || role.extensions.length)) {
      result.diagnostics.push('Read-only role ' + name + ' explicitly enables Bash, MCP, or extensions; ' +
        'these can have side effects and are not a sandbox. The parent must enforce read-only scope.');
    }
  }
  return freeze(result);
}

/** Resolve task input into an independent, deeply frozen effective profile. */
export function resolveProfile(config: TaskAgentsConfig, input: unknown): AgentProfile {
  object(input, 'input', taskKeys);
  text(input.agent_name, 'input.agent_name');
  const name = roleName(input.agent_name, 'input.agent_name');
  if (name !== input.agent_name) fail('input.agent_name', 'custom roles require agent:<name>');
  if (!config?.roles || !own(config.roles, name)) fail('input.agent_name', 'unknown role: ' + name);
  let requestedModel: string | undefined;
  if (own(input, 'model')) {
    model(input.model, 'input.model');
    requestedModel = input.model;
  }
  let requestedEffort: AgentProfile['thinking'] | undefined;
  if (own(input, 'effort')) {
    thinking(input.effort, 'input.effort');
    requestedEffort = input.effort;
  }
  for (const key of ['prompt', 'description']) {
    if (own(input, key)) text(input[key], 'input.' + key, true);
  }
  if (own(input, 'run_in_background') && typeof input.run_in_background !== 'boolean') {
    fail('input.run_in_background', 'expected a boolean');
  }
  const base = config.roles[name];
  const profile: AgentProfile = {
    ...base,
    model: requestedModel ?? base.model,
    thinking: requestedEffort ?? base.thinking,
    tools: [...base.tools],
    extensions: [...base.extensions],
    skills: [...base.skills],
  };
  checkEffective(profile, name);
  return freeze(profile);
}
