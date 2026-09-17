/**
 * Ports — interface contracts for all external capabilities.
 * These are types only; implementations are provided by adapters.
 * The core imports these interfaces, never their implementations.
 */

import type { AgentState, ContentBlock, Message, PendingToolCall, TodoItem } from "./state.js";
import type { RiskTier, ToolDefinition, JSONSchema } from "./tool.js";

// ──────────────────────────────────────────────
// ModelPort — the model provider interface
// ──────────────────────────────────────────────

export interface ModelEventTextDelta {
  type: "text_delta";
  text: string;
}

export interface ModelEventReasoningDelta {
  type: "reasoning_delta";
  text: string;
}

export interface ModelEventToolUseStart {
  type: "tool_use_start";
  toolCallId: string;
  toolName: string;
}

export interface ModelEventToolUseDelta {
  type: "tool_use_delta";
  toolCallId: string;
  argumentsDelta: string;
}

/** Token accounting for one model call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Exact full-call total when the provider reports one. */
  totalTokens?: number;
  /** Tokens read from provider-side prompt cache. */
  cacheReadTokens?: number;
  /** Tokens written to provider-side prompt cache. */
  cacheWriteTokens?: number;
  /** Reasoning/thinking tokens when the provider bills them separately. */
  reasoningTokens?: number;
}

export interface ModelEventUsage extends TokenUsage {
  type: "usage";
}

/**
 * Opaque, adapter-owned reasoning effort id. The core carries it verbatim and
 * never interprets, aliases or clamps it: the set of selectable efforts is a
 * capability of one exact model, not a core-wide enum.
 */
export type ReasoningEffortId = string & { readonly __reasoningEffort: unique symbol };

/** Brand a provider-declared effort string. */
export function ReasoningEffortId(value: string): ReasoningEffortId {
  return value as ReasoningEffortId;
}

/** Display metadata for one adapter-owned reasoning effort. */
export interface ReasoningEffortInfo {
  id: ReasoningEffortId;
  name: string;
  description?: string;
}

/** Selectable reasoning efforts for one exact model. */
export interface ModelReasoningInfo {
  /** Non-empty, in adapter-preferred display order. */
  efforts: readonly ReasoningEffortInfo[];
  /** Absent preserves the provider's own default. */
  defaultEffort?: ReasoningEffortId;
}

/**
 * Model metadata resolved by its owning adapter. An absent `reasoning` field
 * means the capability is unavailable — adapters must not synthesize an
 * off-only list, since "off" that translates to omitting the parameter is
 * byte-for-byte the same request as naming no effort.
 */
export interface ResolvedModelInfo {
  model: string;
  contextWindow?: number;
  reasoning?: ModelReasoningInfo;
}

export interface ModelEventDone {
  type: "done";
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  /**
   * Adapter-private replay state for this call (e.g. provider thinking-block
   * signatures). The core stores and returns it verbatim and never reads it.
   */
  meta?: unknown;
}

export interface ModelEventError {
  type: "error";
  error: string;
  retriable?: boolean;
}

/**
 * Emitted at most once per stream when the request asked the provider for
 * usage (e.g. `stream_options.include_usage`) but the stream completed
 * without ever yielding a `ModelEventUsage`. Signals a silent provider
 * degradation — observability-only: the Node runner's event loop forwards it
 * straight to the `EventSink` and `continue`s, without ever turning it into
 * an `AgentInput` (see the `usage_unavailable` branch in `runner.ts`'s model
 * event loop), so consumers that don't recognize this event never see it at
 * all.
 */
export interface ModelEventUsageUnavailable {
  type: "usage_unavailable";
}

export type ModelEvent =
  | ModelEventTextDelta
  | ModelEventReasoningDelta
  | ModelEventToolUseStart
  | ModelEventToolUseDelta
  | ModelEventUsage
  | ModelEventDone
  | ModelEventError
  | ModelEventUsageUnavailable;

