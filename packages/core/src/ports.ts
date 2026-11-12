/**
 * Ports — interface contracts for all external capabilities.
 * These are types only; implementations are provided by adapters.
 * The core imports these interfaces, never their implementations.
 */

import type {
  AgentState,
  ContentBlock,
  Message,
  PendingToolCall,
  TodoItem,
  ToolResultBlock,
} from "./state.js";
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
  /**
   * Whether this provider/protocol reports prompt-cache buckets at all.
   * Absent on old events/adapters and treated as "reported" by the UI.
   */
  cacheReporting?: "reported" | "not-reported" | "unsupported";
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
 * Input modalities a model accepts. Structural mirror of pi-ai's
 * `Model['input']` (@earendil-works/pi-ai@0.87.1 `types.d.ts`); core is
 * zero-dependency, so the shape is copied rather than imported.
 */
export type ModelInputValue = readonly ("text" | "image")[];

/**
 * Input limits a provider imposes. Field-for-field mirror of pi-ai's
 * `ModelInputLimits` (@earendil-works/pi-ai@0.87.1 `types.d.ts`), so the
 * pi-ai provider adapter can assign pi-ai's own value without a cast.
 * Directory fact, read-only — there is no override (spec §1.3 / D5).
 */
export interface ModelInputLimits {
  /** Maximum serialized provider request size in bytes. */
  maxRequestBytes?: number;
  images?: {
    /** Cache-safe resize profile applied before a new image enters conversation history. */
    resize?: {
      maxWidth?: number;
      maxHeight?: number;
      /** Maximum base64-encoded payload size in bytes. */
      maxBytes?: number;
      jpegQuality?: number;
    };
    /** Maximum images accepted in one provider message. */
    maxPerMessage?: number;
    /** Maximum images accepted across one provider request. */
    maxPerRequest?: number;
  };
}

/**
 * Model metadata resolved by its owning adapter. An absent `reasoning` field
 * means the capability is unavailable — adapters must not synthesize an
 * off-only list, since "off" that translates to omitting the parameter is
 * byte-for-byte the same request as naming no effort.
 */
export type ModelCacheCapability =
  | { mode: "none" }
  | { mode: "implicit"; minTokens?: number }
  | {
      mode: "explicit";
      minTokens: number;
      maxMarkers: number;
      blockWindow: number;
      ttlSeconds?: number;
      writeUsageField?: "cache_write_tokens" | "cache_creation_input_tokens";
    };

