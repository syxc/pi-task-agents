import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'

export interface ParentToolBinding {
  owner: object
  ctx: ExtensionToolContext
  tool: ExtensionToolContext['tools'][number]
  id: string
  inline: boolean
}

export const taskExecutionBinding = new AsyncLocalStorage<ParentToolBinding | undefined>()

export function runWithoutTaskExecutionContext<T>(run: () => T): T {
  return taskExecutionBinding.run(undefined, run)
}

/** Queued tasks must restore their admission context, not the completing task's context. */
export function captureTaskExecutionContext() {
  const binding = taskExecutionBinding.getStore()
  return <T>(run: () => T): T => taskExecutionBinding.run(binding, run)
}
