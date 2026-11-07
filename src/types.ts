import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent'
import type { BackgroundTaskStatus } from './vendor/mcode-background-task/types.ts'

export type TaskStatus = BackgroundTaskStatus
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>

export interface AgentProfile {
  readonly name: string
  readonly model?: string
  readonly thinking?: ThinkingLevel
  /** Legacy persisted metadata; execution uses only the SDK-native thinking level. */
  readonly effort?: string
  readonly instructions: string
  /** Requested selectors; a missing selector does not create a tool. */
  readonly tools: readonly string[]
  /** Internal native inventory ceiling captured at creation, excluding MCP/Plugin tools. */
  readonly nativeToolSnapshot?: readonly string[]
  /** Observed inventory at the latest child creation, not a dynamic MCP/Plugin allowlist. */
  readonly toolInventory?: readonly string[]
  readonly extensions?: readonly string[]
  readonly skills?: readonly string[]
  /** Internal creation-time Skill names, intersected with current trusted discovery on restore. */
  readonly skillSnapshot?: readonly string[]
  /** Accepted extension identities only; never persisted executable factories. */
  readonly extensionSnapshot?: readonly string[]
  /** Legacy switch: false disables MCP; omission inherits trusted host servers. */
  readonly mcp?: boolean
  readonly mcpServers?: readonly string[]
  readonly disallowedTools?: readonly string[]
  readonly timeoutMs: number
}

export interface TaskInput {
  agent_name?: string
  description?: string
  prompt: string
  model?: string
  effort?: string
  run_in_background?: boolean
}

export interface TaskQuery {
  task_id?: string
  status?: TaskStatus
}

export interface TaskRequestOptions {
  requestId?: string
  signal?: AbortSignal
  /** True for nested or unverified SDK origin; full-capacity foreground admission must not wait. */
  nestedToolCall?: boolean
}

export interface TaskOutputOptions {
  signal?: AbortSignal
  offset?: number
  wait_ms?: number
  limitBytes?: number
}

export type ChildOutcome =
  | { kind: 'returned'; status: 'succeeded' | 'failed' | 'aborted' }
  | { kind: 'exception' }

export type ModelVerdict = 'pass' | 'fail' | 'partial'
export interface VerificationReport {
  modelVerdict?: ModelVerdict
  fileChange: 'no_observed_change' | 'change_observed' | 'uncertain' | 'recording_failed'
  changedFiles?: string[]
  observationNotes: string[]
}

export interface ChildResult {
  /** Internal producer provenance for terminal formatting; never public Task details. */
  outcome?: ChildOutcome
  /** Host-produced proof that this turn has no unconfirmed managed-command resources. */
  commandCleanupConfirmed?: true
  eventCount?: number
  subTurnId?: string
  resolvedAgentName?: string
  text: string
  verification?: VerificationReport
  usage?: Record<string, number>
}

export interface ChildFailure extends Error {
  code?: unknown
  partialResult?: ChildResult
  /** Internal ownership handoff when initialization fails before returning the child. */
  cleanupChild?: ChildSession
  /** Present only when the captured turn's execution queue definitely did not accept this input. */
  steerAccepted?: false
}

export interface ChildPromptOptions {
  turnId?: string
}

export interface ChildSession {
  readonly sessionPath: string
  prompt(text: string, options?: ChildPromptOptions): Promise<ChildResult>
  steer(text: string): Promise<unknown>
  abort(): Promise<void>
  dispose(): Promise<void>
}

export interface CreateChildOptions {
  /** Cooperative initialization cancellation only; the factory still owns cleanup until it settles. */
  signal?: AbortSignal
  profile: AgentProfile
  cwd: string
  sessionPath: string
  onOutput?: (chunk: string) => void
  onActivity?: (activity: string) => void
  /** Persist cleanup ownership before a native managed command can start. */
  onOwnedCommandStarted?: (turnId: string) => Promise<void>
  /** Persist the resolved profile before returning a child that the engine can dispatch. */
  onProfileResolved?: (profile: AgentProfile) => Promise<void>
}