export interface ResolvedModelInfo {
  model: string;
  /** Wire protocol the adapter will use for this model, when it has one. */
  api?: string;
  /** Prompt-cache support declared by the adapter/catalog. */
  cache?: ModelCacheCapability;
  contextWindow?: number;
  reasoning?: ModelReasoningInfo;
  /**
   * Input modalities, tri-state: absent = UNKNOWN (never gated); present
   * without "image" = text-only (gates). Absence means UNKNOWN, not
   * unavailable: gateways that cannot describe their models must not
   * silently lose the image path, because a vanished tool is harder to
   * diagnose than a 400. Only an explicit text-only list gates tools out.
   */
  input?: ModelInputValue;
  /** Provider input limits (directory fact, read-only). Absent for custom/synthesized models. */
  inputLimits?: ModelInputLimits;
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

/** Raw bytes read from a file, for binary formats such as images. */
export interface FileReadBytesResult {
  /** Base64-encoded file bytes. */
  data: string;
  mimeType?: string;
  size: number;
  /**
   * Pixel dimensions when the adapter recognizes the bytes as an image.
   * Parsed from the format header — no decoding library required.
   */
  width?: number;
  height?: number;
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
  /** Read a file as raw bytes. Used for images and other binary formats. */
  readBytes(path: string): Promise<FileReadBytesResult>;
  write(path: string, data: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  list(dir: string): Promise<FileListResult>;
  glob(pattern: string): Promise<FileGlobResult>;
  grep(query: string, opts?: { path?: string; glob?: string; limit?: number }): Promise<FileGrepResult>;
  /**
   * Resolve a model-given path to the ABSOLUTE host path it names,
   * enforcing the workspace boundary (throws on escape). Optional: needed
   * by consumers that leave the port and hit raw fs — the document parser
   * opens files with its own library and cannot resolve workspace-relative
   * paths itself. `FileStat.path` deliberately stays root-relative and is
   * NOT a substitute. Implementations that only ever see absolute paths
   * may omit it; callers fall back to the model-given path.
   */
  resolvePath?(path: string): Promise<string>;
}

// ──────────────────────────────────────────────
// SpillStore — oversized tool-result persistence
// ──────────────────────────────────────────────

/** Inputs for {@link SpillStore.write}. */
export interface SpillWriteInput {
  sessionId: string;
  toolCallId: string;
  text: string;
}

export interface SpillStore {
  /**
   * Persist `text` at a deterministic path derived from sessionId +
   * toolCallId. Returns the WORKSPACE-RELATIVE path for model display
   * (must be readable by FileSystem.read / read_file). Overwrites on
   * repeat — idempotent by construction. Throws on I/O failure (caller
   * degrades, §6).
   */
  write(input: SpillWriteInput): Promise<{ relativePath: string }>;
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
  /**
   * Present and true only when the adapter's own timeout timer killed the
   * process; absent on ordinary exits (backward-compatible wire shape).
   */
  timedOut?: boolean;
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
  /** Wire protocol used by this session's model, when resolved. */
  protocol?: string;
  /** Who produced the current title; decides what may overwrite it. */
  titleSource?: "user" | "model" | "heuristic";
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
  | "workflow_mode"
  | "self_correction"
  | "loop_reminder"
  | "loop_intervention"
  | "retrieval"
  | "todo_list"
  | "background_task"
  | "workspace";

/**
 * Where a user-role message came from when it was not typed by a human.
 *
 * `subagent-task` is the parent agent's dispatch into a child session;
 * `host-continuation` is a host/user follow-up sent into a subagent session.
 * The model-visible content is unchanged; this is audit provenance only.
 */
export type UserMessageSource =
  | {
      kind: "subagent-task";
      /** Parent session that dispatched the task. */
      parentSessionId: string;
      /** Dispatch task id, shared with the parent's subagent events. */
      taskId: string;
      /** Human-readable dispatch label, when one existed. */
      label?: string;
    }
  | {
      kind: "host-continuation";
      /** Parent session the continuation belongs to, when known. */
      parentSessionId?: string;
    };

// ──────────────────────────────────────────────
// Acceptance verification — dispatch-level verdict metadata
// ──────────────────────────────────────────────

/** Outcome of verifying a dispatch against its acceptance criteria. */
export type AcceptanceStatus = "passed" | "failed" | "error";

/**
 * Verification outcome shared by the result envelope, display metadata and
 * the `subagent_finished` event. `error` means verification itself could not
 * run (timeout / unparseable output); it is not a substantive failure.
 */
export interface VerificationSummary {
  status: AcceptanceStatus;
  /** Child-agent runs actually executed (1..maxReworks+1), verifier calls excluded. */
  attempts: number;
  failures: string[];
  verifierError?: string;
}

/** Full verification payload carried by the dispatch result envelope. */
export interface DispatchVerification extends VerificationSummary {
  retryHint?: string;
  /** Sum over all verifier calls; never merged into the child's own usage. */
  usage?: TokenUsage;
}

/**
 * The vocabulary of the durable session log. One entry per significant
 * moment; detail comes from the density of the vocabulary, not from any
 * single record being wide.
 */
/** One message's structural summary in a model request manifest. */
export interface ModelRequestMessage {
  /** Stable message id from core state. */
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  /** Content block type names, in order (never text or image bytes). */
  blocks: string[];
  /** Text/structured character count; absent for non-text content. */
  textChars?: number;
  /** Assistant tool_use ids in this message. */
  toolUseIds?: string[];
  /** Tool-result ids carried by this message. */
  toolResultIds?: string[];
  /** Image attachment refs, never bytes. */
  imageRefs?: Array<{ id: string; mediaType: string; width?: number; height?: number }>;
}

/**
 * Audit manifest for one model call. It records *what was sent* structurally
 * (message ids/roles, block kinds, image refs, tool names), never the full
 * body or image bytes. `request_header` remains the static-prefix snapshot.
 */
export interface ModelRequestManifest {
  headerHash: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  toolNames: string[];
  messages: ModelRequestMessage[];
}

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
  /** Per-call request manifest, written after RAG/image finalization. */
  model_request: ModelRequestManifest;
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
    /**
     * String for plain-text results (legacy logs stay valid); a block array
     * when the tool returned images or mixed content. Never join-flattened on
     * the way in — the attachment ref is the only handle on an image.
     */
    content: string | ToolResultBlock[];
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
    /**
     * Ref metadata for the images preserved on the user-role carrier message
     * right after the summary (spec 2026-10-16 D5 v1.2). Reference only — the
     * ref id / mediaType / dims the projection needs to rebuild the carrier;
     * never image bytes. Optional so existing (older) events replay
     * unchanged: without it there is no carrier to rebuild.
     */
    preservedImages?: Array<{
      id: string;
      mediaType: string;
      width?: number;
      height?: number;
    }>;
    /**
     * Usage of the summarization model call itself. Optional: adapters that
     * do not report usage, and older events, omit it. When present it is
     * included in the turn's usage/cost totals — otherwise the compaction
     * call is invisible to the cache-hit and cost meters.
     */
    usage?: TokenUsage;
  };
  /** Durable write-back of oversized tool_result pruning into state.messages. */
  tool_results_pruned: {
    entries: Array<{
      toolCallId: string;
      charsBefore: number;
      charsAfter: number;
      savedTokens?: number;
      cacheResetTokens?: number;
      cacheResetEstimated?: boolean;
    }>;
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
  /** A user-role message's producer; absent on plain human input and old logs. */
  user_message: { content: string | ContentBlock[]; source?: UserMessageSource };
  /** Steering — a user message queued mid-turn. Name mirrors the reducer's own event.
   *  `id` is stamped at enqueue time (Id port) so projections can match the
   *  queued entry to its delivery. */
  steering_queued: { id: string; content: string | ContentBlock[] };
  /** Steering — queued messages injected at a turn boundary. `ids` carries
   *  every drained message id in FIFO order; emitted only when the drained
   *  queue is non-empty. */
  steering_delivered: { ids: string[] };
  /** Steering — a queued message's content was replaced in place (D14). The
   *  id stays the queued entry's own; projections fold it over the matching
   *  `steering_queued`. */
  steering_edited: { id: string; content: string | ContentBlock[] };
  /** Steering — a queued message was withdrawn before delivery (D15). Hard
   *  delete: projections drop the matching `steering_queued` entry; the event
   *  itself is the audit trail. */
  steering_removed: { id: string };
  /** A debounced FileWatcher batch injected as AgentInput. Paths only — never file content. */
  file_changed: {
    watchId: string;
    events: Array<{ type: "change" | "rename"; path: string; mtime?: number }>;
  };

  // ── Sub-agents ──
  subagent_started: {
    childSessionId: string;
    label: string;
    depth: number;
    /** Dispatch-supplied one-line task label (absent on pre-title sessions). */
    title?: string;
    /** Dispatch identity shared with the parent tool result; absent on old logs. */
    taskId?: string;
    /** True when this dispatch runs detached; absent for a synchronous dispatch. */
    background?: true;
    /** Resolved subagent_type, when the dispatch named one. */
    subagentType?: string;
    /**
     * The boundary the child actually ran under (spec 2026-11-11 D6). Absent
     * on logs written before the field existed. `preset` is present only when
     * the effective pair is exactly one of the named presets — an
     * unexpressible pair stays raw so the UI does not invent a label.
     */
    permission?: {
      sandbox: string;
      approval: string;
      preset?: string;
    };
  };
  subagent_finished: {
    childSessionId: string;
    isError: boolean;
    durationMs: number;
    /** Dispatch identity shared with the parent tool result; absent on old logs. */
    taskId?: string;
    /** Acceptance verdict for dispatches that named criteria; absent on old logs and unverified dispatches. */
    verification?: VerificationSummary;
  };
  /**
   * A definition (or a per-dispatch allowlist) named tools / capabilities the
   * assembled child could not get, because the intersection rule keeps only
   * what the parent owns. Durable so the loss is auditable after a reload —
   * a sink-only event would vanish with the process.
   */
  subagent_tools_dropped: {
    childSessionId?: string;
    subagentType?: string;
    droppedTools: string[];
    droppedCapabilities: string[];
  };
  /**
   * The definition asked for a wider permission axis than the parent allows
   * and `narrowPermission` took the stricter option (F-023). Same durable,
   * parent-level channel as the drops above.
   */
  subagent_permission_downgraded: {
    childSessionId?: string;
    subagentType: string;
    downgrades: Array<{ field: string; requested: string; effective: string }>;
  };

  /**
   * A dispatch named a routing tier that could not resolve to a model port
   * and degraded to the parent model. Durable alongside the live sink event so
   * a reload/export keeps the visible fallback.
   */
  subagent_model_tier_unresolved: {
    childSessionId?: string;
    subagentType?: string;
    tierId: string;
    turn: number;
    target?: { providerId: string; modelId: string };
  };

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
  /** ask_user 的回答（选中 label 与自由输入的归并）。仅 ask 类调用携带。 */
  answer?: string[];
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

/** Memory content classification: episodic events vs semantic facts. */
export type MemoryTier = "episodic" | "semantic";

/** Visibility scope of a memory entry. */
export type MemoryScope =
  | { kind: "project"; projectId: string }
  | { kind: "global" };

/**
 * Optional filter for MemoryStore.query. Passing no filter at all returns
 * every entry (advanced / test use only; RAG and the memory tool must
 * always pass a filter).
 *
 * Branch semantics every implementation must agree on:
 * - no filter at all: every entry (advanced / test use only).
 * - `{ projectId }`: that project's entries plus global entries.
 * - `{ projectId, includeGlobal: false }`: that project's entries only.
 * - `{ includeGlobal: true }` (no projectId): global entries only.
 * - `{ includeGlobal: false }` (no projectId): nothing — never any project.
 * - `{ tier }` only (no projectId / includeGlobal): global entries of that
 *   tier only — never every project.
 * - an empty filter object `{}`: nothing.
 */
export interface MemoryQueryFilter {
  /**
   * When set, return entries scoped to this project PLUS global entries
   * (global entries are included by default; pass includeGlobal: false to
   * exclude them).
   */
  projectId?: string;
  /**
   * With projectId: include global entries alongside project entries
   * (default true; false returns project entries only).
   * Without projectId: true means global entries only, false returns an
   * empty result (never entries from any project).
   */
  includeGlobal?: boolean;
  /**
   * Only entries of this tier. A missing tier on save normalizes to
   * "semantic" (see MemoryEntry.tier), so an entry saved without a tier
   * matches a tier: "semantic" filter.
   */
  tier?: MemoryTier;
}

export interface MemoryEntry {
  id: string;
  text: string;
  scope?: MemoryScope;
  /** Defaults to "semantic" when omitted on save; stores normalize it. */
  tier?: MemoryTier;
  source?: "tool" | "user" | "compaction";
  sessionId?: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryStore {
  save(entry: MemoryEntry): Promise<string>;
  query(text: string, k?: number, filter?: MemoryQueryFilter): Promise<MemoryEntry[]>;
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
// FileWatcher — event-triggered workspace file watching
// ──────────────────────────────────────────────

export interface FileWatchEvent {
  /** "change" = content/metadata; "rename" = create/delete/rename */
  type: "change" | "rename";
  /** Workspace-relative path */
  path: string;
  /** Present when the path still exists after the event */
  mtime?: number;
}

export interface FileWatchRegistration {
  /** Workspace-relative file paths and/or directories */
  paths: string[];
  /** Optional glob filter applied to event paths (e.g. "**&#47;*.ts") */
  glob?: string;
  /** Debounce window in ms. Adapter default: 200 */
  debounceMs?: number;
}

export interface FileWatcher {
  /**
   * Start watching. Returns a watch id.
   * Events are delivered to `onEvents` as debounced batches.
   * `onEvents` may be called many times; it must not throw into the adapter.
   */
  watch(
    reg: FileWatchRegistration,
    onEvents: (events: FileWatchEvent[]) => void,
  ): Promise<string>;
  /** Stop one watch. Unknown id is a no-op (returns false). */
  unwatch(id: string): Promise<boolean>;
  /** Active watch ids, for list_watches. */
  list(): Promise<string[]>;
  /** Tear down every watch (process exit / session dispose). */
  dispose?(): Promise<void>;
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

// ──────────────────────────────────────────────
// AttachmentStore — durable binary payload storage
// ──────────────────────────────────────────────

export interface StoredAttachment {
  id: string;
  mimeType: string;
  size: number;
  /** Present when the bytes were recognized as an image. */
  width?: number;
  height?: number;
  /**
   * Original filename as reported by the client at upload; model-visible.
   * Untrusted input: it may surface in prompt text and UI, but never takes
   * part in addressing — stores key bytes by `id` alone.
   */
  name?: string;
}

/**
 * Durable storage for binary payloads referenced from conversation state.
 * Keeps AgentState small: snapshots carry ids, never bytes.
 */
export interface AttachmentStore {
  /**
   * Store bytes and return the reference. `data` is base64.
   * `opts.name` is the client's original filename: model-visible only,
   * never used for addressing. Omitting it keeps the meta free of `name`.
   * `opts.id` overrides addressing: a valid id overwrites any previous
   * attachment under that id (deterministic replay/rerun) and MUST be a
   * valid path segment. Omitting it keeps the uuid fallback unchanged.
   */
  put(
    data: string,
    mimeType: string,
    opts?: { name?: string; id?: string },
  ): Promise<StoredAttachment>;
  /**
   * Fetch the bytes as base64 alongside the metadata recorded at ingest.
   * Returns undefined when the id is unknown.
   *
   * The metadata is part of the contract, not a convenience: a caller
   * building an ImageContent ref has no other source for `width`/`height`,
   * and without them the token estimate falls back to a constant.
   */
  get(id: string): Promise<(StoredAttachment & { data: string }) | undefined>;
  /** Drop every attachment belonging to a session. */
  deleteBySession(sessionId: string): Promise<void>;
}

// ──────────────────────────────────────────────
// PlanStore — plan-mode artifact storage (gateway-managed, project-scoped)
// ──────────────────────────────────────────────

export interface PlanStore {
  /** Overwrite the session's current plan document. */
  save(sessionId: string, projectPath: string, content: string): Promise<void>;
  /** The session's current plan, or null when none was saved. */
  read(sessionId: string, projectPath: string): Promise<string | null>;
  /** Drop the plan alongside its session (same lifecycle as the transcript). */
  deleteBySession(sessionId: string, projectPath: string): Promise<void>;
}
