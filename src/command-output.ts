import {
  constants,
  lstatSync,
  linkSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readCommandFd, type CommandLogs } from './command-journal.ts'
import { hasCode, isRecord } from './guards.ts'

const textOf = (value: unknown): string => {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return ''
  }
  return value.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n')
}

/** Accept native artifacts only from the live native call, never from history or caller-provided URIs. */
export class CommandOutput {
  private readonly logs: CommandLogs
  private readonly id: string
  private readonly changed: () => void
  private readonly handles = new Set<FileHandle>()
  private writer?: FileHandle
  private source?: { handle: FileHandle; path: string }
  private watcher?: FSWatcher
  private opening?: Promise<void>
  private adoptionFailed = false
  private nativePath?: string
  private nativeTruncated = false
  private prefix = ''
  private aligned?: boolean
  incomplete = false
  private constructor(logs: CommandLogs, id: string, changed: () => void) {
    this.logs = logs
    this.id = id
    this.changed = changed
  }
  static async create(logs: CommandLogs, id: string, changed: () => void) {
    const output = new CommandOutput(logs, id, changed)
    output.writer = await logs.createHandle(id)
    output.handles.add(output.writer)
    return output
  }
  get hasOpenResources(): boolean {
    return this.handles.size > 0 || this.watcher !== undefined
  }
  private async adopt(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    this.handles.add(handle)
    try {
      const info = await handle.stat()
      if (
        !info.isFile() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      ) {
        throw new Error('Native output identity is unavailable')
      }
      this.watcher = watch(path, () => this.changed())
      this.watcher.on('error', () => {
        this.incomplete = true
        this.changed()
      })
      this.source = { handle, path }
    } catch (error) {
      await this.closeHandle(handle)
      throw error
    }
  }
  update(value: unknown): void {
    try {
      const details = isRecord(value) && isRecord(value.details) ? value.details : {}
      const path = details.fullOutputPath
      const truncated = isRecord(details.truncation) && details.truncation.truncated === true
      this.nativeTruncated ||= truncated
      if (
        !this.source &&
        !this.opening &&
        !this.adoptionFailed &&
        typeof path === 'string' &&
        /^pi-bash-[a-f0-9]{16}\.log$/.test(basename(path)) &&
        realpathSync(dirname(path)) === realpathSync(tmpdir())
      ) {
        this.nativePath = path
        this.opening = this.adopt(path)
          .catch((error) => {
            if (!hasCode(error, 'ENOENT')) {
              this.incomplete = true
              this.adoptionFailed = true
            }
          })
          .finally(() => {
            this.opening = undefined
            this.changed()
          })
      }
      const text = textOf(value)
      if (!this.source && !truncated && text.startsWith(this.prefix)) {
        if (this.writer) {
          this.logs.append(this.writer.fd, Buffer.from(text.slice(this.prefix.length)))
        }
        this.prefix = text
      }
    } catch {
      this.incomplete = true
    }
    this.changed()
  }
  // A decoded prefix and the raw source share byte cursors only when their bytes agree.
  private sourceAligned(source: { handle: FileHandle }): boolean {
    if (this.aligned === undefined) {
      const expected = Buffer.byteLength(this.prefix)
      const bytes = Buffer.alloc(expected)
      let offset = 0
      while (offset < expected) {
        const count = readSync(source.handle.fd, bytes, offset, expected - offset, offset)
        if (count === 0) {
          break
        }
        offset += count
      }
      this.aligned = offset === expected && bytes.toString('utf8') === this.prefix
      if (!this.aligned) {
        this.incomplete = true
      }
    }
    return this.aligned
  }
  read(offset: number) {
    const source = this.source
    if (source && source.handle.fd >= 0 && this.sourceAligned(source)) {
      return readCommandFd(source.handle.fd, offset)
    }
    return this.logs.read(this.id, offset)
  }
  private async closeHandle(handle: FileHandle): Promise<void> {
    await handle.close()
    this.handles.delete(handle)
  }
  async close(): Promise<void> {
    const errors: unknown[] = []
    try {
      this.watcher?.close()
      this.watcher = undefined
    } catch (error) {
      errors.push(error)
    }
    const results = await Promise.allSettled(
      [...this.handles].map((handle) => this.closeHandle(handle))
    )
    errors.push(
      ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    )
    if (this.writer && !this.handles.has(this.writer)) {
      this.writer = undefined
    }
    if (this.source && !this.handles.has(this.source.handle)) {
      this.source = undefined
    }
    if (errors.length) {
      throw new AggregateError(errors, 'Command output cleanup is unconfirmed')
    }
  }
  async finish(value?: unknown): Promise<void> {
    let error: unknown
    try {
      await this.persist(value)
    } catch (failure) {
      this.incomplete = true
      error = failure
    }
    try {
      await this.close()
    } catch (failure) {
      // oxlint-disable-next-line preserve-caught-error -- AggregateError already retains each original failure in errors.
      throw new AggregateError(
        error ? [error, failure] : [failure],
        'Command output finalization failed'
      )
    }
    if (error) {
      throw error
    }
    this.changed()
  }
  private async persist(value?: unknown): Promise<void> {
    await this.opening
    if (value) {
      this.update(value)
    }
    // Abort/timeout errors omit metadata; retry the live producer's validated path after its flush.
    if (!this.source && !this.opening && this.nativePath) {
      this.update({ details: { fullOutputPath: this.nativePath } })
    }
    await this.opening
    if (!this.source) {
      const structured =
        isRecord(value) && isRecord(value.structuredContent) ? value.structuredContent : {}
      const output =
        typeof structured.output === 'string' && structured.truncated !== true
          ? structured.output
          : undefined
      if (output !== undefined && this.writer) {
        await this.writer.truncate(0)
        this.logs.append(this.writer.fd, Buffer.from(output), 0)
      } else if (this.writer) {
        if (this.nativeTruncated || structured.truncated === true) {
          this.incomplete = true
        }
        const text = textOf(value)
        if (text.startsWith(this.prefix)) {
          this.logs.append(this.writer.fd, Buffer.from(text.slice(this.prefix.length)))
        } else if (text) {
          // The final text no longer extends the streamed prefix, so the log cannot
          // prove it contains the complete output; report that instead of silence.
          this.incomplete = true
        }
      }
    }
    if (this.writer) {
      await this.closeHandle(this.writer)
      this.writer = undefined
    }
    const source = this.source
    if (source) {
      const target = join(this.logs.root, this.id + '.log'),
        staged = join(this.logs.root, this.id + '.native')
      let stagedCreated = false
      try {
        try {
          linkSync(source.path, staged)
          stagedCreated = true
          const candidate = lstatSync(staged),
            owned = await source.handle.stat()
          if (!candidate.isFile() || candidate.dev !== owned.dev || candidate.ino !== owned.ino) {
            throw new Error('Native output path changed')
          }
          renameSync(staged, target)
          stagedCreated = false
        } catch {
          const destination = await open(
            target,
            constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0)
          )
          this.handles.add(destination)
          const bytes = Buffer.alloc(65536)
          let offset = 0,
            count: number
          while (
            // oxlint-disable-next-line no-await-in-loop -- Read and append each chunk before advancing the byte offset.
            (count = (await source.handle.read(bytes, 0, bytes.length, offset)).bytesRead) > 0
          ) {
            this.logs.append(destination.fd, bytes.subarray(0, count), offset)
            offset += count
          }
          await this.closeHandle(destination)
        }
      } finally {
        if (stagedCreated) {
          unlinkSync(staged)
        }
      }
    }
    const size = this.logs.read(this.id, 0, 0).output_bytes
    if (this.logs.read(this.id, Math.max(0, size - 4), 4).truncated) {
      this.incomplete = true
    }
  }
}
