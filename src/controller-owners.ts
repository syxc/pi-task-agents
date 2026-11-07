import type { CreateChild, TaskAgentsConfig, TaskService } from './types.ts'
import type { ParentRuntimeSnapshot } from './parent-runtime.ts'

export interface ControllerOwner {
  rootDir: string
  parentId: string
  cwd: string
  engine: TaskService
  config: TaskAgentsConfig
  readonly projectTrusted: boolean
  readonly createChild: CreateChild
  attached?: object
  notify?: () => void
  onChange?: () => void
  codemodeEnabled?: boolean
  readCodemodeEnabled?: () => boolean
  hostRuntime?: ParentRuntimeSnapshot
}

// Pi reloads extension modules on session replacement. Keep detached engines in
// process memory, but never retain a live parent API in their notification hooks.
const key = Symbol.for('pi-task-agents:controller-owners:v1')
const shared = globalThis as typeof globalThis & { [key]?: Map<string, ControllerOwner> }
const owners = (shared[key] ??= new Map<string, ControllerOwner>())
const ownerKey = (rootDir: string, parentId: string): string => JSON.stringify([rootDir, parentId])

export function getOwner(rootDir: string, parentId: string): ControllerOwner | undefined {
  return owners.get(ownerKey(rootDir, parentId))
}

export function retainOwner(owner: ControllerOwner): void {
  const id = ownerKey(owner.rootDir, owner.parentId)
  if (owners.has(id)) {
    throw new Error('Task owner is already retained')
  }
  owners.set(id, owner)
}

export function forgetOwner(owner: ControllerOwner): void {
  const id = ownerKey(owner.rootDir, owner.parentId)
  if (owners.get(id) === owner) {
    owners.delete(id)
  }
}

export async function closeDetachedOwners(rootDir: string): Promise<void> {
  const results = await Promise.allSettled(
    [...owners.values()]
      .filter((owner) => owner.rootDir === rootDir && !owner.attached)
      .map(async (owner) => {
        await owner.engine.close()
        forgetOwner(owner)
      })
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') {
    throw failure.reason
  }
}