export interface ModelRequest {
  messages: Message[];
  tools: ToolDefinition[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Adapter-owned reasoning effort; the adapter rejects ids it did not declare. */
  reasoningEffort?: ReasoningEffortId;
  abortSignal?: AbortSignal;
  /** Structured / JSON output mode (provider-specific translation) */
  responseFormat?: { type: "json"; schema?: JSONSchema };
  /**
   * Cache breakpoints — message indices where provider-side prompt cache
   * should be anchored. Provider translates to native cache_control mechanism.
   */
  cacheBreakpoints?: number[];
  /** Mapping of context layer IDs to their message indices in the assembled context */
  layerOrigins?: Array<{ id: string; messageIndex: number }>;
}

export interface ModelPort {
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
  /**
   * Per-model capability query. Optional: a port that does not implement it
   * offers no reasoning control at all.
   */
  describeModel?(model: string): Promise<ResolvedModelInfo>;
}

// ──────────────────────────────────────────────
// FileSystem — file capabilities
// ──────────────────────────────────────────────

export interface FileStat {
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number; // epoch ms
}

export interface FileReadResult {
  content: string;
  totalLines: number;
  truncated: boolean;
}

export interface FileListResult {
  entries: Array<{ name: string; path: string; isDirectory: boolean }>;
}

export interface FileGlobResult {
  paths: string[];
}

export interface FileGrepResult {
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
}

export interface FileSystem {
  read(path: string, offset?: number, limit?: number): Promise<FileReadResult>;
  write(path: string, data: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  list(dir: string): Promise<FileListResult>;
  glob(pattern: string): Promise<FileGlobResult>;
  grep(query: string, opts?: { path?: string; glob?: string; limit?: number }): Promise<FileGrepResult>;
}

// ──────────────────────────────────────────────
// Shell — command execution
// ──────────────────────────────────────────────

export interface ShellEventStdout {
  type: "stdout";
  data: string;
}

export interface ShellEventStderr {
  type: "stderr";
  data: string;
}

export interface ShellEventExit {
  type: "exit";
  code: number;
}

export type ShellEvent = ShellEventStdout | ShellEventStderr | ShellEventExit;

export interface ShellExecOptions {
  cwd?: string;
  timeout?: number;
  runInBackground?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Environment for the child process. When supplied, it replaces the
   * inherited environment entirely (matching `child_process.spawn`'s `env`
   * semantics) — callers that want inheritance must merge `process.env`
   * themselves. Used by the sandbox to strip secret-bearing variables from
   * a sandboxed child.
   */
  env?: Record<string, string>;
}

/**
 * A background process started via `launch`. Persistent shell sessions are
 * deliberately NOT part of this registry and never appear here — see the
 * separation rationale in
 * `docs/superpowers/specs/2026-09-16-shell-lifecycle-design.md` §5.
 */
export interface ShellProcessInfo {
  id: string;
  /** OS pid of the managed process; 0 when unknown. */
  pid: number;
  command: string;
  running: boolean;
  /** Set only after exit. */
  exitCode?: number;
}

export interface ShellProcessOutput {
  /** Incremental text since the cursor. May start with an overflow note. */
  text: string;
  /** Opaque cursor for the next incremental read. */
  cursor: string;
  /** True when the ring buffer discarded earlier bytes. */
  overflowed: boolean;
  /** Cumulative discarded bytes for this process (0 when never overflowed). */
  droppedBytes: number;
}

export interface ShellLaunchOptions {
  cwd?: string;
  /** Replaces the child environment entirely when supplied (same as exec). */
  env?: Record<string, string>;
  /** Optional kill-after timeout for the background process (ms). */
  timeout?: number;
}

export interface Shell {
  exec(cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent>;
  /**
   * Start a background process. Returns a registry id usable with
   * readProcessOutput / killProcess. Absent when the adapter cannot
   * background-launch (tool falls back / errors).
   */
  launch?(cmd: string, opts?: ShellLaunchOptions): Promise<string>;
  /**
   * Incremental output read. Throws on unknown process id — never
   * returns empty output to fake success.
   */
  readProcessOutput?(processId: string, cursor?: string): Promise<ShellProcessOutput>;
  /** Kill a managed process. Throws on unknown process id. */
  killProcess?(processId: string): Promise<void>;
  listProcesses?(): ShellProcessInfo[];
  /** Kill every managed background process. Called when the agent session ends. */
  disposeProcesses?(): Promise<void>;
}

// ──────────────────────────────────────────────
// Network — HTTP capabilities
// ──────────────────────────────────────────────

export interface NetworkRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort signal for cancelling in-flight requests (Cancel → AbortSignal path) */
  abortSignal?: AbortSignal;
}

export interface NetworkResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Network {
  fetch(req: NetworkRequest): Promise<NetworkResponse>;
}

// ──────────────────────────────────────────────
// SessionStore — checkpoint / resume persistence
// ──────────────────────────────────────────────

export interface SessionSnapshot {
  id: string;
  state: AgentState;
  createdAt: number;
}

export interface SessionStore {
  save(snapshot: SessionSnapshot): Promise<void>;
  load(id: string): Promise<SessionSnapshot | undefined>;
  list(): Promise<SessionSnapshot[]>;
}

// ──────────────────────────────────────────────
// TranscriptStore — durable, append-only session event log
// ──────────────────────────────────────────────

export interface ChatSessionMeta {
  title?: string;
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: string | null;
}

/** Why a turn ended. */
export type TurnEndReason = "done" | "error" | "cancelled" | "budget_exceeded";

/** The closed set of dynamic mid-conversation injections this session can audit. */
export type ContextReminderKind =
  | "permission_boundary"
  | "self_correction"
  | "retrieval"
  | "todo_list";

/**
 * The vocabulary of the durable session log. One entry per significant
 * moment; detail comes from the density of the vocabulary, not from any
 * single record being wide.
 */
export interface TranscriptEventMap {
  // ── Lifecycle ──
  session_meta: ChatSessionMeta & {
    parentSessionId?: string;
    delegationDepth?: number;
    origin?: "subagent";
  };
  turn_start: { turn: number };
  turn_end: { turn: number; reason: TurnEndReason; error?: string };

