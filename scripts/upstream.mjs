import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { portModules, transformChildBashPorts } from './upstream-ports.mjs';

export const repository = 'MiniMax-AI/minimax-code';
export const domainRoot = 'packages/agent-modules/background-task/src';
export const vendorRoot = 'src/vendor/mcode-background-task';
export const modules = [
  'errors.ts', 'id.ts', 'in-memory-output-store.ts', 'in-memory-store.ts',
  'index.ts', 'manager.ts', 'status.ts', 'types.ts',
];
// Watch core producers and child contracts for review; never copy the host runtime.
export const watches = [
  'packages/local-runtime-v2/src/service/turn-system/execution/steering/steer-session.service.ts',
  'packages/local-runtime/src/background-task/turn-id.ts',
  'packages/agent-tools/src/desktop/task-verification.ts',
  'LICENSE',
  'packages/agent-tools/src/desktop/builtin-defs.ts',
  'packages/agent-tools/src/desktop/local-task.ts',
  'packages/agent-tools/src/desktop/local-task-append.ts',
  'packages/agent-tools/src/desktop/local-task-control.ts',
  'packages/agent-tools/src/desktop/local-mavis.ts',
  'packages/local-runtime/src/api/local-task-input.ts',
  'packages/local-runtime/src/api/local-task-runner.ts',
  'packages/local-runtime/src/api/local-task-append.ts',
  'packages/local-runtime/src/api/local-task-append-lifecycle.ts',
  'packages/local-runtime/src/api/local-task-subagents.ts',
  'packages/local-runtime/src/api/local-task-tool-policy.ts',
  'packages/local-runtime/src/api/injected-conversation-task-turn.ts',
  'packages/local-runtime/src/background-task/runner.ts',
  'packages/local-runtime/src/background-task/subagent-task-row.ts',
  'packages/local-runtime/src/background-task/terminal.ts',
  'packages/local-runtime/src/background-task/task-stop.ts',
  'packages/local-runtime/src/background-task/startup-recovery.ts',
  'packages/local-runtime/src/background-task/conversation-delivery.ts',
  'packages/local-runtime/src/turns/file-changes.ts',
  'packages/local-runtime-v2/src/application/session/task-agent-binding-capture.ts',
  'packages/local-runtime-v2/src/service/model-system/catalog/agent-model-selection.ts',
  'packages/local-runtime-v2/src/service/turn-system/agent-host/assembly/local-turn-tool-catalog.ts',
  'packages/local-runtime-v2/src/service/agent/builtin/definitions.ts',
  'packages/local-runtime-v2/src/service/agent/builtin/catalog.ts',
  'packages/local-runtime-v2/assets/agents/builtin-agents.json',
  'packages/local-runtime-v2/assets/agents/_default/prompt-session-branch.md.hbs',
  'packages/local-runtime-v2/assets/agents/_v2/explore.md.hbs',
  'packages/local-runtime-v2/assets/agents/_v2/worker.md.hbs',
  'packages/local-runtime-v2/assets/agents/_v2/verifier.md.hbs',
  'packages/local-runtime-v2/assets/agents/_v2/coding/SYSTEM.md.hbs',
  'packages/local-runtime-v2/assets/agents/_v2/AGENT_CONTEXT.md.hbs',
  'packages/local-runtime-v2/assets/agents/explore/agent.md',
  'packages/local-runtime-v2/assets/agents/worker/agent.md',
  'packages/local-runtime-v2/assets/agents/verifier/agent.md',
  'packages/local-runtime-v2/assets/agents/explore/system-prompt.md.hbs',
  'packages/local-runtime-v2/assets/agents/worker/system-prompt.md.hbs',
  'packages/local-runtime-v2/assets/agents/verifier/system-prompt.md.hbs',
  'packages/agent-core/src/tools/ptc.ts',
  'packages/local-runtime-v2/assets/agents/_v2/PTC_TOOL_CALLS.md.hbs',
].map((source) => ({ source, kind: 'host' }));
const root = fileURLToPath(new URL('../', import.meta.url));
const commitPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const importTransform = 'relative-import-js-to-ts-v1';
const errorTransform = 'background-task-error-fields-v1';
const errorBefore = `export class BackgroundTaskError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BackgroundTaskError';
  }
}`;
const errorAfter = `export class BackgroundTaskError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'BackgroundTaskError';
  }
}`;

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function replaceOnce(content, before, after) {
  if (content.split(before).length !== 2) {
    throw new Error('BackgroundTaskError constructor changed; review the explicit field transform.');
  }
  return content.replace(before, after);
}

