import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

export type InitialSkillRejectionReason =
  | 'disabled_model_invocation'
  | 'outside_role_scope'
  | 'project_untrusted'
  | 'not_available'

export interface DiagnosticFields {
  parent_id?: string
  task_id?: string
  session_id?: string
  agent_name?: string
  status?: string
  tool_name?: string
  requested_count?: number
  available_count?: number
  rejected_skills?: readonly { name: string; reason: InitialSkillRejectionReason }[]
  error?: unknown
}

export function redactDiagnosticText(text: unknown): string {
  // A fixed :// prefix and disjoint userinfo ranges keep all URI schemes linear.
  return String(text)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[redacted]'
    )
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [redacted]')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret)["']?\s*[:=]\s*)(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[^\s"',}<>]+)/gi,
      '$1[redacted]'
    )
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, '://[redacted]@')
}

const safeText = (value: unknown, limit = 256): string | undefined =>
  typeof value === 'string' ? redactDiagnosticText(value).slice(0, limit) : undefined

function safeError(error: unknown): Record<string, string | number> | undefined {
  if (typeof error === 'string') {
    return { message: redactDiagnosticText(error).slice(0, 4096) }
  }
  if (!error || typeof error !== 'object') {
    return undefined
  }
  const value = error as { message?: unknown; code?: unknown; stack?: unknown }
  const message = safeText(value.message, 4096)
  const stack = safeText(value.stack, 8192)
  const code =
    typeof value.code === 'number' && Number.isFinite(value.code)
      ? value.code
      : safeText(value.code)
  return {
    ...(message === undefined ? {} : { message }),
    ...(code === undefined ? {} : { code }),
    ...(stack === undefined ? {} : { stack })
  }
}

const maxFileBytes = 1024 * 1024
const dailyFiles = 4
const retainedDays = 7
const reasons = new Set<InitialSkillRejectionReason>([
  'disabled_model_invocation',
  'outside_role_scope',
  'project_untrusted',
  'not_available'
])

/** Private, bounded diagnostics only. Failure must never change task behavior. */
export class DiagnosticLog {
  private readonly directory: string
  private cleanedDay?: string

  constructor(agentDir: string) {
    this.directory = join(agentDir, 'task-agents', 'logs')
  }

  write(level: 'warning' | 'error', event: string, fields: DiagnosticFields): void {
    try {
      const now = new Date()
      const day = now.toISOString().slice(0, 10)
      const record: Record<string, unknown> = {
        timestamp: now.toISOString(),
        pid: process.pid,
        level,
        event: safeText(event)
      }
      // Explicit selection also rejects extra properties supplied by untyped callers.
      for (const key of [
        'parent_id',
        'task_id',
        'session_id',
        'agent_name',
        'status',
        'tool_name'
      ] as const) {
        const value = safeText(fields[key])
        if (value !== undefined) {
          record[key] = value
        }
      }
      for (const key of ['requested_count', 'available_count'] as const) {
        const value = fields[key]
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          record[key] = value
        }
      }
      if (Array.isArray(fields.rejected_skills)) {
        record.rejected_skills = fields.rejected_skills
          .slice(0, 32)
          .flatMap((skill) =>
            skill && typeof skill.name === 'string' && reasons.has(skill.reason)
              ? [{ name: safeText(skill.name), reason: skill.reason }]
              : []
          )
      }
      const error = safeError(fields.error)
      if (error) {
        record.error = error
      }
      const line = Buffer.from(JSON.stringify(record) + '\n')
      if (line.length > 64 * 1024) {
        return
      }
      for (const directory of [join(this.directory, '..'), this.directory]) {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (!lstatSync(directory).isDirectory()) {
          return
        }
        chmodSync(directory, 0o700)
      }
      if (this.cleanedDay !== day) {
        this.clean(now)
        this.cleanedDay = day
      }
      for (let index = 0; index < dailyFiles; index++) {
        const path = join(this.directory, `${day}.${index}.jsonl`)
        const fd = openSync(
          path,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600
        )
        try {
          const stat = fstatSync(fd)
          if (!stat.isFile()) {
            return
          }
          fchmodSync(fd, 0o600)
          if (stat.size + line.length > maxFileBytes) {
            continue
          }
          // One append syscall; never rename/truncate files another process may have open.
          // shortcut: simultaneous writers can exceed the shard cap by their bounded records.
          writeSync(fd, line)
          return
        } finally {
          closeSync(fd)
        }
      }
    } catch {
      // Logging, including malformed error objects/getters, must remain best effort.
    }
  }

  private clean(now: Date): void {
    const oldest = new Date(now.getTime() - (retainedDays - 1) * 86400000)
      .toISOString()
      .slice(0, 10)
    try {
      for (const name of readdirSync(this.directory)) {
        if (/^\d{4}-\d{2}-\d{2}\.[0-3]\.jsonl$/.test(name) && name.slice(0, 10) < oldest) {
          try {
            unlinkSync(join(this.directory, name))
          } catch {
            // Another process may already have removed an expired file.
          }
        }
      }
    } catch {
      // Retention failure must not prevent an append.
    }
  }
}