  // ── Model call ──
  /** Written just before the request goes out — the anchor every timing derives from. */
  model_call_start: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /** Points at the most recent request_header's hash. */
    headerHash: string;
  };
  /** One model call's complete output, aggregated. */
  assistant_message: {
    /** Includes the reasoning block when the model produced one — the single source of truth. */
    content: ContentBlock[];
    stopReason?: "end_turn" | "tool_use" | "max_tokens";
    usage?: TokenUsage;
    /** The route that produced it; adapters check it before trusting `modelMeta`. */
    source?: { providerId?: string; modelId: string };
    /** Adapter-private replay state; persisted verbatim, never read by the core. */
    modelMeta?: unknown;
    /** Milliseconds from model_call_start to the first delta; absent when the stream produced none. */
    ttftMs?: number;
    /** Milliseconds from model_call_start to this event. */
    durationMs: number;
    /** not yet recorded */
    interrupted?: true;
  };
  model_error: { error: string; errorKind?: string; retriable: boolean };
  model_retry: { attempt: number; delayMs: number; error: string };

  // ── Tools ──
  tool_call: { callId: string; name: string; input: Record<string, unknown> };
  tool_result: {
    callId: string;
    name?: string;
    content: string;
    isError: boolean;
    durationMs?: number;
    displayMetadata?: Record<string, unknown>;
    /** Index within the batch's pendingTools — the projection's sort key. */
    orderInBatch: number;
  };
  approval_asked: { callId: string; name: string; riskTier: string };
  approval_decision: {
    callId: string;
    decision: "allow" | "deny";
    /** Why, when the gate supplied it. Optional so existing replays stay valid. */
    reason?: ApprovalDenialReason;
  };

