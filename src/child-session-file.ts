import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { hasCode } from './guards.ts'

const leases = new Set<string>()

/** One live SDK writer per real session file, including hard-link aliases. */
export async function acquireSessionLease(path: string): Promise<() => void> {
  const file = await stat(path, { bigint: true })
  const key = `${file.dev}:${file.ino}`
  if (leases.has(key)) {
    throw new Error('Child session is already leased')
  }
  leases.add(key)
  return () => {
    leases.delete(key)
  }
}

/** A continuation must reuse existing child history, never recreate a deleted session. */
export async function assertSessionFile(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
      return undefined
    }
    throw error
  })
  if (!info?.isFile()) {
    throw Object.assign(new Error(`Task child session not found: ${path}`), {
      code: 'TASK_CHILD_NOT_FOUND',
      status: 404
    })
  }
}

export async function prepareSession(
  path: string,
  cwd: string,
  managerType: Pick<typeof SessionManager, 'open'>
): Promise<SessionManager> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (!(await lstat(dir)).isDirectory()) {
    throw new Error('Session directory must not be a symlink')
  }
  await chmod(dir, 0o700)
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600
  )
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error('Session path must be a regular file')
    }
    await handle.chmod(0o600)
    const text = await handle.readFile('utf8')
    if (text.trim()) {
      const entries: unknown[] = []
      for (const line of text.split('\n')) {
        if (!line.trim()) {
          continue
        }
        try {
          entries.push(JSON.parse(line))
        } catch {
          // Pi skips torn or malformed JSONL records and repairs a missing final
          // newline on open; mirror that so a crashed append stays resumable.
        }
      }
      const header = entries[0]
      if (
        !header ||
        typeof header !== 'object' ||
        !('type' in header) ||
        header.type !== 'session' ||
        !('id' in header) ||
        typeof header.id !== 'string'
      ) {
        throw new Error('Session file requires a Pi session header')
      }
      if (!('cwd' in header) || typeof header.cwd !== 'string' || resolve(header.cwd) !== cwd) {
        throw new Error('Session working directory does not match')
      }
    }
  } finally {
    await handle.close()
  }
  // Opening an existing empty file makes Pi flush its header at this exact path.
  const manager = managerType.open(path, dir, cwd)
  if (manager.getSessionFile() !== path) {
    throw new Error('Pi changed the assigned session path')
  }
  await chmod(path, 0o600)
  return manager
}