// This deliberately supports a small module grammar without a runtime parser dependency.
function transformImports(content, reverse) {
  const tokens = [];
  let pos = 0;
  const unsupported = () => { throw new Error('Unsupported module syntax; review the relative import transform.'); };
  function scan(interpolation = false) {
    let braces = 0;
    while (pos < content.length) {
      const start = pos;
      const char = content[pos++];
      if (/\s/.test(char)) continue;
      if (char === '/' && content[pos] === '/') {
        while (pos < content.length && !/[\r\n]/.test(content[pos])) pos++;
        continue;
      }
      if (char === '/' && content[pos] === '*') {
        const end = content.indexOf('*/', ++pos);
        if (end < 0) unsupported();
        pos = end + 2;
        continue;
      }
      // Slash has lexical ambiguity (division versus regexp); require manual review.
      if (char === '/') unsupported();
      if (char === "'" || char === '"') {
        while (pos < content.length && content[pos] !== char) {
          if (content[pos++] === '\\') pos++;
        }
        if (content[pos++] !== char) unsupported();
        tokens.push({ text: content.slice(start, pos), start, string: true });
      } else if (char === String.fromCharCode(96)) {
        tokens.push({ text: '<template>', start });
        let closed = false;
        while (pos < content.length) {
          const next = content[pos++];
          if (next === '\\') pos++;
          else if (next === String.fromCharCode(96)) { closed = true; break; }
          else if (next === '$' && content[pos] === '{') { pos++; scan(true); }
        }
        if (!closed) unsupported();
        tokens.push({ text: '</template>', start: pos });
      } else {
        if (char === '{') braces++;
        if (char === '}') {
          if (interpolation && braces === 0) return;
          braces--;
        }
        if (/[\w$]/.test(char)) while (pos < content.length && /[\w$]/.test(content[pos])) pos++;
        tokens.push({ text: content.slice(start, pos), start });
      }
    }
    if (interpolation) unsupported();
  }
  scan();
  const replacements = [];
  const rewrite = (token) => {
    if (!token?.string || /[\\\r\n]/.test(token.text)) unsupported();
    const value = token.text.slice(1, -1);
    if ((value.startsWith('./') || value.startsWith('../')) && value.endsWith(reverse ? '.ts' : '.js')) {
      replacements.push(token.start + token.text.length - 4);
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!['import', 'export'].includes(token.text) || tokens[i - 1]?.text === '.') continue;
    let end = i + 1;
    if (token.text === 'import' && tokens[end]?.text === '.') continue;
    if (token.text === 'import' && tokens[end]?.text === '(') {
      if (tokens[end + 2]?.text !== ')') unsupported();
      rewrite(tokens[end + 1]);
      continue;
    }
    if (token.text === 'import' && tokens[end]?.string) { rewrite(tokens[end]); continue; }
    if (tokens[end]?.text === 'type') end++;
    if (token.text === 'export' && !['{', '*'].includes(tokens[end]?.text)) continue;
    const begin = end;
    if (tokens[end]?.text === '{') {
      while (end < tokens.length && tokens[end].text !== '}') end++;
      end++;
    } else {
      while (end < tokens.length && !['from', ';', '}'].includes(tokens[end].text)) end++;
    }
    const clause = tokens.slice(begin, end).map((entry) => entry.text).join(' ');
    const name = '[$A-Za-z_][$\\w]*';
    const named = '\\{(?:\\s*(?:type\\s+)?' + name + '(?:\\s+as\\s+' + name + ')?\\s*,?)*\\s*\\}';
    const namespace = '\\*(?:\\s+as\\s+' + name + ')?';
    const grammar = token.text === 'import'
      ? '(?:' + name + '(?:\\s*,\\s*)?)?(?:' + named + '|' + namespace + ')?'
      : '(?:' + named + '|' + namespace + ')';
    if (!clause || !new RegExp('^(?:' + grammar + ')$').test(clause)) unsupported();
    if (tokens[end]?.text !== 'from') {
      if (token.text === 'export' && tokens[begin]?.text === '{') continue;
      unsupported();
    }
    rewrite(tokens[end + 1]);
    i = end + 1;
  }
  for (const start of replacements.reverse()) content = content.slice(0, start) + (reverse ? '.js' : '.ts') + content.slice(start + 3);
  return content;
}