  // ── Context ──
  /** Static-prefix snapshot; written only when its hash changes. */
  request_header: {
    hash: string;
    systemLayers: Array<{ id: string; text: string }>;
    tools: Array<{ name: string; description: string; schema: JSONSchema }>;
    params: { model?: string; temperature?: number; maxTokens?: number };
  };
  context_assembled: { layerOrigins: Array<{ id: string; messageIndex: number }> };
  compaction: {
    replacedCount: number;
    summaryText: string;
    /** Ids of the messages the summary replaced. Optional so existing replays stay valid. */
    replacedIds?: string[];
    /** Message id of the written-back summary. Optional so existing replays stay valid. */
    summaryId?: string;
  };
  /** Durable write-back of oversized tool_result pruning into state.messages. */
  tool_results_pruned: {
    entries: Array<{ toolCallId: string; charsBefore: number; charsAfter: number }>;
  };
  /** A dynamic mid-conversation injection: a message appended or spliced in
   * at runtime, distinct from the static system-prompt layers audited via
   * request_header. `text` must be the exact string the model saw — never a
   * re-derived summary of it. */
  context_reminder: {
    kind: ContextReminderKind;
    text: string;
    /** UI-only structured detail (e.g. retrieval fragment count); never sent to the model. */
    displayMetadata?: Record<string, unknown>;
  };
  /** Standing todo list changed (UI dock source). Not a model message. */
  todoListUpdated: {
    todos: TodoItem[];
    counts: { pending: number; inProgress: number; completed: number };
  };

  // ── Input ──
  user_message: { content: string | ContentBlock[] };
  /** Steering — a user message queued mid-turn. Name mirrors the reducer's own event. */
  steering_queued: { content: string | ContentBlock[] };

  // ── Sub-agents ──
  subagent_started: { childSessionId: string; label: string; depth: number };
  subagent_finished: { childSessionId: string; isError: boolean; durationMs: number };

  // ── Other ──
  budget_exceeded: { reason: string };
  error: { message: string };
}

export type TranscriptEventType = keyof TranscriptEventMap;

/** What a writer supplies; `seq` is assigned by the store. */
export interface TranscriptEventInput<T extends TranscriptEventType = TranscriptEventType> {
  /** When the event happened (epoch ms), via the Clock port — not when it was written. */
  time: number;
  type: T;
  data: TranscriptEventMap[T];
  /** Owning turn; present on everything except session-level lifecycle events. */
  turn?: number;
  /** Which model call within the turn (1-based). */
  step?: number;
}

/** A stored event. */
export interface TranscriptEvent<T extends TranscriptEventType = TranscriptEventType>
  extends TranscriptEventInput<T> {
  /** Monotonic and contiguous across the whole session, starting at 0. */
  seq: number;
}

/**
 * Durable, append-only record of a chat session. Distinct from `SessionStore` —
 * that port is a whole-`AgentState` snapshot for HITL checkpoint/resume; this
 * one is a log for display and audit, never read back into a running turn.
 */
export interface TranscriptStore {
  /** Appends a batch, assigning contiguous seq in array order. An empty array is a no-op. */
  appendEvents(sessionId: string, events: TranscriptEventInput[]): Promise<void>;
}

/**
 * The read half of the transcript seam. Separate from `TranscriptStore`
 * because the responsibilities differ and not every implementation needs
 * both — a write-only audit sink is a legitimate `TranscriptStore`.
 */
export interface TranscriptReader {
  readEvents(sessionId: string): Promise<TranscriptEvent[]>;
}

// ──────────────────────────────────────────────
// SkillRegistry — progressive skill disclosure
// ──────────────────────────────────────────────

/** Normalized invocation controls for one skill (dsh-compatible frontmatter defaults). */
export interface SkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  modelInvocable: boolean;
  /** Whether human-facing command catalogs and loaders include this skill. */
  userInvocable: boolean;
}

/** Invocation-neutral skill metadata — the catalog carries this, never the body. */
export interface SkillSummary {
  name: string;
  description: string;
  invocation: SkillInvocationPolicy;
}

/** A skill's body plus the directory its relative resource references resolve against. */
export interface LoadedSkill {
  /** Markdown instructions, frontmatter already stripped and @imports expanded. */
  body: string;
  /**
   * Absolute path of the skill's own directory. Skill bodies routinely point
   * at sibling files in prose ("read references/foo.md"); without this the
   * model resolves them against the agent cwd and never finds them.
   */
  baseDir: string;
}

/**
 * Host-owned skill registry: discovery (summaries only) plus on-demand full
 * body loading. Implementations must NOT cache bodies — every load rereads
 * the current disk state (skills are instructions, their files can change).
 */
export interface SkillRegistry {
  list(): Promise<SkillSummary[]>;
  load(name: string): Promise<LoadedSkill | undefined>;
}

