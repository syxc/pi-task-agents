import { aborted } from './engine-helpers.ts';

interface OutputRuntime {
  cursors: Map<string, number>;
  reads: Map<string, Promise<unknown>>;
}

// A process-local registry survives owner changes and module reloads, but never a process restart.
const key = Symbol.for('pi-task-agents.output-runtime.v1');
const processState = globalThis as typeof globalThis & { [key: symbol]: OutputRuntime | undefined };
const runtime = processState[key] ??= { cursors: new Map(), reads: new Map() };

export class TaskOutputReads {
  private readonly owner: string;

  constructor(owner: string) { this.owner = owner; }

  automatic<T extends { next_offset: number }>(
    taskId: string, signal: AbortSignal | undefined, read: (offset: number) => Promise<T>,
  ): Promise<T> {
    const cursorKey = JSON.stringify([this.owner, taskId]);
    const previous = runtime.reads.get(cursorKey) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      aborted(signal);
      const output = await read(runtime.cursors.get(cursorKey) ?? 0);
      aborted(signal);
      runtime.cursors.set(cursorKey, output.next_offset);
      return output;
    });
    runtime.reads.set(cursorKey, result);
    const cleanup = () => { if (runtime.reads.get(cursorKey) === result) runtime.reads.delete(cursorKey); };
    result.then(cleanup, cleanup);
    return result;
  }
}
