import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { open as openHandle } from 'node:fs/promises';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { InMemoryTaskStore } from './vendor/mcode-background-task/in-memory-store.ts';
import { ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES } from './vendor/mcode-background-task/status.ts';
import type { BackgroundTask, BackgroundTaskPatch, TaskLifecycleEvent } from './vendor/mcode-background-task/types.ts';
import { TaskWaiterRegistry } from './vendor/mcode-child-bash/task-waiter-registry.ts';
import { utf8Output } from './utf8-output.ts';

export const COMMAND_ENTRY = 'pi-task-agents:command';
export const commandId = (id: unknown): id is string => typeof id === 'string' && /^bg_[a-f0-9-]{36}$/.test(id);

function valid(value: unknown, owner: string): value is BackgroundTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return commandId(row.taskId) && row.kind === 'bash' && row.ownerSessionId === owner
    && typeof row.status === 'string' && [...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].some(status => status === row.status)
    && typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
    && typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)
    && !!row.metadata && typeof row.metadata === 'object' && 'parentTurnId' in row.metadata
    && typeof row.metadata.parentTurnId === 'string' && row.metadata.parentTurnId.trim().length > 0;
}

/** Keep the upstream store/state machine; only durability and event delivery are Pi ports. */
export class CommandJournal extends InMemoryTaskStore {
  readonly waiters = new TaskWaiterRegistry();
  readonly dirty = new Set<string>();
  private storageError?: { error: unknown };
  private readonly manager: SessionManager;
  constructor(manager: SessionManager) { super(); this.manager = manager; }
  get owner(): string { return this.manager.getSessionId(); }
  async restore(): Promise<void> {
    const latest = new Map<string, BackgroundTask>();
    for (const entry of this.manager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== COMMAND_ENTRY) continue;
      const data = entry.data as { version?: unknown; task?: unknown } | undefined;
      if (data?.version !== 1 || !valid(data.task, this.owner)) throw new Error('Invalid owned-command history; inspect the child session before continuing');
      latest.set(data.task.taskId, structuredClone(data.task));
    }
    for (const task of latest.values()) {
      if (['queued', 'running', 'stopping'].includes(task.status)) {
        task.status = 'lost'; task.endedAt = Date.now();
        task.lastError = { code: 'COMMAND_OWNER_EXITED', message: 'Previous owner exited; execution is not replayed or confirmed stopped' };
        task.metadata = { ...task.metadata, outputIncomplete: true };
        this.dirty.add(task.taskId);
      }
      await super.create(task);
    }
    await this.flush();
  }
  assertWritable(): void { if (this.storageError) throw this.storageError.error ?? new Error('Command journal persistence failed'); }
  override async create(task: BackgroundTask): Promise<BackgroundTask> {
    this.assertWritable();
    const row = await super.create(task);
    await this.persist(row);
    return row;
  }
  override async patch(id: string, patch: BackgroundTaskPatch): Promise<BackgroundTask> {
    const row = await super.patch(id, patch);
    await this.persist(row);
    return row;
  }
  override async appendEvent(event: TaskLifecycleEvent): Promise<void> { this.notify(event.taskId); }
  notify(id: string): void {
    this.waiters.notify(id);
    this.waiters.notify(`session:${this.owner}`);
  }
  private async persist(task: BackgroundTask): Promise<void> {
    this.dirty.add(task.taskId);
    try {
      this.manager.appendCustomEntry(COMMAND_ENTRY, { version: 1, task });
      this.dirty.delete(task.taskId);
    } catch (error) { this.storageError = { error }; throw error; }
    finally { this.notify(task.taskId); }
  }
  async flush(): Promise<void> {
    for (const id of [...this.dirty]) {
      const row = await super.get(id);
      if (row) await this.persist(row);
    }
    this.storageError = undefined;
  }
}

/** Log paths are derived from private command IDs, never accepted from journal outputRef values. */
export class CommandLogs {
  readonly root: string;
  constructor(sessionPath: string) { this.root = join(dirname(sessionPath), basename(sessionPath) + '.commands'); }
  private path(id: string, create = false): string {
    if (!commandId(id)) throw new Error('Invalid command handle');
    if (create) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Command output directory must not be a symlink');
    return join(this.root, id + '.log');
  }
  create(id: string): number {
    return openSync(this.path(id, true), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  }
  createHandle(id: string) {
    return openHandle(this.path(id, true), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  }
  append(fd: number, bytes: Buffer, position?: number): void {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, position === undefined ? null : position + offset);
      if (written === 0) throw new Error('Command output write made no progress');
      offset += written;
    }
  }
  close(fd: number): void { closeSync(fd); }
  read(id: string, offset: number, limit = 8192) {
    const fd = openSync(this.path(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return readCommandFd(fd, offset, limit); }
    finally { closeSync(fd); }
  }
}

export function readCommandFd(fd: number, offset: number, limit = 8192) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid command output cursor');
  const info = fstatSync(fd);
  if (!info.isFile()) throw new Error('Command output is not a regular file');
  const start = Math.min(offset, info.size), bounded = Math.min(limit, 65536);
  const bytes = Buffer.alloc(Math.min(bounded + 7, info.size - start));
  const count = readSync(fd, bytes, 0, bytes.length, start);
  const result = utf8Output(bytes.subarray(0, count), 0, bounded);
  const nextOffset = start + result.nextOffset;
  return { output: result.content, next_offset: nextOffset, truncated: nextOffset < info.size, output_bytes: info.size };
}