/** Rejection confirms cleanup, unless CHILD_CLEANUP_FAILED retains a retryable cleanupChild or an unresolved owner. */
export type CreateChild = (options: CreateChildOptions) => Promise<ChildSession>

export interface TaskRecord {
  task_id: string
  sub_turn_id?: string
  event_count?: number
  resolved_agent_name?: string
  requested_agent_name?: string
  session_id: string
  parent_id: string
  /** Direct continuation source; absent in historical records and initial tasks. */
  parent_task_id?: string
  execution_mode?: 'foreground' | 'background' | 'append'
  childSessionPath: string
  profile: AgentProfile
  input: TaskInput
  status: TaskStatus
  description: string
  agent_name: string
  created_at: string
  started_at?: string
  finished_at?: string
  output: string
  cursor: number
  notification_pending: boolean
  notify_completion: boolean
  /** Internal durable ownership marker; never a public completion or cleanup claim. */
  ownedCommandCleanupPending?: true
  final_text?: string
  /** Historical runtime completion facts, never a review verdict or file observation. */
  legacyVerification?: { agentSettled: true; stopReason: string; toolErrors: number }
  verification?: VerificationReport
  error?: string
  cancel_reason?: string
  usage?: Record<string, number>
  mode?: 'activated' | 'steered' | 'duplicate'
  accepted?: boolean
  stopError?: { code: string; message: string }
}

export type TaskSummary = Omit<
  TaskRecord,
  'profile' | 'input' | 'output' | 'cursor' | 'legacyVerification' | 'ownedCommandCleanupPending'
> & {
  output_bytes: number
  /** Current runtime activity; never persisted or treated as task output. */
  activity?: string
  /** Runtime ownership remains held even if the public stop status is terminal. */
  cleanup_pending?: boolean
}

export interface TaskOutput extends TaskSummary {
  timed_out?: boolean
  truncated?: boolean
  output: string
  offset: number
  next_offset: number
  has_more: boolean
}

export interface TaskState {
  version: 1
  parentId: string
  tasks: TaskRecord[]
  requests: Record<string, string>
}

export interface TaskEngineOptions {
  rootDir: string
  parentId: string
  cwd: string
  /** Per-owner capacity: defaults to 4; explicit values must be safe integers from 1 to 10. */
  maxConcurrency?: number
  createChild: CreateChild
  notify?: (task: TaskSummary) => void | Promise<void>
  onChange?: (task: TaskSummary) => void | Promise<void>
}

export interface TaskService {
  init(): Promise<unknown>
  start(input: TaskInput, profile: AgentProfile, options?: TaskRequestOptions): Promise<TaskSummary>
  append(taskId: string, content: string, options?: TaskRequestOptions): Promise<TaskSummary>
  send(taskId: string, content: string, options?: TaskRequestOptions): Promise<TaskSummary>
  query(): Promise<TaskSummary[]>
  query(query: TaskQuery & { task_id: string }): Promise<TaskSummary>
  query(query: TaskQuery & { task_id?: undefined }): Promise<TaskSummary[]>
  query(query: TaskQuery): Promise<TaskSummary | TaskSummary[]>
  output(taskId: string, options?: TaskOutputOptions): Promise<TaskOutput>
  stop(taskId: string, reason?: string): Promise<TaskSummary>
  pendingNotifications(): Promise<TaskSummary[]>
  ackNotification(taskId: string): Promise<TaskSummary>
  close(): Promise<void>
}

export type TaskEngineConstructor = new (options: TaskEngineOptions) => TaskService

export interface ConfigLoadOptions {
  cwd: string
  agentDir: string
  projectTrusted?: boolean
}

export interface TaskAgentsConfig {
  readonly cwd: string
  readonly agentDir: string
  /** loadConfig resolves omission to 4; explicit values must be safe integers from 1 to 10. */
  readonly maxConcurrency?: number
  readonly roles: Readonly<Record<string, AgentProfile>>
  readonly diagnostics: readonly string[]
  readonly sources: readonly string[]
}
