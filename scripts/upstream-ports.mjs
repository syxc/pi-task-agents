const sourceRoot = 'packages/local-runtime/src/background-task';
const targetRoot = 'src/vendor/mcode-child-bash';
export const portModules = [
  { source: `${sourceRoot}/child-bash-lifecycle.ts`, target: `${targetRoot}/child-bash-lifecycle.ts`,
    transforms: ['relative-import-js-to-ts-v1', 'child-bash-ports-v1'] },
  { source: `${sourceRoot}/task-waiter-registry.ts`, target: `${targetRoot}/task-waiter-registry.ts`, transforms: [] },
];

// Only imports cross the host boundary; lifecycle and waiter bodies stay upstream-owned.
const imports = [
  ["import { isTerminalTaskStatus, type BackgroundTask } from './domain.ts';",
    "import { isTerminalTaskStatus, type BackgroundTask } from '../../child-bash-ports.ts';"],
  ["import type { LocalBackgroundTaskService } from './service.ts';",
    "import type { LocalBackgroundTaskService } from '../../child-bash-ports.ts';"],
  ["import { buildBackgroundTaskDeliveryPrompt } from './conversation-delivery.ts';",
    "import { buildBackgroundTaskDeliveryPrompt } from '../../child-bash-ports.ts';"],
];

export function transformChildBashPorts(content, reverse = false) {
  for (const pair of imports) {
    const [before, after] = reverse ? [...pair].reverse() : pair;
    if (content.split(before).length !== 2) throw new Error('Child Bash imports changed; review the Pi ports before syncing.');
    content = content.replace(before, after);
  }
  return content;
}