// ──────────────────────────────────────────────
// EventSink — observable event output
// ──────────────────────────────────────────────

export interface EventSink {
  emit(event: { type: string; data: Record<string, unknown> }): void;
}

// ──────────────────────────────────────────────
// ApprovalGate — HITL approval
// ──────────────────────────────────────────────

/**
 * Why an approval ended in `deny`. Recorded so a user can tell a decision
 * they made from one the system made for them — a dropped connection denies
 * fail-closed, which is correct, but silently doing so leaves the user
 * unable to tell that from their own click, or to know a retry is possible.
 */
export type ApprovalDenialReason = "user" | "connection-lost" | "interrupted";

/** An approval outcome with the reason attached. */
export interface ApprovalResult {
  decision: "allow" | "deny";
  reason?: ApprovalDenialReason;
}

export interface ApprovalGate {
  /**
   * Decide one pending call. A bare `"allow"` / `"deny"` stays valid so
   * existing gates need no change; returning an {@link ApprovalResult}
   * additionally records WHY.
   */
  ask(
    call: PendingToolCall,
    riskTier: RiskTier,
  ): Promise<"allow" | "deny" | ApprovalResult>;
}

// ──────────────────────────────────────────────
// Deterministic ports (Clock / Id / Random / Tokenizer)
// ──────────────────────────────────────────────

export interface Clock {
  now(): number;
}

export interface Id {
  next(): string;
}

export interface Random {
  next(): number;
}

export interface Tokenizer {
  count(text: string): number;
}

// ──────────────────────────────────────────────
// ToolSource — dynamic tool discovery (for MCP / plugins)
// ──────────────────────────────────────────────

export interface ToolSource {
  /** List all currently available tools from this source */
  list(): Promise<ToolDefinition[]>;
  /** Optional: subscribe to tool set changes. Returns an unsubscribe function. */
  onChange?(cb: () => void): () => void;
}

// ──────────────────────────────────────────────
// MemoryStore — semantic / long-term memory
// ──────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryStore {
  save(entry: MemoryEntry): Promise<string>;
  query(text: string, k?: number): Promise<MemoryEntry[]>;
  delete(id: string): Promise<boolean>;
}

// ──────────────────────────────────────────────
// Embedder — text to vector
// ──────────────────────────────────────────────

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

// ──────────────────────────────────────────────
// Telemetry — structured observability (distinct from EventSink)
// ──────────────────────────────────────────────

export interface TelemetrySpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

export interface Telemetry {
  startSpan(name: string, attributes?: Record<string, unknown>): TelemetrySpan;
  metric(name: string, value: number, attributes?: Record<string, unknown>): void;
}

// ──────────────────────────────────────────────
// Cache — general-purpose key/value cache
// ──────────────────────────────────────────────

export interface Cache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
}

// ──────────────────────────────────────────────
// Sandbox — isolated execution environment
// ──────────────────────────────────────────────

export interface SandboxExecSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  isolation?: "none" | "process" | "container";
  timeout?: number;
  abortSignal?: AbortSignal;
}

export interface SandboxEvent {
  type: "stdout" | "stderr" | "exit";
  data?: string;
  code?: number;
}

export interface Sandbox {
  run(spec: SandboxExecSpec): AsyncIterable<SandboxEvent>;
}

// ──────────────────────────────────────────────
// Secrets — secure credential resolution
// ──────────────────────────────────────────────

export interface Secrets {
  resolve(ref: string): Promise<string | undefined>;
}

// ──────────────────────────────────────────────
// Scheduler — timed / delayed / background tasks
// ──────────────────────────────────────────────

export interface Scheduler {
  schedule(delayMs: number, ref: string): Promise<string>;
  cancel(id: string): Promise<boolean>;
  sleep(ms: number, abortSignal?: AbortSignal): Promise<void>;
}

// ──────────────────────────────────────────────
// PolicyEngine — external authorization decision
// ──────────────────────────────────────────────

export interface PolicyRequest {
  action: string;
  principal?: string;
  context?: Record<string, unknown>;
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): Promise<"allow" | "deny" | "ask">;
}
