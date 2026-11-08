/** Initialization-scoped stop artifacts exist only when a stop arrives before the child is ready. */
export interface InitializationStop {
  write?: Promise<void>
  wait?: Promise<void>
  report?: Promise<void>
  cleanupPending: boolean
}

export interface RuntimeStop {
  reason: string
  status: 'canceled' | 'failed'
  aborting?: Promise<void>
  initialization?: InitializationStop
}

/**
 * Lifecycle phases are exclusive. Stop data survives the transition from
 * stopping to sealed so terminal writes can still report why the run ended.
 */
export type RuntimePhase =
  | { kind: 'initializing' }
  | { kind: 'running' }
  | { kind: 'stopping'; stop: RuntimeStop }
  | { kind: 'finishing'; stop?: RuntimeStop }
  | { kind: 'sealed'; stop?: RuntimeStop }

export function stopOf(phase: RuntimePhase): RuntimeStop | undefined {
  return phase.kind === 'stopping' || phase.kind === 'finishing' || phase.kind === 'sealed'
    ? phase.stop
    : undefined
}

export function isAccepting(phase: RuntimePhase): boolean {
  return phase.kind === 'initializing' || phase.kind === 'running'
}
