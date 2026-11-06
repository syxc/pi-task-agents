// Derived from MCode 3c21163c85a9684030cb147bfef48c6284fa3c46, local-runtime/turns/file-changes.ts (MIT).
// Only target extraction is reused; Pi supplies observation, persistence and state-directory filtering.
import path from 'node:path';

const BRAND = { APP_DIR: '.pi' };
const STRUCTURED_WRITE_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'multi_edit',
  'file_edit',
  'apply_patch',
  'notebookedit',
  'notebook_edit',
  'str_replace_editor',
]);
const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'zsh', 'powershell', 'pwsh']);
const SHELL_CONTROL_TOKENS = new Set(['&&', '||', ';', '|']);
const TURN_FILE_CHANGE_FILTER_DIR_NAMES = new Set(['.git', '.harness-def']);
const TURN_FILE_CHANGE_FILTER_PREFIXES = [
  '.git/',
  '.harness-def/',
  `${BRAND.APP_DIR}/plans/`,
  `${BRAND.APP_DIR}/handoffs/`,
] as const;

type ExtractToolPathsResult =
  | { kind: 'ignore' }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'paths'; paths: string[]; ambiguityReason?: string };

export function extractToolWritePaths(
  workspaceDir: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): ExtractToolPathsResult {
  const normalizedToolName = toolName.toLowerCase().replaceAll('-', '_');
  const paths = new Set<string>();

  if (STRUCTURED_WRITE_TOOLS.has(normalizedToolName)) {
    const primaryPath = getStringArg(toolArgs, ['file_path', 'filePath', 'path']);
    if (primaryPath) {
      const relative = normalizeCapturePath(workspaceDir, primaryPath);
      if (relative) paths.add(relative);
    }
    const patch = getStringArg(toolArgs, ['patch', 'input', '_raw']);
    if (patch) {
      for (const filePath of parsePatchPaths(patch)) {
        const relative = normalizeCapturePath(workspaceDir, filePath);
        if (relative) paths.add(relative);
      }
    }
    return paths.size > 0 ? { kind: 'paths', paths: [...paths].sort() } : { kind: 'ignore' };
  }

  if (!SHELL_TOOLS.has(normalizedToolName)) return { kind: 'ignore' };
  const command = getStringArg(toolArgs, ['command', 'cmd', 'script', 'input', '_raw']);
  if (!command) return { kind: 'ignore' };

  for (const filePath of parsePatchPaths(command)) {
    const relative = normalizeCapturePath(workspaceDir, filePath);
    if (relative) paths.add(relative);
  }

  const tokens = shellTokenize(command);
  const ambiguous = [
    extractShellRedirectTargets(workspaceDir, tokens, paths),
    extractShellToolTargets(workspaceDir, tokens, paths),
    extractFormatterTargets(workspaceDir, tokens, paths),
  ].some(Boolean);

  if (paths.size > 0) {
    return {
      kind: 'paths',
      paths: [...paths].sort(),
      ...(ambiguous ? { ambiguityReason: 'shell_target_ambiguous' } : {}),
    };
  }
  return ambiguous ? { kind: 'ambiguous', reason: 'shell_target_ambiguous' } : { kind: 'ignore' };
}

function getStringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function parsePatchPaths(patch: string): string[] {
  const paths: string[] = [];
  const patterns = [
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    /^\+\+\+ b\/(.+)$/gm,
    /^--- a\/(.+)$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of patch.matchAll(pattern)) {
      const filePath = match[1]?.trim();
      if (filePath && filePath !== '/dev/null') paths.push(filePath);
    }
  }
  return paths;
}

function extractShellRedirectTargets(
  workspaceDir: string,
  tokens: string[],
  paths: Set<string>,
): boolean {
  let ambiguous = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const separateRedirect = /^(?:\d+)?(?:>|>>|&>)$/.test(token);
    if (separateRedirect) {
      if (collectPathToken(workspaceDir, tokens[index + 1], paths) === 'ambiguous') {
        ambiguous = true;
      }
      index += 1;
      continue;
    }

    const attached = /^(?:\d+)?(?:>|>>|&>)(.+)$/.exec(token);
    if (attached?.[1] && collectPathToken(workspaceDir, attached[1], paths) === 'ambiguous') {
      ambiguous = true;
    }
  }
  return ambiguous;
}

