import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProfile } from './types.ts';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
export const mcpResources = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];
// Do not expose parent task controls or another delegation entry point in a child.
export const recursiveTools = ['task', 'task_append', 'task_send', 'task_query', 'task_output', 'task_stop', 'task_agents', 'subagent'];
export const taskChildBlockedTools = [...recursiveTools,
  'todo', 'todowrite', 'ask_user', 'ask_user_question', 'create_goal', 'get_goal', 'until'];
export const normalizedSelectorName = (value: string): string => value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
export const normalizeSelector = (values: readonly string[] | undefined): ReadonlySet<string> | undefined => values === undefined
  ? undefined : new Set(values.map(normalizedSelectorName).filter(Boolean));
export const isSelectorMcp = (name: string): boolean => normalizedSelectorName(name).startsWith('mcp__');
export const within = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};
export const isResourceName = (value: string): boolean => !isAbsolute(value) &&
  !value.startsWith('.') && !value.startsWith('~') && !/[\\/]/.test(value) && !/^(?:npm:|git:|https?:|builtin:)/i.test(value);

export async function sameFile(first: string, second: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([stat(first, { bigint: true }), stat(second, { bigint: true })]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function localPaths(paths: readonly string[], cwd: string, extensions: boolean): Promise<string[]> {
  const ownRoot = await realpath(pluginRoot);
  const result: string[] = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !path || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('~') || /[*?{}]/.test(path)) {
      throw new Error('Resources require explicit local paths');
    }
    const actual = await realpath(resolve(cwd, path));
    const info = await stat(actual);
    // The repository contains test fixtures; exclude executable plugin sources, not fixtures.
    if (extensions && (within(resolve(ownRoot, 'src'), actual) || actual === resolve(ownRoot, 'index.ts'))) {
      throw new Error('The task plugin cannot load itself in a child');
    }
    if (extensions) {
      // A separately installed copy is still this plugin, even when its root differs.
      for (let dir = dirname(actual); dir !== dirname(dir) && dir !== ownRoot; dir = dirname(dir)) {
        let manifest: string;
        try { manifest = await readFile(resolve(dir, 'package.json'), 'utf8'); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
          throw error;
        }
        if ((JSON.parse(manifest) as { name?: string }).name === 'pi-task-agents') {
          throw new Error('The task plugin cannot load itself in a child');
        }
        break;
      }
    }
    if (extensions && (!info.isFile() || !/\.(?:[cm]?js|ts)$/.test(actual))) {
      throw new Error('Extensions require explicit local entry files');
    }
    if (!info.isFile() && !info.isDirectory()) throw new Error('Resource must be a regular file or directory');
    result.push(actual);
  }
  return [...new Set(result)];
}

export function roleAllowsTool(role: string, name: string): boolean {
  const normalized = normalizedSelectorName(name);
  if (taskChildBlockedTools.includes(normalized)) return false;
  return !['explore', 'verifier'].includes(role) || !['write', 'edit'].includes(normalized);
}

export function childToolPolicy(profile: AgentProfile, tools: readonly string[], extra?: ReadonlySet<string>,
  serverFor?: (tool: string) => string | undefined): (name: string) => boolean {
  const exact = normalizeSelector(tools)!;
  const blocked = normalizeSelector(profile.disallowedTools);
  const ceiling = normalizeSelector(profile.nativeToolSnapshot);
  const nativeScope = !tools.some(isSelectorMcp);
  const servers = normalizeSelector(profile.mcpServers);
  return (name) => {
    const normalized = normalizedSelectorName(name);
    const pluginTool = extra?.has(name) === true;
    if (!roleAllowsTool(profile.name, name) || blocked?.has(normalized)) return false;
    if (isSelectorMcp(name)) {
      if (profile.mcp === false || servers?.size === 0) return false;
      if (servers) {
        const server = serverFor?.(name);
        if (!server || !servers.has(normalizedSelectorName(server))) return false;
      }
      return nativeScope || exact.has(normalized);
    }
    if (mcpResources.includes(normalized) && (profile.mcp === false || servers?.size === 0)) return false;
    const discovery = normalized === 'codemode' ? !ceiling || ceiling.has(normalized)
      : nativeScope && profile.mcp !== false && servers?.size !== 0 && normalized === 'tool_search';
    if (nativeScope && pluginTool || discovery) return true;
    return exact.has(normalized) && (pluginTool || !ceiling || ceiling.has(normalized));
  };
}