export function transform(content, transforms, reverse = false) {
  for (const id of reverse ? [...transforms].reverse() : transforms) {
    if (id === importTransform) {
      content = transformImports(content, reverse);
    } else if (id === errorTransform) {
      content = replaceOnce(content, reverse ? errorAfter : errorBefore, reverse ? errorBefore : errorAfter);
    } else if (id === 'child-bash-ports-v1') {
      content = transformChildBashPorts(content, reverse);
    } else {
      throw new Error(`Unknown transform: ${id}`);
    }
  }
  return content;
}

function transformsFor(name) {
  return name === 'errors.ts' ? [importTransform, errorTransform] : [importTransform];
}

function sourceFiles() {
  return [...modules.map(name => ({ source: `${domainRoot}/${name}`, target: `${vendorRoot}/${name}`,
    transforms: transformsFor(name) })), ...portModules];
}

export function makeLock(commit, contents) {
  if (!commitPattern.test(commit)) throw new Error('Expected a full lowercase 40-character commit.');
  return {
    version: 1,
    repository: `https://github.com/${repository}`,
    commit,
    files: sourceFiles().map(({ source, target, transforms }) => {
      const content = contents.get(source);
      const adapted = transform(content, transforms);
      if (transform(adapted, transforms, true) !== content) {
        throw new Error(`Non-reversible transform: ${source}`);
      }
      return { source, target, sha256: sha256(content), adaptedSha256: sha256(adapted), transforms };
    }),
    watch: watches.map((entry) => ({ ...entry, sha256: sha256(contents.get(entry.source)) })),
  };
}

function validateLock(lock) {
  if (lock.version !== 1 || lock.repository !== `https://github.com/${repository}` || !commitPattern.test(lock.commit)) {
    throw new Error('Invalid upstream lock identity or version.');
  }
  const expected = sourceFiles();
  if (lock.files?.length !== expected.length || lock.watch?.length !== watches.length) {
    throw new Error('Unexpected upstream lock inventory; review the manifest.');
  }
  for (const [i, entry] of lock.files.entries()) {
    const spec = expected[i];
    if (entry.source !== spec.source || entry.target !== spec.target ||
        !hashPattern.test(entry.sha256) || !hashPattern.test(entry.adaptedSha256) ||
        JSON.stringify(entry.transforms) !== JSON.stringify(spec.transforms)) {
      throw new Error(`Invalid module lock entry: ${spec.source}`);
    }
  }
  for (const [i, entry] of lock.watch.entries()) {
    if (entry.source !== watches[i].source || entry.kind !== watches[i].kind || !hashPattern.test(entry.sha256)) {
      throw new Error(`Invalid contract lock entry: ${watches[i].source}`);
    }
  }
}

export async function verify(localRoot = root, io = fs, snapshots = new Map()) {
  const lockContent = await io.readFile(join(localRoot, 'upstream.lock.json'), 'utf8');
  snapshots.set('upstream.lock.json', lockContent);
  const lock = JSON.parse(lockContent);
  validateLock(lock);
  for (const entry of lock.files) {
    const content = await io.readFile(join(localRoot, entry.target), 'utf8');
    snapshots.set(entry.target, content);
    if (sha256(content) !== entry.adaptedSha256) {
      throw new Error(`Local vendor modification: ${entry.target}`);
    }
    const original = transform(content, entry.transforms, true);
    if (sha256(original) !== entry.sha256 || transform(original, entry.transforms) !== content) {
      throw new Error(`Source/transform hash mismatch: ${entry.target}`);
    }
  }
  for (const folder of new Set(lock.files.map(entry => dirname(entry.target)))) {
    const names = await io.readdir(join(localRoot, folder));
    const allowed = lock.files.filter(entry => dirname(entry.target) === folder).map(entry => basename(entry.target));
    const extra = names.filter(name => !allowed.includes(name));
    if (extra.length) throw new Error(`Unrecorded vendor files: ${folder}/${extra.join(', ')}`);
  }
  return lock;
}

