import type { BackgroundTask, BackgroundTaskController } from './vendor/mcode-background-task/types.ts';
export type { BackgroundTask } from './vendor/mcode-background-task/types.ts';
export { isTerminalTaskStatus } from './vendor/mcode-background-task/status.ts';

/** The upstream lifecycle needs ownership and change events, not the MCode host service. */
export type LocalBackgroundTaskService = Pick<BackgroundTaskController, 'list' | 'stop'> & {
  waitForTaskChange(ownerSessionId: string, taskIds: readonly string[], signal: AbortSignal): Promise<void>;
};

export function buildBackgroundTaskDeliveryPrompt(tasks: readonly BackgroundTask[]): string {
  return [
    'Owned background Bash commands finished:',
    ...tasks.map(task => `${task.taskId}: ${task.status}`),
    'Use bash_task with action="output" and command_id to read results needed for this assignment. Then return a concise handoff to the parent.',
  ].join('\n');
}
