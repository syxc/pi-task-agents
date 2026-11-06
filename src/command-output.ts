import { constants, fstatSync, lstatSync, linkSync, realpathSync, renameSync, unlinkSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CommandLogs, readCommandFd } from './command-journal.ts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const textOf = (value: unknown): string => {
  const parts = object(value).content;
  return Array.isArray(parts) ? parts.filter(part => object(part).type === 'text').map(part => String(object(part).text ?? '')).join('\n') : '';
};

/** Accept native artifacts only from the live native call, never from history or caller-provided URIs. */
export class CommandOutput {
  private readonly logs: CommandLogs;
  private readonly id: string;
  private readonly changed: () => void;
  private readonly handles = new Set<FileHandle>();
  private writer?: FileHandle;
  private source?: { handle: FileHandle; path: string };
  private watcher?: FSWatcher;
  private opening?: Promise<void>;
  private adoptionFailed = false;
  private prefix = '';
  incomplete = false;
  private constructor(logs: CommandLogs, id: string, changed: () => void) { this.logs = logs; this.id = id; this.changed = changed; }
  static async create(logs: CommandLogs, id: string, changed: () => void) {
    const output = new CommandOutput(logs, id, changed);
    output.writer = await logs.createHandle(id); output.handles.add(output.writer);
    return output;
  }
  get hasOpenResources(): boolean { return this.handles.size > 0 || this.watcher !== undefined; }
  private async adopt(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    this.handles.add(handle);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new Error('Native output identity is unavailable');
      this.watcher = watch(path, () => this.changed());
      this.watcher.on('error', () => { this.incomplete = true; this.changed(); });
      this.source = { handle, path };
    } catch (error) { await this.closeHandle(handle); throw error; }
  }
  update(value: unknown): void {
    try {
      const details = object(object(value).details), path = details.fullOutputPath;
      if (!this.source && !this.opening && !this.adoptionFailed && typeof path === 'string' && /^pi-bash-[a-f0-9]{16}\.log$/.test(basename(path))
        && realpathSync(dirname(path)) === realpathSync(tmpdir())) {
        this.opening = this.adopt(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.incomplete = true; this.adoptionFailed = true; }
        }).finally(() => { this.opening = undefined; this.changed(); });
      }
      const text = textOf(value);
      if (!this.source && !object(details.truncation).truncated && text.startsWith(this.prefix)) {
        if (this.writer) this.logs.append(this.writer.fd, Buffer.from(text.slice(this.prefix.length)));
        this.prefix = text;
      }
    } catch { this.incomplete = true; }
    this.changed();
  }
  read(offset: number) {
    if (this.source && this.source.handle.fd >= 0 && fstatSync(this.source.handle.fd).size >= Buffer.byteLength(this.prefix)) return readCommandFd(this.source.handle.fd, offset);
    return this.logs.read(this.id, offset);
  }
  private async closeHandle(handle: FileHandle): Promise<void> { await handle.close(); this.handles.delete(handle); }
  async close(): Promise<void> {
    const errors: unknown[] = [];
    try { this.watcher?.close(); this.watcher = undefined; } catch (error) { errors.push(error); }
    const results = await Promise.allSettled([...this.handles].map(handle => this.closeHandle(handle)));
    errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
    if (this.writer && !this.handles.has(this.writer)) this.writer = undefined;
    if (this.source && !this.handles.has(this.source.handle)) this.source = undefined;
    if (errors.length) throw new AggregateError(errors, 'Command output cleanup is unconfirmed');
  }
  async finish(value?: unknown): Promise<void> {
    let error: unknown;
    try { await this.persist(value); } catch (failure) { this.incomplete = true; error = failure; }
    try { await this.close(); } catch (failure) { throw new AggregateError(error ? [error, failure] : [failure], 'Command output finalization failed'); }
    if (error) throw error;
    this.changed();
  }
  private async persist(value?: unknown): Promise<void> {
    await this.opening;
    if (value) this.update(value);
    await this.opening;
    if (!this.source) {
      const structured = object(object(value).structuredContent);
      const output = typeof structured.output === 'string' && structured.truncated !== true ? structured.output : undefined;
      if (output !== undefined && this.writer) {
        await this.writer.truncate(0);
        this.logs.append(this.writer.fd, Buffer.from(output), 0);
      } else if (this.writer) {
        if (structured.truncated === true || object(object(object(value).details).truncation).truncated === true) this.incomplete = true;
        const text = textOf(value);
        if (text.startsWith(this.prefix)) this.logs.append(this.writer.fd, Buffer.from(text.slice(this.prefix.length)));
        else if (text && !this.prefix) this.logs.append(this.writer.fd, Buffer.from(text));
      }
    }
    if (this.writer) { await this.closeHandle(this.writer); this.writer = undefined; }
    const source = this.source;
    if (source) {
      const target = join(this.logs.root, this.id + '.log'), staged = join(this.logs.root, this.id + '.native');
      let stagedCreated = false;
      try {
        try {
          linkSync(source.path, staged); stagedCreated = true;
          const candidate = lstatSync(staged), owned = await source.handle.stat();
          if (!candidate.isFile() || candidate.dev !== owned.dev || candidate.ino !== owned.ino) throw new Error('Native output path changed');
          renameSync(staged, target); stagedCreated = false;
        } catch {
          const destination = await open(target, constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
          this.handles.add(destination);
          const bytes = Buffer.alloc(65536);
          let offset = 0, count: number;
          while ((count = (await source.handle.read(bytes, 0, bytes.length, offset)).bytesRead) > 0) {
            this.logs.append(destination.fd, bytes.subarray(0, count), offset); offset += count;
          }
          await this.closeHandle(destination);
        }
      } finally { if (stagedCreated) unlinkSync(staged); }
    }
    const size = this.logs.read(this.id, 0, 0).output_bytes;
    if (this.logs.read(this.id, Math.max(0, size - 4), 4).truncated) this.incomplete = true;
  }
}