function extractShellToolTargets(
  workspaceDir: string,
  tokens: string[],
  paths: Set<string>,
): boolean {
  let ambiguous = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const command = path.basename(token);

    if (command === 'tee') {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const target = tokens[cursor]!;
        if (SHELL_CONTROL_TOKENS.has(target)) break;
        if (target.startsWith('-')) continue;
        if (collectPathToken(workspaceDir, target, paths) === 'ambiguous') ambiguous = true;
      }
      continue;
    }

    if (command === 'cp' || command === 'mv') {
      const candidates = tokens
        .slice(index + 1)
        .filter((item) => !SHELL_CONTROL_TOKENS.has(item) && !item.startsWith('-'));
      if (candidates.length === 2) {
        if (
          command === 'mv' &&
          collectPathToken(workspaceDir, candidates[0], paths) === 'ambiguous'
        ) {
          ambiguous = true;
        }
        if (collectPathToken(workspaceDir, candidates[1], paths) === 'ambiguous') ambiguous = true;
      } else if (candidates.length > 2) {
        ambiguous = true;
      }
      continue;
    }

    if (
      command === 'sed' &&
      tokens.slice(index + 1).some((item) => item === '-i' || item.startsWith('-i'))
    ) {
      const editFlagIndex = tokens.findIndex(
        (item, itemIndex) => itemIndex > index && (item === '-i' || item.startsWith('-i')),
      );
      if (editFlagIndex >= 0) {
        let cursor = editFlagIndex + 1;
        if (tokens[editFlagIndex] === '-i' && tokens[cursor] === '') cursor += 1;
        cursor += 1;
        for (; cursor < tokens.length; cursor += 1) {
          const target = tokens[cursor]!;
          if (SHELL_CONTROL_TOKENS.has(target)) break;
          if (target.startsWith('-')) continue;
          if (collectPathToken(workspaceDir, target, paths) === 'ambiguous') ambiguous = true;
        }
      }
    }
  }
  return ambiguous;
}

function extractFormatterTargets(
  workspaceDir: string,
  tokens: string[],
  paths: Set<string>,
): boolean {
  let ambiguous = false;
  const writeFlagIndex = tokens.findIndex((token) => token === '--write' || token === '--fix');
  if (writeFlagIndex < 0) return false;
  for (let index = writeFlagIndex + 1; index < tokens.length; index += 1) {
    const target = tokens[index]!;
    if (SHELL_CONTROL_TOKENS.has(target)) break;
    if (target.startsWith('-')) continue;
    if (collectPathToken(workspaceDir, target, paths) === 'ambiguous') ambiguous = true;
  }
  return ambiguous;
}

function collectPathToken(
  workspaceDir: string,
  token: string | undefined,
  paths: Set<string>,
): 'ok' | 'ambiguous' {
  if (!token || isDiscardTarget(token)) return 'ok';
  if (hasDynamicShellPathToken(token)) return 'ambiguous';
  const relative = normalizeCapturePath(workspaceDir, token);
  if (!relative) return token === '.' || token.endsWith('/') ? 'ambiguous' : 'ok';
  paths.add(relative);
  return 'ok';
}

function normalizeCapturePath(workspaceDir: string, filePath: string): string | undefined {
  let trimmed = filePath.trim();
  if (!trimmed || isDiscardTarget(trimmed)) return undefined;
  // Convert MSYS-style paths (/c/Users/...) to Windows paths on win32.
  // Git Bash output uses this format; path.resolve() would misinterpret it.
  if (process.platform === 'win32') {
    const msysMatch = trimmed.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (msysMatch) {
      const drive = msysMatch[1]!.toUpperCase();
      const rest = msysMatch[2]?.replace(/\//g, '\\') ?? '\\';
      trimmed = `${drive}:${rest}`;
    }
  }
  const root = path.resolve(workspaceDir);
  const absolute = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.win32.isAbsolute(trimmed)
      ? path.win32.resolve(trimmed)
      : path.resolve(root, trimmed);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) return absolute;
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative || isFilteredRelativePath(relative)) return undefined;
  return relative;
}

function hasDynamicShellPathToken(token: string): boolean {
  return (
    /\$\{?[\w@*]/.test(token) ||
    token.includes('$(') ||
    token.includes('`') ||
    /[*?[]/.test(token) ||
    token.startsWith('<(') ||
    token.startsWith('>(') ||
    token.startsWith('~')
  );
}

function isDiscardTarget(token: string): boolean {
  return (
    token === '/dev/null' ||
    token === '/dev/stdout' ||
    token === '/dev/stderr' ||
    token === '/dev/tty' ||
    /^&\d+$/.test(token) ||
    token === '&-'
  );
}

function isFilteredRelativePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => TURN_FILE_CHANGE_FILTER_DIR_NAMES.has(part))) return true;
  if (
    parts.some(
      (part, index) =>
        part === BRAND.APP_DIR && (parts[index + 1] === 'plans' || parts[index + 1] === 'handoffs'),
    )
  ) {
    return true;
  }
  return TURN_FILE_CHANGE_FILTER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function shellTokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  const flush = (): void => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      const next = input[index + 1];
      if (next === '\n') {
        index += 1;
        continue;
      }
      if (next === '\r' && input[index + 2] === '\n') {
        index += 2;
        continue;
      }
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (isShellWhitespace(ch) && !inSingleQuote && !inDoubleQuote) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

function isShellWhitespace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 32 || (code >= 9 && code <= 13);
}
