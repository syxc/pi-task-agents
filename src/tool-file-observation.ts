import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { VerificationReport } from './types.ts'
import { extractToolWritePaths } from './vendor/mcode-adapters/file-write-targets.ts'
import { within } from './resource-selection.ts'
import { buildVerification } from './task-verification.ts'
import { captureWorkspace, type WorkspaceSnapshot } from './workspace-observation.ts'
import { isRecord } from './guards.ts'

interface Run {
  id: string
  signal: AbortSignal
}
interface Observation {
  id: string
  before: Map<string, string>
  after: Map<string, string>
  calls: Map<string, { paths: string[]; targets: string }>
  notes: Set<string>
  errors: Set<string>
  workspace?: Promise<WorkspaceSnapshot>
}
const readonlyTools = new Set(['read', 'grep', 'find', 'ls'])
const shells = new Set(['bash', 'shell', 'sh', 'zsh', 'powershell', 'pwsh'])
const scopeNote =
  'Tool-target metadata only; file contents are not read. Excluded, dynamic or incomplete targets are uncertain. Observed changes are not attributed to this child and are not a universal write audit.'

/** Observe actual native tool calls, including nested codemode calls, without reading file contents. */
export function createToolFileObservation(options: {
  cwd: string
  stateDirectories: readonly string[]
  current(): Run | undefined
  isBuiltin(name: string): boolean
  isProgramTool(name: string): boolean
  shellCommandPrefix?(): string | undefined
}) {
  const root = resolve(options.cwd)
  const excluded = options.stateDirectories.map((path) => resolve(path))
  let state: Observation | undefined
  let canonicalRoot: Promise<string> | undefined
  const active = () => (state && state.id === options.current()?.id ? state : undefined)
  function targets(
    name: string,
    args: Record<string, unknown>
  ): ReturnType<typeof extractToolWritePaths> {
    if (
      options.isBuiltin(name) &&
      ['write', 'edit'].includes(name) &&
      typeof args.path === 'string'
    ) {
      // Pi file tools normalize these spellings; shell paths retain their literal spelling.
      let file = args.path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
      if (file.startsWith('@')) {
        file = file.slice(1)
      }
      if (
        process.platform === 'win32' &&
        file.startsWith('/') &&
        !file.startsWith('//') &&
        !file.includes('\\')
      ) {
        const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(file)
        if (drive) {
          file = `${drive[1].toUpperCase()}:\\${(drive[2] ?? '').replaceAll('/', '\\')}`
        }
      }
      if (
        file === '~' ||
        file.startsWith('~/') ||
        (process.platform === 'win32' && file.startsWith('~\\'))
      ) {
        file = join(homedir(), file.slice(2))
      }
      if (file.startsWith('file://')) {
        file = fileURLToPath(file)
      }
      const absolute = resolve(root, file)
      return {
        kind: 'paths',
        paths: [within(root, absolute) ? relative(root, absolute).split(sep).join('/') : absolute]
      }
    }
    const prefix =
      name === 'bash' && options.isBuiltin(name) ? options.shellCommandPrefix?.() : undefined
    return extractToolWritePaths(
      root,
      name,
      prefix && typeof args.command === 'string'
        ? { ...args, command: `${prefix}\n${args.command}` }
        : args
    )
  }
  async function snapshot(
    observation: Observation,
    file: string,
    deadline = performance.now() + 1000
  ): Promise<string | undefined> {
    const absolute = resolve(root, file)
    if (
      isAbsolute(file) ||
      win32.isAbsolute(file) ||
      !within(root, absolute) ||
      excluded.some((path) => within(path, absolute))
    ) {
      observation.notes.add('target_outside_observation_scope')
      return
    }
    const parts = relative(root, absolute).split(sep)
    if (parts.some((part) => ['.git', 'node_modules', '.pi'].includes(part)) || parts.length > 64) {
      observation.notes.add('target_excluded_or_too_deep')
      return
    }
    try {
      const canonical = await (canonicalRoot ??= realpath(root))
      if ((await realpath(root)) !== canonical) {
        observation.notes.add('workspace_alias_changed')
        return
      }
      for (let index = 0; index < parts.length; index++) {
        if (performance.now() > deadline) {
          observation.errors.add('target_observation_time_limit')
          return
        }
        // oxlint-disable-next-line no-await-in-loop -- Keep bounded metadata checks ordered and preserve early termination.
        const info = await lstat(join(canonical, ...parts.slice(0, index + 1)), { bigint: true })
        if (info.isSymbolicLink()) {
          observation.notes.add('target_symlink_not_followed')
          return
        }
        if (index < parts.length - 1 && !info.isDirectory()) {
          observation.notes.add('target_parent_not_directory')
          return
        }
        if (index === parts.length - 1) {
          return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
        }
      }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unavailable'
      if (code === 'ENOENT') {
        return 'missing'
      }
      observation.errors.add(`target_observation_failed:${code}`)
    }
  }
  async function before(id: string, name: string, input: unknown): Promise<void> {
    const scope = active()
    if (
      !scope ||
      (readonlyTools.has(name) && options.isBuiltin(name)) ||
      options.isProgramTool(name)
    ) {
      return
    }
    const args = isRecord(input) ? input : {}
    const relevant = [
      'file_path',
      'filePath',
      'path',
      'patch',
      'input',
      '_raw',
      'command',
      'cmd',
      'script'
    ]
    if (relevant.some((key) => typeof args[key] === 'string' && args[key].length > 200000)) {
      scope.notes.add('target_input_limit')
      return
    }
    const extracted = targets(name, args)
    if (!options.isBuiltin(name)) {
      scope.notes.add('unrecognized_tool_effects')
    }
    if (
      extracted.kind === 'ambiguous' ||
      (extracted.kind === 'paths' && extracted.ambiguityReason)
    ) {
      scope.notes.add('ambiguous_tool_target')
    }
    const shellFlow =
      shells.has(name) &&
      ((typeof args.command === 'string' && /[;&|\n]/.test(args.command)) ||
        (name === 'bash' && options.isBuiltin(name) && Boolean(options.shellCommandPrefix?.())))
    if (shellFlow) {
      scope.notes.add('ambiguous_shell_control_flow')
    }
    if (
      shells.has(name) &&
      (extracted.kind !== 'paths' || extracted.ambiguityReason || shellFlow)
    ) {
      scope.workspace ??= captureWorkspace(
        root,
        options.stateDirectories,
        options.current()?.signal
      )
      await scope.workspace
      if (extracted.kind === 'ignore') {
        scope.notes.add('ambiguous_shell_effects')
      }
    }
    const paths = extracted.kind === 'paths' ? extracted.paths : []
    if (!paths.length && !shells.has(name)) {
      scope.notes.add('unobserved_tool_targets')
    }
    const selected: string[] = []
    for (const file of paths.slice(0, 64)) {
      if (!scope.before.has(file) && scope.before.size >= 256) {
        scope.notes.add('target_observation_limit')
        break
      }
      // oxlint-disable-next-line no-await-in-loop -- Keep bounded metadata checks ordered and preserve early termination.
      const value = await snapshot(scope, file)
      if (value !== undefined) {
        if (!scope.before.has(file)) {
          scope.before.set(file, value)
        }
        selected.push(file)
      }
    }
    if (paths.length > 64) {
      scope.notes.add('target_observation_limit')
    }
    scope.calls.set(id, { paths: selected, targets: JSON.stringify(extracted) })
  }
  async function after(id: string, name: string, input: unknown, failed: boolean): Promise<void> {
    const scope = active()
    if (
      !scope ||
      (readonlyTools.has(name) && options.isBuiltin(name)) ||
      options.isProgramTool(name)
    ) {
      return
    }
    const capture = scope.calls.get(id)
    if (!capture) {
      scope.notes.add('tool_before_capture_unavailable')
      return
    }
    if (JSON.stringify(targets(name, isRecord(input) ? input : {})) !== capture.targets) {
      scope.notes.add('tool_targets_changed')
    }
    if (failed) {
      scope.notes.add('failed_tool_capture')
    }
    for (const file of capture.paths) {
      // oxlint-disable-next-line no-await-in-loop -- Keep bounded metadata checks ordered and preserve early termination.
      const value = await snapshot(scope, file)
      if (value !== undefined) {
        scope.after.set(file, value)
      }
    }
    scope.calls.delete(id)
  }
  const extension: ExtensionFactory = (pi) => {
    pi.on('tool_call', async (event) => {
      try {
        await before(event.toolCallId, event.toolName, event.input)
      } catch {
        active()?.errors.add('tool_before_observation_failed')
      }
      if (options.current()?.signal.aborted) {
        return { block: true, reason: 'Child aborted during target observation' }
      }
    })
    pi.on('tool_result', async (event) => {
      try {
        await after(event.toolCallId, event.toolName, event.input, event.isError)
      } catch {
        active()?.errors.add('tool_after_observation_failed')
      }
    })
  }
  return {
    extension,
    begin(id: string, workspace?: WorkspaceSnapshot) {
      state = {
        id,
        before: new Map(),
        after: new Map(),
        calls: new Map(),
        notes: new Set(),
        errors: new Set(),
        ...(workspace ? { workspace: Promise.resolve(workspace) } : {})
      }
    },
    baseline(id: string, workspace: WorkspaceSnapshot) {
      if (state?.id === id) {
        state.workspace = Promise.resolve(workspace)
      }
    },
    async finish(id: string): Promise<VerificationReport> {
      const scope = state
      if (!scope || scope.id !== id) {
        throw new Error('File observation owner mismatch')
      }
      if (scope.calls.size) {
        scope.notes.add('unfinished_tool_capture')
        // One deadline for the whole late capture so completion cannot stall per file.
        const deadline = performance.now() + 1000
        for (const capture of scope.calls.values()) {
          for (const file of capture.paths) {
            // oxlint-disable-next-line no-await-in-loop -- Keep bounded metadata checks ordered and preserve early termination.
            const value = await snapshot(scope, file, deadline)
            if (value !== undefined) {
              scope.after.set(file, value)
            }
          }
        }
      }
      const changed = new Set(
        [...scope.before]
          .filter(([file, value]) => scope.after.has(file) && scope.after.get(file) !== value)
          .map(([file]) => file)
          .sort()
      )
      const notes: string[] = [scopeNote]
      if (scope.workspace) {
        const workspaceBefore = await scope.workspace
        const workspaceAfter = await captureWorkspace(root, options.stateDirectories)
        const broad = buildVerification(workspaceBefore, workspaceAfter, '', false)
        for (const file of broad.changedFiles ?? []) {
          changed.add(file)
        }
        notes.push(...broad.observationNotes)
        if (broad.fileChange === 'recording_failed') {
          scope.errors.add('workspace_recording_failed')
        }
      }
      // Reserve capacity for confirmed tool targets before supplemental workspace changes.
      const paths = [...changed]
      const report: VerificationReport = {
        fileChange: scope.errors.size
          ? 'recording_failed'
          : scope.notes.size
            ? 'uncertain'
            : paths.length
              ? 'change_observed'
              : 'no_observed_change',
        ...(!scope.errors.size || paths.length ? { changedFiles: paths.slice(0, 200).sort() } : {}),
        observationNotes: [
          ...notes,
          ...scope.errors,
          ...scope.notes,
          ...(paths.length > 200 ? ['changed_files_truncated'] : [])
        ]
      }
      if (state === scope) {
        state = undefined
      }
      return report
    }
  }
}