export function githubSource(run = promisify(execFile)) {
  const api = async (endpoint, raw = false) => {
    try {
      const { stdout } = await run('gh', [
        'api', `repos/${repository}/${endpoint}`, '--hostname', 'github.com', '--method', 'GET',
        '-H', `Accept: ${raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json'}`,
      ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return raw ? stdout : JSON.parse(stdout);
    } catch {
      // Do not echo gh stderr, command environment or credential-related diagnostics.
      throw new Error(`GitHub API request failed: ${endpoint}`);
    }
  };
  return {
    async resolve(ref) {
      if (ref && !commitPattern.test(ref)) throw new Error('--ref requires a full lowercase 40-character commit.');
      const result = await api(`commits/${ref || 'HEAD'}`);
      if (!commitPattern.test(result.sha) || (ref && result.sha !== ref)) throw new Error('GitHub returned an unexpected commit.');
      return result.sha;
    },
    async list(commit) {
      const result = await api(`git/trees/${commit}?recursive=1`);
      if (result.truncated || !Array.isArray(result.tree)) throw new Error('Incomplete GitHub tree; cannot check module inventory.');
      return result.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
    },
    read(commit, path) {
      return api(`contents/${path}?ref=${commit}`, true);
    },
  };
}

export async function inspect(lock, source, ref) {
  const commit = await source.resolve(ref);
  const paths = await source.list(commit);
  const expected = lock.files.map((entry) => entry.source);
  const inventory = [
    ...paths.filter((path) => path.startsWith(`${domainRoot}/`) && /\.tsx?$/.test(path) && !expected.includes(path))
      .map((path) => `added module: ${path}`),
    ...expected.filter((path) => !paths.includes(path)).map((path) => `missing/moved module: ${path}`),
  ];
  const contents = new Map();
  const domain = [];
  const contracts = [];
  for (const entry of [...lock.files, ...lock.watch]) {
    if (!paths.includes(entry.source)) {
      if (!entry.target) contracts.push({ ...entry, missing: true });
      continue;
    }
    const content = await source.read(commit, entry.source);
    contents.set(entry.source, content);
    if (sha256(content) !== entry.sha256) (entry.target ? domain : contracts).push(entry);
  }
  return { commit, contents, inventory, domain, contracts };
}

function report(result, log) {
  log(`Upstream ${repository}@${result.commit}`);
  for (const item of result.inventory) log(item);
  for (const entry of result.domain) log(`domain changed: ${entry.source}`);
  for (const entry of result.contracts) log(`${entry.kind} contract ${entry.missing ? 'missing/moved' : 'changed'}: ${entry.source} (manual review required)`);
}

async function install(localRoot, updates, snapshots, io) {
  const token = randomUUID();
  const staged = [];
  const recovery = [];
  try {
    for (const [target, content] of updates) {
      if (await io.readFile(join(localRoot, target), 'utf8') !== snapshots.get(target)) {
        throw new Error('Local modification during install: ' + target);
      }
      if (content === snapshots.get(target)) continue;
      const path = join(localRoot, target);
      const item = {
        path, content, original: snapshots.get(target), next: path + '.upstream-' + token,
        backup: join(localRoot, '.upstream-old-' + token + '-' + target.replaceAll('/', '-')),
        moved: false, installed: false,
      };
      staged.push(item);
      await io.writeFile(item.next, content, { flag: 'wx' });
    }
    for (const item of staged) {
      if (await io.readFile(item.path, 'utf8') !== item.original) {
        throw new Error('Local modification during install: ' + item.path);
      }
      // Moving captures edits in the check/rename window, including writes through open handles.
      await io.rename(item.path, item.backup);
      item.moved = true;
      recovery.push(item.backup);
      if (await io.readFile(item.backup, 'utf8') !== item.original) {
        throw new Error('Local modification during install: ' + item.path);
      }
      // link fails if an editor recreated the target; never overwrite that new file.
      await io.link(item.next, item.path);
      item.installed = true;
      await io.unlink(item.next);
    }
    for (const [target, content] of updates) {
      if (await io.readFile(join(localRoot, target), 'utf8') !== content) {
        throw new Error('Local modification during install: ' + target);
      }
    }
  } catch (error) {
    for (const item of [...staged].reverse()) {
      if (!item.moved) continue;
      try {
        if (item.installed) {
          const interrupted = item.backup + '.interrupted';
          await io.rename(item.path, interrupted);
          recovery.push(interrupted);
        }
        await io.link(item.backup, item.path);
      } catch {
        // Keep both the current target and original recovery inode if rollback races an editor.
      }
    }
    for (const item of staged) await io.unlink(item.next).catch(() => {});
    if (recovery.length) throw new Error('Sync failed; recovery copies retained: ' + recovery.join(', ') + '; ' + error.message, { cause: error });
    throw error;
  }
  // A later write through an old file handle can still reach a moved inode. Retain it.
  return recovery;
}

export async function sync(localRoot, lock, result, { acceptContractChanges = false, io = fs, log = console.log } = {}) {
  if (result.inventory.length) throw new Error('Module inventory changed; review source/target mappings before syncing.');
  if (result.contracts.some((entry) => entry.missing)) throw new Error('A watched contract is missing/moved; review watch paths before syncing.');
  if (result.contracts.length && !acceptContractChanges) {
    throw new Error('Contract changes require manual adaptation/review; use --accept-contract-changes only after review.');
  }
  const nextLock = makeLock(result.commit, result.contents);
  const updates = nextLock.files.map((entry) => [entry.target, transform(result.contents.get(entry.source), entry.transforms)]);
  updates.push(['upstream.lock.json', `${JSON.stringify(nextLock, null, 2)}\n`]);
  const snapshots = new Map();
  const current = await verify(localRoot, io, snapshots);
  if (JSON.stringify(current) !== JSON.stringify(lock)) throw new Error('Lock changed during sync; retry after review.');
  const recovery = await install(localRoot, updates, snapshots, io);
  if (recovery.length) log(`Original files retained for recovery: ${recovery.join(', ')}`);
  return nextLock;
}

function parseArgs(args) {
  let mode = '--verify';
  let selected = false;
  let ref;
  let acceptContractChanges = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--verify', '--check', '--sync'].includes(arg) && !selected) {
      mode = arg;
      selected = true;
    } else if (arg === '--ref' && ref === undefined) {
      ref = args[++i];
      if (!commitPattern.test(ref || '')) throw new Error('--ref requires a full lowercase 40-character commit.');
    } else if (arg === '--accept-contract-changes' && !acceptContractChanges) {
      acceptContractChanges = true;
    } else {
      throw new Error(`Unknown or repeated argument: ${arg}`);
    }
  }
  if (mode === '--verify' && ref) throw new Error('--verify is offline and does not accept --ref.');
  if (mode === '--sync' && !ref) throw new Error('--sync requires --ref COMMIT.');
  if (acceptContractChanges && mode !== '--sync') throw new Error('--accept-contract-changes requires --sync.');
  return { mode, ref, acceptContractChanges };
}

export async function main(args, { localRoot = root, io = fs, source, log = console.log } = {}) {
  const options = parseArgs(args);
  const lock = await verify(localRoot, io);
  if (options.mode === '--verify') {
    log(`Verified ${lock.files.length} vendor files and reversible transforms at ${lock.commit} (offline).`);
    return 0;
  }
  const result = await inspect(lock, source || githubSource(), options.ref);
  report(result, log);
  if (options.mode === '--check') {
    const changed = result.inventory.length + result.domain.length + result.contracts.length > 0;
    if (!changed) log('No monitored source changes.');
    return changed ? 1 : 0;
  }
  await sync(localRoot, lock, result, { ...options, io, log });
  log('Domain modules and lock updated. Watched contracts/prompts were not copied; run project checks before committing.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
