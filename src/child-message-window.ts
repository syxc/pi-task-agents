import type { ContextEditEntry, SessionManager } from '@earendil-works/pi-coding-agent'

type Window = {
  previous: Set<string>
  assistants: Set<unknown>
  rootUser?: unknown
  available: boolean
}
interface ChildCommittedMessages {
  available: boolean
  text: string
}

/** Use Pi's active branch and durable context edits, not message_end events,
 * as the final selection authority.
 * Read the full branch so ordinary compaction does not erase this turn's text.
 */
export function createChildMessageWindow<T extends object>(manager: SessionManager) {
  const windows = new WeakMap<T, Window>()
  function begin(run: T) {
    const window: Window = { previous: new Set(), assistants: new Set(), available: false }
    windows.set(run, window)
    try {
      if (typeof manager.getEntries !== 'function' || typeof manager.getBranch !== 'function') {
        return
      }
      window.previous = new Set(manager.getEntries().map((entry) => entry.id))
      window.available = true
    } catch {
      /* Missing authoritative entries cannot be replaced with observed text. */
    }
  }
  function observe(run: T, message: { role: string }) {
    const window = windows.get(run)
    if (!window) {
      return
    }
    if (message.role === 'user' && window.rootUser === undefined) {
      window.rootUser = message
    }
    if (message.role === 'assistant') {
      window.assistants.add(message)
    }
  }
  function read(run: T): ChildCommittedMessages {
    const window = windows.get(run)
    if (!window?.available) {
      return { available: false, text: '' }
    }
    try {
      const raw = new Map(manager.getEntries().map((entry) => [entry.id, entry]))
      const branch = manager.getBranch()
      if (window.rootUser === undefined) {
        // No user message was observed, so this turn committed no readable root.
        return { available: true, text: '' }
      }
      const root = branch.findIndex(
        (entry) =>
          entry.type === 'message' &&
          entry.message === window.rootUser &&
          !window.previous.has(entry.id) &&
          raw.get(entry.id)?.type === 'message'
      )
      if (root < 0) {
        // An observed root that the active branch no longer contains means the
        // authoritative window is gone; empty text would be a false success.
        return { available: false, text: '' }
      }
      const edits = new Map<string, ContextEditEntry>()
      for (const entry of branch) {
        if (entry.type === 'context_edit') {
          edits.set(entry.targetId, entry)
        }
      }
      const texts: string[] = []
      for (const entry of branch.slice(root + 1)) {
        if (
          entry.type !== 'message' ||
          entry.message.role !== 'assistant' ||
          window.previous.has(entry.id) ||
          !raw.has(entry.id) ||
          !window.assistants.has(entry.message)
        ) {
          continue
        }
        const replacement = edits.get(entry.id)?.replacement
        if (replacement === null) {
          continue
        }
        const content = replacement ? replacement.content : entry.message.content
        const text =
          typeof content === 'string'
            ? content
            : content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
        if (text) {
          texts.push(text)
        }
      }
      return { available: true, text: texts.join('\n').trim() }
    } catch {
      return { available: false, text: '' }
    }
  }
  return { begin, observe, read }
}
