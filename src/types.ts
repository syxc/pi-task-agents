import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import type { BackgroundTaskStatus } from './vendor/mcode-background-task/types.ts';

export type TaskStatus = BackgroundTaskStatus;
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;

export interface AgentProfile {
  readonly name: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly instructions: string;
  readonly tools: readonly string[];
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly mcp: boolean;
  readonly timeoutMs: number;
}

export interface TaskInput {
  agent_name?: string;
  description?: string;
  prompt: string;
  model?: string;
  effort?: ThinkingLevel;
  run_in_background?: boolean;
}

export interface TaskQuery {
  task_id?: string;
  status?: TaskStatus;
}

export interface TaskRequestOptions {
  requestId?: string;
  signal?: AbortSignal;
}

export interface TaskOutputOptions {
  offset?: number;
  wait_ms?: number;
  limitBytes?: number;
}

export interface ChildResult {
  text: string;
  usage?: Record<string, number>;
  verification?: unknown;
}

export interface ChildSession {
  readonly sessionPath: string;
  prompt(text: string): Promise<ChildResult>;
  steer(text: string): Promise<unknown>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreateChildOptions {
  profile: AgentProfile;
  cwd: string;
  sessionPath: string;
  onOutput?: (chunk: string) => void;
  onActivity?: (activity: string) => void;
}

export type CreateChild = (options: CreateChildOptions) => Promise<ChildSession>;

export interface TaskRecord {
  task_id: string;
  session_id: string;
  parent_id: string;
  childSessionPath: string;
  profile: AgentProfile;
  input: TaskInput;
  status: TaskStatus;
  description: string;
  agent_name: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  output: string;
  cursor: number;
  notification_pending: boolean;
  notify_completion: boolean;
  final_text?: string;
  error?: string;
  cancel_reason?: string;
  usage?: Record<string, number>;
  verification?: unknown;
}

export type TaskSummary = Omit<TaskRecord, 'profile' | 'input' | 'output' | 'cursor'> & {
  output_bytes: number;
};

export interface TaskOutput extends TaskSummary {
  output: string;
  offset: number;
  next_offset: number;
  has_more: boolean;
}

export interface TaskState {
  version: 1;
  parentId: string;
  tasks: TaskRecord[];
  requests: Record<string, string>;
}

export interface TaskEngineOptions {
  rootDir: string;
  parentId: string;
  cwd: string;
  maxConcurrency?: number;
  createChild: CreateChild;
  notify?: (task: TaskSummary) => void | Promise<void>;
  onChange?: (task: TaskSummary) => void | Promise<void>;
}

export interface TaskService {
  init(): Promise<unknown>;
  start(input: TaskInput, profile: AgentProfile, options?: TaskRequestOptions): Promise<TaskSummary>;
  append(taskId: string, content: string, options?: TaskRequestOptions): Promise<TaskSummary>;
  query(): Promise<TaskSummary[]>;
  query(query: TaskQuery & { task_id: string }): Promise<TaskSummary>;
  query(query: TaskQuery & { task_id?: undefined }): Promise<TaskSummary[]>;
  query(query: TaskQuery): Promise<TaskSummary | TaskSummary[]>;
  output(taskId: string, options?: TaskOutputOptions): Promise<TaskOutput>;
  stop(taskId: string, reason?: string): Promise<TaskSummary>;
  pendingNotifications(): Promise<TaskSummary[]>;
  ackNotification(taskId: string): Promise<TaskSummary>;
  close(): Promise<void>;
}

export type TaskEngineConstructor = new (options: TaskEngineOptions) => TaskService;

export interface ConfigLoadOptions {
  cwd: string;
  agentDir: string;
  projectTrusted?: boolean;
}

export interface TaskAgentsConfig {
  readonly cwd: string;
  readonly agentDir: string;
  readonly maxConcurrency: number;
  readonly roles: Readonly<Record<string, AgentProfile>>;
  readonly diagnostics: readonly string[];
  readonly sources: readonly string[];
}
