import { DefaultBackgroundTaskManager } from './vendor/mcode-background-task/manager.ts';
import { createBackgroundTaskId } from './vendor/mcode-background-task/id.ts';
import { InvalidTaskStatusTransitionError, TaskNotFoundError } from './vendor/mcode-background-task/errors.ts';
import { canTransitionTaskStatus } from './vendor/mcode-background-task/status.ts';
import type {
  BackgroundTask, BackgroundTaskPatch, TaskOutputReadOptions, TaskOutputReadResult,
  TaskOutputRef, TaskOutputStore, TaskStore,
} from './vendor/mcode-background-task/types.ts';
import type { TaskRecord, TaskState, TaskStatus } from './types.ts';

function view(task: TaskRecord): BackgroundTask {
  return {
    taskId: task.task_id,
    kind: 'subagent',
    status: task.status,
    ownerSessionId: task.parent_id,
    description: task.description,
    createdAt: Date.parse(task.created_at),
    updatedAt: Date.parse(task.finished_at ?? task.started_at ?? task.created_at),
    startedAt: task.started_at === undefined ? undefined : Date.parse(task.started_at),
    endedAt: task.finished_at === undefined ? undefined : Date.parse(task.finished_at),
    lastError: task.error === undefined ? undefined : { message: task.error },
  };
}

export class TaskDomain {
  private readonly getState: () => TaskState;
  private readonly manager: DefaultBackgroundTaskManager;

  constructor(getState: () => TaskState) {
    this.getState = getState;
    const store: TaskStore = {
      // Pi admits queued tasks before ACK; manager.start always waits for its runner.
      create: async () => { throw new Error('Pi task admission belongs to TaskEngine'); },
      list: async () => { throw new Error('Pi task queries belong to TaskEngine'); },
      get: async (id) => {
        const task = this.getState().tasks.find((item) => item.task_id === id);
        return task ? view(task) : undefined;
      },
      patch: async (id, patch) => this.patch(id, patch),
      updateStatus: async (id, status, reason) => this.patch(id, {
        status,
        lastError: reason === undefined ? undefined : { message: reason },
      }),
      // The version 1 store has no event log. Engine persists and publishes changes.
      appendEvent: async () => {},
    };
    const outputStore: TaskOutputStore = {
      append: async (chunk) => {
        const task = this.task(chunk.taskId);
        task.output += chunk.content;
        return this.outputRef(task);
      },
      read: async (id, options) => this.read(id, options),
      tail: async (id, limitBytes = 8192) => this.read(id, {
        offset: Math.max(0, Buffer.byteLength(this.task(id).output) - limitBytes), limitBytes,
      }),
      finalize: async (id, summary) => {
        if (summary !== undefined) this.task(id).final_text = summary;
      },
    };
    this.manager = new DefaultBackgroundTaskManager({ store, outputStore });
  }

  createId(): string {
    // Preserve the existing public UUID format while using the upstream generator.
    return createBackgroundTaskId().slice('bg_'.length);
  }

  transition(task: TaskRecord, status: TaskStatus): void {
    if (!canTransitionTaskStatus(task.status, status)) {
      throw new InvalidTaskStatusTransitionError(task.task_id, task.status, status);
    }
    task.status = status;
  }

  async finish(task: TaskRecord, status: 'succeeded' | 'failed' | 'canceled'): Promise<void> {
    if (status === 'failed') await this.manager.fail(task.task_id, task.error ?? 'Task failed');
    else await this.manager.complete(task.task_id, { status });
  }

  readOutput(taskId: string, options: TaskOutputReadOptions): Promise<TaskOutputReadResult> {
    return this.manager.readOutput(taskId, options);
  }

  private task(id: string): TaskRecord {
    const task = this.getState().tasks.find((item) => item.task_id === id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  private patch(id: string, patch: BackgroundTaskPatch): BackgroundTask {
    const task = this.task(id);
    if (patch.status !== undefined) this.transition(task, patch.status);
    if (patch.startedAt !== undefined) task.started_at = new Date(patch.startedAt).toISOString();
    if (patch.endedAt !== undefined) task.finished_at = new Date(patch.endedAt).toISOString();
    if (patch.lastError !== undefined) task.error = patch.lastError.message;
    return view(task);
  }

  private outputRef(task: TaskRecord): TaskOutputRef {
    return {
      taskId: task.task_id, kind: 'session_transcript', uri: task.childSessionPath,
      offset: Buffer.byteLength(task.output),
    };
  }

  private read(id: string, { offset = 0, limitBytes }: TaskOutputReadOptions = {}): TaskOutputReadResult {
    const task = this.task(id);
    const bytes = Buffer.from(task.output);
    let start = Math.min(bytes.length, Math.max(0, offset));
    // Pi output cursors must never split a UTF-8 code point.
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    let end = limitBytes === undefined ? bytes.length : Math.min(bytes.length, start + limitBytes);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === start && start < bytes.length) {
      end++;
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
    }
    return {
      content: bytes.subarray(start, end).toString('utf8'), nextOffset: end,
      truncated: end < bytes.length, summary: task.final_text, outputRef: this.outputRef(task),
    };
  }
}
