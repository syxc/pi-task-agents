import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent'

interface CallOrigin {
  name: string
  id: string
  nested: boolean
  ambiguous?: boolean
  manager: ExtensionContext['sessionManager']
  sessionId: string
  generation: number
}

/** Associate matching SDK hook arguments; a missing match never proves direct ancestry. */
export class TaskCallAncestry {
  // The verified SDK clones each call's args. Weak keys survive detached hooks
  // without retaining blocked/canceled calls or colliding on identical IDs.
  // SDKs that copy args again (or omit hooks) fall back to unknown, never direct.
  private readonly calls = new WeakMap<object, CallOrigin>()
  private generation = 0

  observe(event: ToolCallEvent, ctx: ExtensionContext): void {
    if (!['task', 'task_send'].includes(event.toolName)) {
      return
    }
    const previous = this.calls.get(event.input)
    if (previous) {
      previous.ambiguous = true
      return
    }
    const manager = ctx.sessionManager
    this.calls.set(event.input, {
      name: event.toolName,
      id: event.toolCallId,
      nested: !!event.parentToolCallId,
      manager,
      sessionId: manager.getSessionId(),
      generation: this.generation
    })
  }

  invalidate(): void {
    this.generation++
  }

  take(
    name: string,
    id: string,
    args: object,
    ctx: ExtensionContext
  ): 'nested' | 'direct' | 'unknown' | 'expired' {
    const call = this.calls.get(args)
    // Keep ambiguous keys as weak tombstones; another observe must not reauthorize shared args.
    if (!call?.ambiguous) {
      this.calls.delete(args)
    }
    if (!call) {
      return 'unknown'
    }
    if (
      call.name !== name ||
      call.id !== id ||
      call.generation !== this.generation ||
      call.manager !== ctx.sessionManager ||
      call.sessionId !== ctx.sessionManager.getSessionId()
    ) {
      return 'expired'
    }
    return call.ambiguous ? 'unknown' : call.nested ? 'nested' : 'direct'
  }
}
