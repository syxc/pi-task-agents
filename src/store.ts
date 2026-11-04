import { mkdir, open, readFile, readdir, rename, unlink, chmod } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { AgentProfile, TaskInput, TaskRecord, TaskState } from './types.ts';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES } from './vendor/mcode-background-task/status.ts';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function thinking(value: unknown): value is AgentProfile['thinking'] {
  return typeof value === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

function profile(value: unknown): value is AgentProfile {
  return object(value) && typeof value.name === 'string' && typeof value.model === 'string'
    && thinking(value.thinking) && typeof value.instructions === 'string'
    && strings(value.tools) && strings(value.extensions) && strings(value.skills)
    && typeof value.mcp === 'boolean' && typeof value.timeoutMs === 'number';
}

function input(value: unknown): value is TaskInput {
  return object(value) && typeof value.prompt === 'string'
    && ['agent_name', 'description', 'model'].every((key) => value[key] === undefined || typeof value[key] === 'string')
    && (value.effort === undefined || thinking(value.effort))
    && (value.run_in_background === undefined || typeof value.run_in_background === 'boolean');
}

function task(value: unknown): value is TaskRecord {
  if (!object(value)) return false;
  const requiredStrings = ['task_id', 'session_id', 'parent_id', 'childSessionPath', 'description',
    'agent_name', 'created_at', 'output'];
  const optionalStrings = ['started_at', 'finished_at', 'final_text', 'error', 'cancel_reason'];
  return requiredStrings.every((key) => typeof value[key] === 'string')
    && optionalStrings.every((key) => value[key] === undefined || typeof value[key] === 'string')
    && profile(value.profile) && input(value.input)
    && typeof value.status === 'string'
    && [...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].some((status) => status === value.status)
    && typeof value.cursor === 'number' && Number.isSafeInteger(value.cursor) && value.cursor >= 0
    && typeof value.notification_pending === 'boolean' && typeof value.notify_completion === 'boolean'
    && (value.usage === undefined || (object(value.usage)
      && Object.values(value.usage).every((amount) => typeof amount === 'number')));
}

function state(value: unknown): value is TaskState {
  return object(value) && value.version === 1 && typeof value.parentId === 'string'
    && Array.isArray(value.tasks) && value.tasks.every(task) && object(value.requests)
    && Object.values(value.requests).every((id) => typeof id === 'string');
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return !hasCode(error, 'ESRCH'); }
};

export class TaskStore {
  readonly rootDir: string;
  readonly parentId: string;
  readonly dir: string;
  readonly file: string;
  private tail: Promise<void>;
  private lockDir?: string;
  private lockPath?: string;

  constructor(rootDir: string, parentId: string) {
    this.rootDir = resolve(rootDir);
    this.parentId = parentId;
    this.dir = join(this.rootDir, createHash('sha256').update(parentId).digest('hex'));
    this.file = join(this.dir, 'tasks.json');
    this.tail = Promise.resolve();
  }

  async init(): Promise<TaskState> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    this.lockDir = join(this.dir, 'owners');
    await mkdir(this.lockDir, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, 'EEXIST')) throw error;
    });
    // Unique candidates avoid deleting a successor's lock during stale-owner recovery.
    this.lockPath = join(this.lockDir, `${process.pid}-${randomUUID()}.lock`);
    const handle = await open(this.lockPath, 'wx', 0o600);
    await handle.close();
    try {
      for (const name of await readdir(this.lockDir)) {
        const path = join(this.lockDir, name);
        if (path === this.lockPath) continue;
        const match = /^(\d+)-[a-f0-9-]+\.lock$/.exec(name);
        if (!match || alive(Number(match[1]))) {
          throw new Error('Parent already has an active task owner');
        }
        await unlink(path).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
      }
      let loaded: unknown;
      try { loaded = JSON.parse(await readFile(this.file, 'utf8')); }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      if (loaded && (!object(loaded) || loaded.parentId !== this.parentId || loaded.version !== 1)) {
        throw new Error('Task store owner or version mismatch');
      }
      if (loaded !== undefined && loaded !== null && !state(loaded)) throw new Error('Invalid task store state');
      return loaded ?? { version: 1, parentId: this.parentId, tasks: [], requests: {} };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  save(state: TaskState): Promise<void> {
    const text = JSON.stringify(state);
    const operation = this.tail.then(async () => {
      if (!this.lockPath) throw new Error('Task store is closed');
      const temporary = join(this.dir, `.tasks-${randomUUID()}.tmp`);
      let handle: FileHandle | undefined;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(text);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, this.file);
      } finally {
        await handle?.close();
        await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async close(): Promise<void> {
    await this.tail;
    if (this.lockPath) {
      await unlink(this.lockPath).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
      this.lockPath = undefined;
    }
  }
}
