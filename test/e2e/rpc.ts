import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { isRecord, type JsonRecord, type RpcEvent } from './support.ts'

export const E2E_RESULT_TYPE = 'pi-task-agents:result'

export interface EventMatch {
  event: RpcEvent
  index: number
}

export interface ToolEndMatch extends EventMatch {
  toolName: string
  details: JsonRecord
  isError: boolean
  text: string
  durationMs?: number
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function messageText(message: unknown): string {
  if (!isRecord(message)) {
    return ''
  }
  const content = message.content
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    )
    .join('')
}

export function isAssistantMessage(message: unknown): boolean {
  return isRecord(message) && message.role === 'assistant'
}

export function isAssistantTextEvent(event: RpcEvent, text: string): boolean {
  return (
    event.type === 'message_end' &&
    isAssistantMessage(event.message) &&
    messageText(event.message).includes(text)
  )
}

export function notificationTaskIds(event: RpcEvent): string[] {
  if (event.type !== 'message_end') {
    return []
  }
  const message = event.message
  if (
    !isRecord(message) ||
    message.role !== 'custom' ||
    message.customType !== E2E_RESULT_TYPE ||
    !isRecord(message.details)
  ) {
    return []
  }
  const ids: string[] = []
  if (typeof message.details.task_id === 'string') {
    ids.push(message.details.task_id)
  }
  if (Array.isArray(message.details.task_ids)) {
    for (const id of message.details.task_ids) {
      if (typeof id === 'string') {
        ids.push(id)
      }
    }
  }
  return ids
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export interface PiRpcOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export class PiRpc {
  readonly events: RpcEvent[] = []
  private readonly child: ChildProcessWithoutNullStreams
  private readonly exited: Promise<void>
  private readonly decoder = new StringDecoder('utf8')
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(event: RpcEvent) => void>()
  private buffer = ''
  private stderrText = ''
  private requestSeq = 0
  private stopPromise?: Promise<void>

  constructor(options: PiRpcOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.exited = new Promise((resolveExit) => {
      this.child.once('exit', () => resolveExit())
    })
    this.child.once('error', (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)))
    })
    this.child.once('exit', (code, signal) => {
      this.failAll(
        new Error(`pi exited (code=${String(code)}, signal=${String(signal)})${this.stderrTail()}`)
      )
    })
    this.child.stdin.on('error', (error) => {
      this.failAll(error)
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.consume(chunk)
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrText = (this.stderrText + chunk.toString('utf8')).slice(-50_000)
    })
  }

  async start(): Promise<void> {
    await this.request('get_state', {}, 30_000)
  }

  mark(): number {
    return this.events.length
  }

  async promptAndSettle(
    message: string,
    options: { timeoutMs?: number } = {}
  ): Promise<{ disposition: string; from: number }> {
    const from = this.mark()
    const disposition = await this.prompt(message)
    if (disposition !== 'handled') {
      await this.waitForEvent((event) => event.type === 'agent_settled', {
        from,
        timeoutMs: options.timeoutMs ?? 180_000,
        label: 'agent_settled'
      })
    }
    return { disposition, from }
  }

  async prompt(message: string): Promise<string> {
    const data = await this.request('prompt', { message })
    if (!isRecord(data) || typeof data.disposition !== 'string') {
      throw new Error('Prompt response is missing a disposition')
    }
    return data.disposition
  }

  async getState(): Promise<JsonRecord> {
    const data = await this.request('get_state')
    if (!isRecord(data)) {
      throw new Error('get_state returned no state')
    }
    return data
  }

  async getSessionStats(): Promise<JsonRecord> {
    const data = await this.request('get_session_stats')
    if (!isRecord(data)) {
      throw new Error('get_session_stats returned no statistics')
    }
    return data
  }

  waitForEvent(
    predicate: (event: RpcEvent) => boolean,
    options: { from?: number; timeoutMs?: number; label?: string } = {}
  ): Promise<EventMatch> {
    const from = options.from ?? 0
    for (let index = from; index < this.events.length; index++) {
      const event = this.events[index]
      if (event && predicate(event)) {
        return Promise.resolve({ event, index })
      }
    }
    const timeoutMs = options.timeoutMs ?? 180_000
    const label = options.label ?? 'event'
    return new Promise((resolveMatch, rejectMatch) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        rejectMatch(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${label}; recent events: ${this.events
              .slice(-10)
              .map((event) => event.type)
              .join(', ')}${this.stderrTail()}`
          )
        )
      }, timeoutMs)
      const listener = (event: RpcEvent): void => {
        if (!predicate(event)) {
          return
        }
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolveMatch({ event, index: this.events.length - 1 })
      }
      this.listeners.add(listener)
    })
  }

  waitForAssistantText(
    text: string,
    options: { from?: number; timeoutMs?: number } = {}
  ): Promise<EventMatch> {
    return this.waitForEvent((event) => isAssistantTextEvent(event, text), {
      ...options,
      label: `assistant text ${JSON.stringify(text)}`
    })
  }

  async waitForToolEnds(
    toolName: string,
    count: number,
    options: { from?: number; timeoutMs?: number } = {}
  ): Promise<ToolEndMatch[]> {
    const from = options.from ?? 0
    const matches: ToolEndMatch[] = []
    for (let index = from; index < this.events.length; index++) {
      const event = this.events[index]
      const facts = event ? toolEndFacts(event, index) : undefined
      if (facts?.toolName === toolName) {
        matches.push(facts)
      }
    }
    if (matches.length >= count) {
      return matches.slice(0, count)
    }
    const timeoutMs = options.timeoutMs ?? 180_000
    return new Promise((resolveMatch, rejectMatch) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        rejectMatch(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${count} ${toolName} tool calls; saw ${matches.length}; recent events: ${this.events
              .slice(-10)
              .map((event) => event.type)
              .join(', ')}${this.stderrTail()}`
          )
        )
      }, timeoutMs)
      const listener = (event: RpcEvent): void => {
        const facts = toolEndFacts(event, this.events.length - 1)
        if (facts?.toolName !== toolName) {
          return
        }
        matches.push(facts)
        if (matches.length >= count) {
          clearTimeout(timer)
          this.listeners.delete(listener)
          resolveMatch(matches.slice(0, count))
        }
      }
      this.listeners.add(listener)
    })
  }

  assistantTexts(from = 0): string[] {
    return this.events.flatMap((event, index) => {
      if (index < from || event.type !== 'message_end' || !isAssistantMessage(event.message)) {
        return []
      }
      const text = messageText(event.message).trim()
      return text ? [text] : []
    })
  }

  stderr(): string {
    return this.stderrText
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.finishStop()
    return this.stopPromise
  }

  private async finishStop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end()
      const term = setTimeout(() => {
        this.child.kill('SIGTERM')
      }, 5_000)
      const kill = setTimeout(() => {
        this.child.kill('SIGKILL')
      }, 8_000)
      term.unref()
      kill.unref()
      try {
        await this.exited
      } finally {
        clearTimeout(term)
        clearTimeout(kill)
      }
    }
    this.listeners.clear()
  }

  private consume(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) {
        return
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(parsed) || typeof parsed.type !== 'string') {
        continue
      }
      this.record({ ...parsed, type: parsed.type })
    }
  }

  private record(event: RpcEvent): void {
    if (event.type === 'response') {
      this.complete(event)
      return
    }
    this.events.push(event)
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private complete(response: RpcEvent): void {
    const id = textOf(response.id)
    if (!id) {
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    if (response.success === true) {
      pending.resolve(response.data)
      return
    }
    const command = textOf(response.command) ?? 'command'
    const message = textOf(response.error) ?? 'unknown error'
    pending.reject(new Error(`Pi ${command} failed: ${message}`))
  }

  private request(type: string, fields: JsonRecord = {}, timeoutMs = 60_000): Promise<unknown> {
    const id = `e2e-${++this.requestSeq}`
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(`RPC ${type} timed out after ${timeoutMs}ms${this.stderrTail()}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          this.pending.delete(id)
          resolveRequest(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          this.pending.delete(id)
          rejectRequest(error)
        }
      })
      try {
        this.child.stdin.write(
          `${JSON.stringify({
            ...fields,
            id,
            type
          })}\n`
        )
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        rejectRequest(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }

  private stderrTail(): string {
    const tail = this.stderrText.trim().slice(-2_000)
    return tail ? `; stderr: ${tail}` : ''
  }
}

function toolEndFacts(event: RpcEvent, index: number): ToolEndMatch | undefined {
  if (event.type !== 'tool_execution_end' || typeof event.toolName !== 'string') {
    return undefined
  }
  const result = isRecord(event.result) ? event.result : {}
  // A tool that throws reports isError on the event and a content-only result;
  // tools that return a failure set isError on their own result.
  const content = Array.isArray(result.content)
    ? result.content
        .map((part) =>
          isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''
        )
        .join('')
    : ''
  return {
    event,
    index,
    toolName: event.toolName,
    details: isRecord(result.details) ? result.details : {},
    isError: event.isError === true || result.isError === true,
    text: textOf(result.text) ?? content,
    ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {})
  }
}
