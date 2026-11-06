import type { ExtensionAPI, LoadedMcpConfig, Skill } from '@earendil-works/pi-coding-agent';
import type { HostExtensionResource, HostResources } from './resource-loader.ts';
import { recursiveTools } from './resource-selection.ts';

export interface ParentRuntimeSnapshot {
  resources: HostResources;
  mcp: LoadedMcpConfig | null;
  settings: Pick<ReturnType<ExtensionAPI['getSettings']>, 'shellPath' | 'shellCommandPrefix'>;
}
interface ResourceSnapshot {
  extensions: HostExtensionResource[];
  skills: Skill[];
  mcp: LoadedMcpConfig | null;
}
export type ParentRuntimeAPI = Pick<ExtensionAPI, 'getAllTools' | 'getSettings'> & { getResources?: () => Promise<ResourceSnapshot> };
const missing = () => Object.assign(new Error('Pi SDK resource snapshots are unavailable. Use the compatible SDK resource-snapshot interface; disk discovery is not parent runtime inheritance.'),
  { code: 'PARENT_RESOURCE_SNAPSHOT_REQUIRED' });
const aborted = () => Object.assign(new Error('Parent resource snapshot canceled'), { name: 'AbortError' });

/** Capture approved runtime data only; factories and MCP config must never enter task persistence. */
export async function captureParentRuntime(pi: ParentRuntimeAPI, signal?: AbortSignal): Promise<ParentRuntimeSnapshot> {
  const api = pi;
  if (typeof api.getResources !== 'function') throw missing();
  if (signal?.aborted) throw aborted();
  let remove = () => {};
  const cancellation = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(aborted());
    signal?.addEventListener('abort', abort, { once: true });
    remove = () => signal?.removeEventListener('abort', abort);
  });
  let snapshot: ResourceSnapshot;
  try { snapshot = await Promise.race([api.getResources(), cancellation]); }
  finally { remove(); }
  if (signal?.aborted) throw aborted();
  if (!snapshot || !Array.isArray(snapshot.extensions) || !Array.isArray(snapshot.skills)
    || snapshot.mcp !== null && (!snapshot.mcp || !Array.isArray(snapshot.mcp.servers))) throw missing();
  const recreated = new Set([...recursiveTools, 'codemode', 'tool_search']);
  const excluded = new Set(api.getAllTools().filter(tool => recreated.has(tool.name)).map(tool => tool.sourceInfo.path));
  const extensions = snapshot.extensions.filter(entry => !entry.mcpConnector && !excluded.has(entry.path)
    && !excluded.has(entry.resolvedPath) && !excluded.has(entry.sourceInfo.path));
  const settings = api.getSettings();
  const native: ParentRuntimeSnapshot['settings'] = {};
  for (const key of ['shellPath', 'shellCommandPrefix'] as const) {
    if (settings[key] !== undefined) {
      if (typeof settings[key] !== 'string') throw new Error('Invalid inherited native shell setting: ' + key);
      native[key] = settings[key];
    }
  }
  return { resources: { getExtensions: () => ({ extensions }), getSkills: () => ({ skills: snapshot.skills }) },
    mcp: snapshot.mcp, settings: native };
}
