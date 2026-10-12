/**
 * createAgent — SDK facade.
 *
 * Wires up the core reducer, runner, tool routing, capability gating,
 * and all adapters into a single high-level API:
 *   run(input)    — execute one turn, return final state
 *   stream(input) — yield events as they happen (async generator)
 *   resume(id, decision) — resume a HITL-paused session
 *
 * Defaults are provided for all ports except ModelPort, so the minimal
 * call is `createAgent({ modelPort })`.
 */

import type {
  ModelPort,
  ToolDefinition,
  EventSink,
  SessionStore,
  PermissionConfig,
  ToolResult,
  AgentInput,
  PendingToolCall,
  ReadFileRecord,
  FileSystem,
  Shell,
  Network,
  Message,
  CompactionConfig,
  ApprovalGate,
  ToolSource,
  MemoryStore,
  Embedder,
  Telemetry,
  Cache,
  Sandbox,
  Secrets,
  Scheduler,
  PolicyEngine,
  JSONSchema,
  ToolScopeConfig,
  Id,
  Clock,
  ContextLayer,
  ContextLayerHints,
  SkillRegistry,
  SkillSummary,
  AttachmentStore,
  PlanStore,
  FileWatcher,
  FileWatchEvent,
} from "@volto/core";
import {
  createDefaultPermissionConfig,
  ceilingOf,
  extractPlainText,
  createInitialState,
  resetTurnForNextInput,
  filterByScope,
  extractTouchedToolPaths,
  parseSkillInvocation,
  ReasoningEffortId,
  CAP_MODEL_VISION,
  narrowPermission,
  CAP_AGENT_DEPTH_AVAILABLE,
} from "@volto/core";
import type { StepContext, ReducerState, TranscriptStore, TranscriptEventInput, ChatSessionMeta } from "@volto/core";
import { createRunner, type Runner, type ToolExecutor } from "@volto/runtime-node";
import type { RunnerOptions, CompactNowResult } from "@volto/runtime-node";
import {
  createFsToolExecutor,
  createShellToolExecutor,
  createNetworkToolExecutor,
} from "@volto/runtime-node";
import { createAutoAllowGate, createSubAgentApprovalGate } from "@volto/runtime-node";
import {
  createSandboxedShell,
  createSandboxSessionSpawner,
  createPersistentSession,
  type SandboxConfig,
  type PersistentSession,
  type SessionSpawnHandle,
} from "@volto/runtime-node";
import { createNodeAttachmentStore, createNodeDocumentParser, wrapNetworkWithEgress } from "@volto/runtime-node";
import type { EgressPolicy } from "@volto/runtime-node";
import type { Tool } from "@volto/tools-common";
import type { SubAgentDispatch, AgentTypeSummary } from "@volto/tools-agent";
import { createTaskTool, createTaskOutputTool, CAP_AGENT_TASK } from "@volto/tools-agent";
import type { AgentEntry } from "./agent-registry/index.js";
import type { AgentSpec } from "./agent-spec.js";

/**
 * Sync sub-agent request handed to the per-dispatch executor. Background
 * dispatch wraps the same executor: the promise is registered with the
 * BackgroundRegistry instead of awaited inline.
 */
type SyncSubAgentRequest = { message: string; subagentType?: string };
/**
 * The child's answer plus the transcript session it wrote, so a caller can
 * hand the UI something to drill into. Absent session id means the dispatch
 * had no parent session to hang a child session off of.
 */
type SyncSubAgentOutcome = { text: string; sessionId?: string };
type SyncSubAgentExecutor = (req: SyncSubAgentRequest) => Promise<SyncSubAgentOutcome>;
import {
  createReadFileTool,
  createEditFileTool,
  createWriteFileTool,
  createApplyPatchTool,
  createMultiEditTool,
  createLsTool,
  createGlobTool,
  createGrepTool,
  createWatchFilesTool,
  createUnwatchFilesTool,
  createListWatchesTool,
  CAP_FS_WATCH,
  FS_EXECUTOR_TOOL_NAMES,
} from "@volto/tools-fs";
import {
  createBashTool,
  createBashOutputTool,
  createKillShellTool,
  SHELL_TOOL_NAMES,
  type BashSessionLike,
} from "@volto/tools-shell";
import { createWebFetchTool, createWebSearchTool, NETWORK_TOOL_NAMES } from "@volto/tools-web";
import {
  createLspDefinitionTool,
  createLspReferencesTool,
  createLspRenameTool,
  createLspDiagnosticsTool,
  createLspHoverTool,
  CAP_LSP_QUERY,
} from "@volto/tools-code";
import type { LspClientProvider } from "@volto/tools-code";
import {
  createGitStatusTool,
  createGitDiffTool,
  createGitCommitTool,
  createGitPushTool,
  createRunTestsTool,
  createBuildTool,
} from "@volto/tools-vcs";
import { createAskUserTool } from "@volto/tools-ask";
import { createTodoWriteTool, CAP_PLAN_WRITE } from "@volto/tools-plan";
import { createHttpQueryTool, createDbQueryTool, createDbExecTool, CAP_DB_READ, CAP_DB_WRITE } from "@volto/tools-data";
import type { DatabaseOpener } from "@volto/tools-data";
import { createReadDocumentTool } from "@volto/tools-document";
import type { DocumentParserAdapter, DocumentParseOptions } from "@volto/tools-document";
import { createScheduleTool, createCancelScheduleTool } from "@volto/tools-schedule";
import { createSkillTool } from "@volto/tool-skill";
import {
  createBrowserNavigateTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserScreenshotTool,
  createBrowserGetPageTextTool,
} from "@volto/tools-browser";
import type { BrowserAdapter } from "@volto/tools-browser";
import {
  defaultEventSink,
  defaultTokenizer,
  createDefaultSessionStore,
  defaultChatStore,
  defaultToolSource,
  createDefaultMemoryStore,
  defaultEmbedder,
  defaultTelemetry,
  createDefaultCache,
  defaultSandbox,
  defaultSecrets,
  defaultScheduler,
  defaultPolicyEngine,
  defaultId,
} from "./defaults.js";
import { createStreamChannel } from "./stream-channel.js";
import { createCostMeter, type PricingTable } from "./cost-meter.js";
import { type ResolvedConfig, type ConfigLayer } from "./config.js";
import {
  type Plugin,
  type CollectedPlugins,
  type PluginAgentSpec,
  collectPlugins,
} from "./plugin.js";
import { renderCommand, matchCommand } from "./commands.js";
import { type AuditSink, defaultAuditSink } from "@volto/runtime-node";

// ──────────────────────────────────────────────
// Config resolution helper
// ──────────────────────────────────────────────

/**
 * Lazy node document parser. `createNodeDocumentParser` is async (optional
 * format libraries load on demand), but createAgent is sync — so the adapter
 * resolves the real parser on first parse() instead of at construction.
 * A missing format library surfaces as that tool call's isError, never as a
 * construction-time failure that would hide the whole tool.
 */
function createLazyNodeDocumentParser(): DocumentParserAdapter {
  let pending: Promise<DocumentParserAdapter> | undefined;
  return {
    async parse(filePath: string, opts?: DocumentParseOptions) {
      pending ??= createNodeDocumentParser();
      const parser = await pending;
      // Forward opts — dropping it here silently loses `pages` (the lazy
      // adapter sits between every tool and the real parser).
      return parser.parse(filePath, opts);
    },
  };
}

/**
 * The `subagent_type` values a task tool offers. Shadowed definitions are
 * left out: a name that resolves to a different file than the one the user
 * is looking at would dispatch something they did not choose.
 */
function toAgentTypeSummaries(entries: AgentEntry[]): AgentTypeSummary[] {
  return entries
    .filter((entry) => !entry.shadowed)
    .map((entry) => ({
      name: entry.spec.name,
      ...(entry.spec.description !== undefined ? { description: entry.spec.description } : {}),
    }));
}

/**
 * Append plugin-registered definitions to the scanned ones. Plugins rank
 * below every file source (design §5): a name a file already defines shadows
 * the plugin's entry rather than dropping it, so a host can still show why
 * the plugin's version is not the one in effect. Hosts that already merged
 * plugin specs into their scan (the `/agents` route does) pass them once —
 * a duplicate name arriving twice lands shadowed, never as a second live
 * definition.
 */
function withPluginAgentSpecs(
  entries: AgentEntry[],
  pluginSpecs: PluginAgentSpec[],
): AgentEntry[] {
  if (pluginSpecs.length === 0) return entries;
  const taken = new Set(entries.map((entry) => entry.spec.name));
  return [
    ...entries,
    ...pluginSpecs.map((spec) => ({
      id: `plugin:${spec.name}`,
      scope: "plugin" as const,
      spec,
      shadowed: taken.has(spec.name),
    })),
  ];
}

/** Default delegation depth budget: main agent (0), one level of sub-agents (1). */
const DEFAULT_MAX_AGENT_DEPTH = 2;

/**
 * Resolve a value: explicit opts wins, then config layer, then undefined.
 * Pure function — no side effects.
 */
function resolveConfigValue<T>(
  explicit: T | undefined,
  configLayer: ConfigLayer | undefined,
  key: keyof ConfigLayer,
): T | undefined {
  if (explicit !== undefined) return explicit;
  if (configLayer === undefined) return undefined;
  return configLayer[key] as T | undefined;
}

/**
 * Best-effort transcript write: awaits the call inside its own try/catch
 * rather than chaining `.catch()` on its return value. A store whose
 * `appendEvents` is a plain (non-`async`) function that throws synchronously
 * never produces a promise for `.catch()` to attach to — the throw would
 * instead escape into the caller, turning a best-effort transcript write
 * into a hard failure. Two of this function's six call sites
 * (`recordTurnEndError` / `recordTurnError`) run inside error-handling paths
 * whose own doc comments promise "never throws into the caller" — a
 * synchronous throw here would silently replace the real error the caller
 * was about to see. Same class of bug fixed in the transcript recorder by
 * commit 21bd938 and in apps/headless-server/src/sessions.ts's own catch
 * block; this is every remaining call site in this file brought up to the
 * same standard.
 */
function bestEffortAppend(
  store: TranscriptStore,
  sessionId: string,
  events: TranscriptEventInput[],
): void {
  void (async () => {
    try {
      await store.appendEvents(sessionId, events);
    } catch {
      // Best-effort by contract — a transcript write must never disturb the
      // turn it is recording.
    }
  })();
}

// ──────────────────────────────────────────────
// Background registry
// ──────────────────────────────────────────────

/** Result of collecting a background task: either its text or a normalized error. */
export type BackgroundCollectResult = { text: string } | { error: string };

/**
 * Holds promises for detached sub-agents. Deliberately separate from
 * AgentState: a promise cannot be serialized, and state only needs to record
 * that a task exists so a resumed Runner can fail it.
 *
 * A rejection is normalized into an error result rather than propagated —
 * a detached task must never take the parent loop down with it.
 */
export interface BackgroundRegistry {
  register(taskId: string, promise: Promise<string>): void;
  collect(taskId: string): Promise<BackgroundCollectResult>;
  /** Ids registered but not yet collected. */
  pending(): string[];
  /**
   * True when collect() has already cached a result for this id. The
   * Runner's turn-boundary drain uses this to skip tasks the model picked
   * up via task_output: that path updates only this cache, never
   * state.backgroundTasks.status, so without the check the drain would
   * feed the same result to the model a second time.
   */
  isCollected(taskId: string): boolean;
}

export function createBackgroundRegistry(): BackgroundRegistry {
  // Settled-result cache: collect() is idempotent because the second call
  // hits this map instead of re-awaiting (and re-normalizing) the promise.
  const settled = new Map<string, BackgroundCollectResult>();
  const inFlight = new Map<string, Promise<BackgroundCollectResult>>();

  return {
    register(taskId, promise) {
      // Normalize once at registration so an early rejection never becomes an
      // unhandled rejection while the task is still running detached.
      const normalized = promise.then<BackgroundCollectResult, BackgroundCollectResult>(
        (text) => ({ text }),
        (err: unknown) => ({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      inFlight.set(taskId, normalized);
    },

    async collect(taskId) {
      const done = settled.get(taskId);
      if (done !== undefined) return done;
      const pendingPromise = inFlight.get(taskId);
      if (pendingPromise === undefined) {
        return { error: `unknown task: ${taskId}` };
      }
      const result = await pendingPromise;
      settled.set(taskId, result);
      inFlight.delete(taskId);
      return result;
    },

    pending() {
      return [...inFlight.keys()];
    },

    isCollected(taskId) {
      return settled.has(taskId);
    },
  };
}

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

/** Default timeout for a single command inside the persistent bash session. */
const SHELL_SESSION_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Env-var name patterns stripped from the bare (no sandboxConfig) persistent
 * session's environment. Conservative defaults — a host that needs finer
 * control should pass `sandboxConfig.strippedEnvPatterns` or a custom
 * `sessionSpawner`.
 */
export const DEFAULT_SESSION_SECRET_ENV_PATTERNS: readonly RegExp[] = [
  /SECRET/i,
  /TOKEN/i,
  /API_?KEY/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /PRIVATE_?KEY/i,
];

export interface CreateAgentOptions {
  /** Model port — required, the LLM provider */
  modelPort: ModelPort;

  /**
   * Resolved layered config (global < project < runtime).
   * When provided, config values fill in defaults for any option not
   * explicitly set in this CreateAgentOptions object.
   * Runtime-level opts (this object) always take highest priority.
   */
  config?: ResolvedConfig;

  /**
   * Plugins to register. Each plugin declares its tools / providers / hooks
   * via `register(registry)`. Plugin tools are merged into the ToolSource
   * pipeline and go through the same capability-gating + permission checks.
   */
  plugins?: Plugin[];

  /**
   * Custom tools to register. Adapter-backed tools (fs/shell/web) are
   * auto-created when the corresponding adapter is provided.
   */
  tools?: Tool[];

  /**
   * System prompt prepended as the first message in every conversation.
   * Persists across turns and survives compaction.
   *
   * Mirrored into the transcript's `request_header.systemLayers` via the
   * Runner's `seedSystemPrompt` option — the seed message alone never
   * appears in the header, and a context layer would duplicate the prompt
   * into the model request. Skipped there if the host's own layers already
   * contain that id.
   */
  systemPrompt?: string;

  /**
   * Called once per turn with that turn's user-message text; returns the
   * workspace-instruction content layers (AGENTS.md-style memory/instruction
   * files the host discovers itself) for that turn's StepContext.contextLayers.
   * Skills are not part of this callback — they flow through the separate
   * `skillRegistry` option (catalog layer + skill tool). No default —
   * packages/sdk stays host-agnostic and does not know about `~/.volto` or any
   * instruction-file directory convention (that is apps/headless-server's job).
   * Omitted means contextLayers is always empty, identical to today's behavior.
   *
   * The second argument carries history-derived hints (`{ touchedPaths }` —
   * structured fs paths touched so far, derived from the conversation's
   * tool_use history; empty on a fresh first turn) so hosts can keep
   * instruction-file discovery in sync with what the agent has actually
   * touched.
   */
  resolveContextLayers?: (input: string, hints?: ContextLayerHints) => Promise<ContextLayer[]>;

  /**
   * 首轮种子历史消息 —— 追加在 systemPrompt 消息之后，作为第一轮
   * ReducerState.messages 的初始内容。仅影响"第一轮"（lastFinalState 为空
   * 时）；一旦有过完成的轮次，后续轮次由内部的 lastFinalState 续接，不再
   * 读取这个选项。典型用途：宿主应用重建 Agent 实例时，把此前持久化的
   * 对话历史重新灌入，让上下文不因实例重建而丢失。
   */
  initialMessages?: Message[];

  /**
   * Workflow-mode announcement for the reducer (spec 2026-09-25). Passed
   * through verbatim — the SDK owns no mode vocabulary or text.
   */
  workflowReminder?: { key?: string; announce: string };
  /**
   * Rebuild seeding for the workflow fingerprint: the previous instance's
   * `_announcedWorkflowMode` (initialMessages / initialTurn family). Mode
   * switches go through rebuild; without this the exit note never fires
   * (spec §3.1-0).
   */
  initialAnnouncedWorkflowMode?: string;

  /**
   * Seeds the internal turn counter so a rebuilt agent instance continues
   * numbering instead of restarting at 1. This is the ordinal of the LAST
   * turn already present in the durable transcript (chatStore) — the next
   * turn run() or stream() executes becomes `initialTurn + 1`, and a
   * cross-process `resume()` of that already-in-flight last turn reports
   * `initialTurn` itself (matching the turn number the paused turn was
   * originally recorded under).
   *
   * The SDK cannot recover this value on its own: `SessionSnapshot` carries
   * no turn number and `TranscriptStore` is write-only. A host that rebuilds
   * agent instances mid-conversation (e.g. apps/headless-server rebuilding
   * on every config change) must compute it from its own transcript and pass
   * it here — otherwise every rebuild silently restarts turn numbering at 1,
   * and a fresh cross-process resume records the sentinel `0` instead of the
   * real turn. Omit when no transcript exists yet (first-ever turn).
   */
  initialTurn?: number;

  /**
   * Like `initialTurn`, but for the paused turn's step sequence: the highest
   * step number already persisted for that turn in the durable transcript.
   * Consumed only by resume()'s cross-process fallback, whose freshly built
   * Runner would otherwise restart its step counter at 1 and collide with
   * the paused turn's existing steps 1..N — a projection would then
   * merge/overwrite distinct model calls in the same turn.
   *
   * As with `initialTurn`, the SDK cannot recover this value on its own:
   * `SessionSnapshot` carries no step numbers and `TranscriptStore` is
   * write-only. A host that rebuilds agent instances mid-conversation must
   * compute it from its own transcript (the max `step` stamped on events of
   * the paused turn) and pass it here. Omit when no transcript exists yet,
   * or when the rebuilt agent starts a brand-new turn rather than resuming.
   */
  initialStep?: number;

  /** Model name override (sent to the provider) */
  model?: string;

  /**
   * 宿主路由的 provider 配置 id（如 "deepseek-official"），写进每条
   * assistant_message 的 source，供每轮用量卡片展示「提供方」。SDK 不理解
   * 它的取值，也不参与路由；不传则 source 里没有该键（spec 2026-09-26 §3.3）。
   */
  providerId?: string;

  /** Max tokens per model call */
  maxTokens?: number;

  /** Temperature */
  temperature?: number;

  /**
   * Adapter-owned reasoning effort id, forwarded verbatim to the ModelPort.
   * Distinct from `reasoningStrategy`, which only decides whether reasoning
   * deltas reach the EventSink.
   */
  reasoningEffort?: string;

  /** Max inner-loop iterations before runaway guard fires (default: 20) */
  maxIterations?: number;

  /** Token budget per turn (default: no limit) */
  tokenBudget?: number;

  /** Max tool calls per turn (default: no limit) */
  maxToolCalls?: number;

  /**
   * @deprecated Use `maxDollarsPerTurn` (with pricing) or `maxTokensPerTurn` (raw tokens) instead.
   * Max cumulative cost per turn — behavior depends on pricing config:
   * - With pricing: compared against dollar cost
   * - Without pricing: compared against raw token count
   */
  maxCostTokens?: number;

  /**
   * Max raw token count per turn (input + output tokens combined).
   * Independent of pricing — always compares against raw token sums.
   * Runner feeds budget_exceeded when exceeded (default: no limit).
   */
  maxTokensPerTurn?: number;

  /**
   * Max cumulative dollar cost per turn (requires pricing configuration).
   * Runner feeds budget_exceeded when exceeded (default: no limit).
   */
  maxDollarsPerTurn?: number;

  /** Max wallclock milliseconds per turn — Runner feeds budget_exceeded when exceeded (default: no limit) */
  maxWallclockMs?: number;

  /** Max consecutive identical failed tool calls before loop intervention (default: no limit) */
  maxLoopCount?: number;

  // ── Port overrides (all optional, defaults provided) ──

  /** Permission policy — defaults to sensible read/write/ask/deny */
  permissionConfig?: PermissionConfig;

  /** Session store for HITL checkpoint/resume */
  sessionStore?: SessionStore;

  /** Durable transcript/trajectory store. Optional — omitted means no durable record is kept (mirrors sessionStore's optionality). */
  chatStore?: TranscriptStore;

  /**
   * The chatStore's stable, whole-conversation session id — set once at
   * construction. Distinct from the SDK's internal per-turn `sessionId`
   * (used only for HITL checkpointing), which is regenerated every turn.
   */
  chatSessionId?: string;

  /** Config binding recorded once as a `session_meta` transcript event at construction, when both this and chatStore are provided. */
  chatMeta?: ChatSessionMeta;

  /**
   * Clock for timestamps on every transcript event this SDK layer touches:
   * `session_meta` and the failure `turn_end`/`error` events it writes
   * directly, and the `subagent_started`/`subagent_finished` bracket around
   * a task-tool invocation. Also forwarded to each Runner it constructs
   * (main turn and sub-agent) via `RunnerOptions.clock`, so a single
   * injected Clock produces deterministic timestamps across the whole
   * transcript. Defaults to wall-clock (Date.now) when omitted.
   */
  clock?: Clock;

  /**
   * Approval gate for HITL `ask` decisions. Defaults to auto-allow.
   * Hosts that need real user interaction should inject
   * `createInteractiveGate()` or their own implementation.
   */
  approvalGate?: ApprovalGate;

  /**
   * Approval gate for the `ask_user` tool specifically. Defaults to
   * auto-allow — do NOT default this to `approvalGate`.
   *
   * `ask_user` calls `ApprovalGate.ask()` directly, bypassing the Runner,
   * so no `request_approval` effect is ever produced and no
   * `approval_asked` transcript event is ever emitted (the Runner is the
   * only thing that emits it). A host's real HITL `approvalGate` needs a UI
   * wired to show an `ask_user` question and a way to settle it before it is
   * safe to reuse for this option — otherwise `ask_user` either hangs
   * forever with nothing visible to the user (a gate with no timeout, e.g.
   * the gateway's) or fabricates an answer with no human involved (an
   * auto-allow fallback). Only pass `approvalGate` here once the host's gate
   * genuinely surfaces the call's `args`/`riskTier` to a human and can
   * settle allow/deny for it — e.g. desktop-app's `ApprovalDialog`, which
   * already renders any `PendingToolCall` this way. Until a host builds that,
   * `ask_user` must keep resolving immediately as it did before HITL
   * approvals became real: do not "helpfully" wire the permission
   * `approvalGate` back in here without confirming the UI can display it.
   */
  askUserGate?: ApprovalGate;

  /**
   * Plan-mode artifact store (gateway-managed). Provided → the save_plan
   * tool is registered; it is the ONLY write surface inside plan mode
   * (workspace writes stay removed by the ceiling).
   */
  planStore?: PlanStore;

  /** Event sink for observability */
  eventSink?: EventSink;

  // ── Adapters — when provided, corresponding tools are auto-created ──

  /** File system adapter */
  fs?: FileSystem;

  /** Shell adapter */
  shell?: Shell;

  /**
   * Sandbox configuration for shell command isolation.
   * When provided, the shell is wrapped in a platform-specific sandbox
   * (macOS seatbelt / Linux bubblewrap) before being used by bash tools.
   * When absent, the shell is used as-is (backward-compatible).
   *
   * Also selects the persistent-session spawner: with sandboxConfig the
   * long-lived `bash -s` is confined by the same backend; without it the
   * session is a bare `bash -s` with default secret-env stripping.
   */
  sandboxConfig?: SandboxConfig;

  /**
   * Default working directory for the persistent bash session.
   * Defaults to `process.cwd()`. One-shot `shell.exec` (isolated bash,
   * background launch) is unaffected — each call carries its own cwd.
   */
  cwd?: string;

  /**
   * Override for the persistent-session spawn factory. Hosts rarely need
   * this; it exists so tests can observe session lifecycle (spawn count,
   * child kill) and so a host can supply a custom spawner (e.g. its own
   * env stripping or a pre-wrapped sandbox binary).
   *
   * Takes precedence over both sandboxConfig and the bare default.
   * `createAgent` still owns the session (lazy singleton, killed on dispose).
   */
  sessionSpawner?: (opts: { cwd: string }) => SessionSpawnHandle;

  /** Network adapter */
  network?: Network;

  /**
   * Optional egress policy for the Network port (web_fetch / web_search /
   * http_query). Exact-hostname matching, denylist wins; denied requests
   * answer with a structured 403 and never reach the adapter. The model's
   * own transport does not go through this port, and neither does anything
   * the bash tool launches — this policy governs the Network port only.
   * Absent → the network is used as-is.
   */
  egressPolicy?: EgressPolicy;

  /**
   * LSP manager — when provided, the five `lsp_*` code-intelligence tools are
   * auto-created and `lsp:query` is granted.
   *
   * The SDK consumes the contract type only (`LspClientProvider`), never a
   * runtime class: the host wires `createNodeLspManager(...)`, and the manager
   * additionally owns the subprocess lifetime, so it must also expose
   * `dispose()`. `createAgent` calls it on `agent.dispose()` — the manager is
   * session-scoped and must not outlive the agent that lent it out.
   */
  lsp?: LspClientProvider & { dispose(): Promise<void> };

  /** Browser adapter — when provided, browser/computer-use tools are auto-created */
  browserAdapter?: BrowserAdapter;

  /**
   * Database opener — when provided, `db_query` is auto-created and
   * `db:read` is granted.
   *
   * `allowWrite` is the host's decision (Task 9 derives it from the session's
   * sandbox mode: `sandboxMode !== "read-only"`). Only an explicit `true`
   * grants `db:write` and materializes `db_exec`; with `false` the tool is not
   * in the visible set at all, so the model is never offered a write it would
   * only be refused for using. The opener itself owns the workspace boundary
   * and the read-only engine semantics — the SDK only decides visibility.
   *
   * `closeAll()` is called on `agent.dispose()`, after every `open()` the
   * session issued has settled (the agent's turns are done by then), so no
   * handle is reaped out from under an in-flight request.
   */
  db?: { opener: DatabaseOpener; allowWrite: boolean };

  /** Document parser adapter — when provided, overrides the default node parser */
  documentParser?: DocumentParserAdapter;

  /**
   * Attachment store for image bytes. Images leave tools as AttachmentStore
   * refs; the Runner resolves those refs into base64 on the ModelRequest
   * surface just before calling the model, so durable state never carries
   * the bytes. When omitted, a node store rooted at `~/.volto/attachments`
   * is constructed (mkdir happens on first put, not at construction).
   */
  attachmentStore?: AttachmentStore;

  /**
   * Model image-input support, tri-state. Pass the value derived from
   * `modelPort.describeModel(model)?.input` (present without "image" → false,
   * ["text","image"] → true, absent → undefined) when the port can describe
   * its models.
   *
   * - absent (`undefined`): unknown — image tools are not gated and
   *   `CAP_MODEL_VISION` is not granted.
   * - `false`: image reads return isError at call time.
   * - `true`: `CAP_MODEL_VISION` is granted; image reads proceed.
   *
   * Never coerce absent to false: a gateway that cannot describe its models
   * must not silently lose the image path.
   */
  modelVision?: boolean;

  /** Available capabilities (auto-populated from injected adapters if not set) */
  capabilities?: Set<string>;

  /** Enable the task sub-agent tool */
  enableTaskTool?: boolean;

  /**
   * Agent definitions available as `subagent_type` values on the task tool.
   * Typically produced by `scanAgentSources()`; shadowed entries are ignored
   * for lookup (a later same-name definition wins).
   *
   * A typed dispatch intersects the definition's tools/capabilities with the
   * parent's and narrows (never widens) its policy — see `assembleSubAgent`.
   * The definition's body becomes the child's system prompt and its `model:`
   * overrides the parent's for that dispatch. Omitting this option keeps the
   * general-purpose sub-agent: every parent tool minus the parent-bound
   * `task` / `task_output` instances, plus a freshly bound `task` while the
   * child is below `maxAgentDepth`.
   */
  agentSpecs?: AgentEntry[];

  /**
   * Maximum delegation depth (default: 2). The main agent is depth 0, the
   * sub-agents it dispatches are depth 1, and so on. At
   * `depth >= maxAgentDepth` the delegation budget capability
   * (`agent:can-delegate`) is withheld, so `task` / `task_output` fall out
   * of that layer's visible tool set through the normal capability gate —
   * an agent at the limit never sees a tool it would only be refused for
   * using.
   */
  maxAgentDepth?: number;

  /**
   * Host-owned skill registry — enables progressive skill disclosure:
   * registers the model-facing `skill` loader tool (capability `skill:load`)
   * and appends a `skill-catalog` context layer (names + descriptions only)
   * after the host's own context layers each turn.
   */
  skillRegistry?: SkillRegistry;

  /**
   * Cap on each catalog entry's description length. Defaults to
   * DEFAULT_SKILL_CATALOG_DESCRIPTION_MAX_LENGTH (200); values below 16 are
   * clamped up. Only meaningful together with `skillRegistry`.
   */
  skillCatalogDescriptionMaxLength?: number;

  /**
   * Compaction config — enables automatic context compression when messages
   * grow large. Uses the default character-count tokenizer if not specified.
   */
  compaction?: Omit<CompactionConfig, "tokenizer"> & { tokenizer?: CompactionConfig["tokenizer"] };

  // ── M8: New port overrides (all optional, defaults provided) ──

  /**
   * Dynamic tool sources (MCP / plugins). Each source's tools are merged
   * into the visible tool set and are callable through the executor.
   * onChange triggers tool set refresh at turn boundaries.
   * Backward-compatible: the legacy single `toolSource` is used if
   * `toolSources` is not provided.
   */
  toolSources?: ToolSource[];

  /**
   * @deprecated Use `toolSources` instead. Kept for backward compatibility.
   * If `toolSources` is empty/undefined and `toolSource` is set, it is
   * wrapped into a single-element array.
   */
  toolSource?: ToolSource;

  /** Semantic / long-term memory store. Defaults to in-memory Map. */
  memoryStore?: MemoryStore;

  /** Text embedding provider. Defaults to throw-if-called. */
  embedder?: Embedder;

  /** Structured telemetry (OTel-style). Defaults to no-op. */
  telemetry?: Telemetry;

  /** General-purpose key/value cache. Defaults to in-memory with TTL. */
  cache?: Cache;

  /** Isolated execution environment. Defaults to throw-if-called. */
  sandbox?: Sandbox;

  /** Secure credential resolution. Defaults to returning undefined. */
  secrets?: Secrets;

  /** Timed / delayed / background tasks. Defaults to no-op. */
  scheduler?: Scheduler;

  /**
   * Event-triggered file watcher port. When set, `filesystem:watch` is added
   * to capabilities and `watch_files` / `unwatch_files` / `list_watches` are
   * registered. Hosts own the watcher lifetime and MUST call
   * `fileWatcher.dispose?.()` on session/process teardown — AgentInstance has
   * no dispose hook.
   */
  fileWatcher?: FileWatcher;

  /**
   * Auto-start a turn when idle on file_changed. Default true when
   * fileWatcher is set. When false, watch batches still reach
   * `onFileWatchEvents` but never start a turn.
   */
  fileWatchAutoWake?: boolean;

  /**
   * Host sink for every watch batch (UI toast / log). Optional. Called
   * before any auto-wake action; a throw here is swallowed so the host
   * callback cannot break the agent.
   */
  onFileWatchEvents?: (watchId: string, events: FileWatchEvent[]) => void;

  /** External authorization decision engine. Defaults to allow-all. */
  policyEngine?: PolicyEngine;

  /**
   * Identifier port — generates session IDs and any other agent-scoped
   * identifiers. Inject a deterministic implementation (seeded counter)
   * for replay equivalence; defaults to a counter + wallclock fallback.
   */
  id?: Id;

  /**
   * Structured audit sink for approval decisions and high-risk tool executions.
   * When provided, Runner records audit entries for HITL decisions and
   * WRITE_HIGH/IRREVERSIBLE tool executions. Defaults to no-op (entries discarded).
   */
  auditSink?: AuditSink;

  /**
   * Tool visibility trimming — after capability gating, trim the visible tool
   * set by scope group and/or hard limit (default: ~20). Applied at turn
   * boundaries so static prefix caching remains stable.
   * If omitted, no trimming beyond capability gating is applied.
   */
  toolVisibility?: {
    /** Scope-based group filtering config */
    scope?: ToolScopeConfig;
    /** Maximum number of visible tools (default: 20, applied even without scope) */
    limit?: number;
  };

  // ── M13: Lifecycle hooks ──

  /**
   * Lifecycle hooks — called at session:start/end, turn:start/end,
   * preToolUse (after permission, before executor), postToolUse (after result).
   * Merged with any hooks registered by plugins. Serial execution, first deny short-circuits.
   */
  hooks?: import("@volto/core").Hook[];

  // ── M13: Slash commands ──

  /**
   * Slash commands — when user input starts with `/name`, the command's
   * template is rendered and fed as the UserMessage instead of raw input.
   * Unknown commands produce a normalized prompt (no throw).
   */
  commands?: import("./commands.js").SlashCommand[];

  // ── M9: Model layer options ──

  /**
   * Pricing table for cost metering (keyed by "provider/model").
   * When provided, a CostMeter aggregates token/$ per turn and reports via
   * EventSink + Telemetry. Does NOT enforce any budget (M8 Phase 4 handles that).
   */
  pricing?: PricingTable;

  /**
   * Reasoning (thinking) EventSink forwarding strategy. Reasoning always
   * lands in message history, the transcript, and the conversation view
   * regardless of this setting — it only controls whether `reasoning_delta`
   * events reach the EventSink:
   * - "emit" (default): reasoning_delta events flow to EventSink (visible to UI)
   * - "record": same delta forwarding as "emit" (reserved for future divergence)
   * - "meter-only": reasoning_delta events are dropped from EventSink (not surfaced live)
   */
  reasoningStrategy?: "emit" | "record" | "meter-only";

  /**
   * Structured / JSON output mode. When set, the provider is instructed to
   * produce structured JSON output (OpenAI: response_format, Anthropic: system instruction).
   * Schema is passed as abstract JSONSchema — zod is NOT used in core.
   */
  responseFormat?: { type: "json"; schema?: JSONSchema };
}

export interface AgentInstance {
  /**
   * Run one turn to completion; returns the final state.
   *
   * Concurrency contract: one agent instance serves ONE turn at a time.
   * `run()` and `stream()` share mutable per-instance state (turn counter,
   * last runner, last final state — see the comment above `let lastRunner`
   * in create-agent.ts) with no lock or queue. Calling `run()`/`stream()`
   * again before a prior call on the same instance has settled is out of
   * contract — turn claim order and state hand-off are unspecified. Use a
   * separate `createAgent()` instance per concurrent conversation, or
   * serialize calls on the same instance.
   */
  run(input: string | AgentInput): Promise<ReducerState>;

  /**
   * Yield events as the runner processes the turn.
   *
   * Same single-turn-at-a-time contract as `run()` above.
   *
   * `opts.signal` lets a caller cancel the turn from the outside — aborting
   * it stops the runner exactly like breaking out of the `for await` does,
   * so the turn still closes with a `turn_end` carrying
   * `reason: "cancelled"` instead of being left open.
   */
  stream(
    input: string | AgentInput,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<{ type: string; data: Record<string, unknown> }>;

  /**
   * Resume a HITL-paused session.
   * Tries the in-memory runner first; falls back to loading from the session store.
   */
  resume(sessionId: string, decision: "allow" | "deny"): Promise<ReducerState>;

  /**
   * On-demand context compaction while the agent is idle.
   *
   * Delegates to the last Runner's `compactNow()`, which runs the same
   * prune + summarize + write-back path the automatic pre-request
   * compaction uses. Only valid when no turn is in flight
   * (status `idle` / `done`); a mid-turn call throws
   * `CompactionBusyError` (code `"busy"`). Returns `null` when there is
   * nothing useful to compact (no config, under threshold, or no
   * compressible messages). On success, `getState()` reflects the
   * compacted message list.
   */
  compactNow(): Promise<CompactNowResult | null>;

  /** Read the latest runner state */
  getState(): ReducerState;

  /**
   * Session store backing checkpoint/resume for this agent instance.
   * Checkpoints are saved under `<sessionId>#<seq>` (plus a canonical
   * `<sessionId>` key) at every turn boundary and HITL pause — hosts can
   * list / rewind them with @volto/sdk's createTimeTravelDebugger.
   */
  sessionStore: SessionStore;

  /**
   * Tool list assembled at construction (custom + adapter tools, including
   * the task / task_output tools when the task tool is enabled). Snapshot
   * for inspection — ToolSource tools merged later are not reflected here.
   */
  tools: Tool[];

  /**
   * Tear down agent-owned resources when the host ends the session.
   * Kills the agent-owned persistent bash session (when one was created),
   * then every managed background shell process via `Shell.disposeProcesses`
   * (when the shell implements it). Idempotent — a second call is a no-op.
   * Safe to call when no shell was configured — it resolves as a no-op.
   */
  dispose(): Promise<void>;

  /** Resolved M8 port instances (for advanced usage / testing) */
  ports: ResolvedPorts;
}

/** All resolved port instances held by this agent */
export interface ResolvedPorts {
  toolSource: ToolSource;
  memoryStore: MemoryStore;
  embedder: Embedder;
  telemetry: Telemetry;
  cache: Cache;
  sandbox: Sandbox;
  secrets: Secrets;
  scheduler: Scheduler;
  policyEngine: PolicyEngine;
  /**
   * The effective shell (sandbox-wrapped when sandboxConfig was provided).
   * Exposed so hosts can reuse the same instance for teardown / inspection.
   */
  shell?: Shell;
}

// ──────────────────────────────────────────────
// createAgent
// ──────────────────────────────────────────────

export function createAgent(opts: CreateAgentOptions): AgentInstance {
  const { modelPort } = opts;

  // ── Sandbox shell wrapping (Plan 009 §4.2) ──
  // Wrap the shell early so both tool creation and the tool executor use
  // the sandboxed version. danger-full-access / no-config → identity.
  const effectiveShell: Shell | undefined = opts.shell
    ? (opts.sandboxConfig ? createSandboxedShell(opts.shell, opts.sandboxConfig) : opts.shell)
    : undefined;

  // One egress policy wraps the Network port for every consumer — the web
  // tools and the network tool executor (the sub-agent's executor included).
  // Without a policy the adapter is used as-is; behavior is unchanged.
  const network: Network | undefined = opts.network
    ? (opts.egressPolicy ? wrapNetworkWithEgress(opts.network, opts.egressPolicy) : opts.network)
    : undefined;

  // ── Persistent bash session (B-2) ─────────
  // At most ONE long-lived session per createAgent instance. Lazily created
  // on the first non-isolated bash call; dispose() kills it before tearing
  // down background processes. The singleton IS the concurrency limit —
  // getSession never builds a second session, so there is no runtime
  // "limit exceeded" path to surface as isError.
  const sessionSpawner: ((opts: { cwd: string }) => SessionSpawnHandle) | undefined = (() => {
    if (!opts.shell) return undefined;
    if (opts.sessionSpawner) return opts.sessionSpawner;
    if (opts.sandboxConfig) {
      // May return undefined when a confining backend was selected but its
      // runner is missing under failIfUnavailable:false — never fall back
      // to a bare session that would silently run unconfined.
      return createSandboxSessionSpawner(opts.sandboxConfig);
    }
    return createSandboxSessionSpawner({
      mode: "danger-full-access",
      strippedEnvPatterns: [...DEFAULT_SESSION_SECRET_ENV_PATTERNS],
    });
  })();

  let shellSession: PersistentSession | undefined;
  let agentDisposed = false;

  function getSession(): BashSessionLike | undefined {
    // After dispose the agent is torn down — never resurrect a session.
    if (agentDisposed) return undefined;
    if (!sessionSpawner) return undefined;
    if (!shellSession) {
      shellSession = createPersistentSession({
        spawn: sessionSpawner,
        cwd: opts.cwd ?? process.cwd(),
        defaultTimeoutMs: SHELL_SESSION_DEFAULT_TIMEOUT_MS,
      });
    }
    return shellSession;
  }

  // ── Identifier port ───────────────────────
  // Use injected Id port for sessionId generation; deterministic replays
  // require a seeded Id (e.g. counter-based) — the default falls back to
  // counter + wallclock for uniqueness in real runs.
  const idPort: Id = opts.id ?? defaultId;

  // ── Resolve layered config defaults ─────────
  // Config layer values fill in defaults for opts not explicitly set.
  // Explicit opts always take highest priority (they ARE the runtime layer).
  const cfg = opts.config?.config;
  const resolve = <T>(explicit: T | undefined, key: keyof ConfigLayer): T | undefined =>
    resolveConfigValue(explicit, cfg, key);

  // ── Attachment store ─────────────────────
  // Images leave tools as refs; the Runner resolves them to base64 on the
  // request surface. Default is the node store under ~/.volto/attachments
  // (mkdir is deferred to the first put, so constructing it is side-effect
  // free). Tests inject a temp rootDir via opts.attachmentStore.
  // Deliberately does NOT consume idPort: P0-3 requires Id.next() to stay
  // at 0 until run(). The store's sessionId is a disk namespace, not the
  // agent's replay-critical sessionId.
  const attachmentStore: AttachmentStore =
    opts.attachmentStore ??
    createNodeAttachmentStore({
      sessionId: opts.chatSessionId ?? "default",
    });

  // ── Document parser (default-enabled) ────
  // An unwired tool is an absent capability: read_document ships enabled and
  // a missing format library degrades to that call's isError instead of
  // hiding the tool. The lazy adapter keeps createAgent synchronous.
  const documentParser: DocumentParserAdapter =
    opts.documentParser ?? createLazyNodeDocumentParser();

  // ── Resolve capabilities ──────────────────
  // Config layer capabilities (string[]) merged with explicit opts.capabilities (Set)
  const configCaps = cfg?.capabilities;
  const capabilities = opts.capabilities ?? new Set<string>(configCaps);
  if (opts.fs) {
    capabilities.add("filesystem:read");
    capabilities.add("filesystem:write");
  }
  if (opts.shell) {
    capabilities.add("shell:exec");
  }
  if (network) {
    capabilities.add("network:fetch");
  }
  if (opts.lsp) {
    capabilities.add(CAP_LSP_QUERY);
  }
  if (opts.browserAdapter) {
    capabilities.add("browser:control");
  }
  if (opts.db) {
    // Read is unconditional once an opener exists; write only when the host
    // explicitly allows it. Splitting the grant (rather than granting both and
    // refusing at call time) is what keeps `db_exec` out of the visible set
    // entirely under a read-only session.
    capabilities.add(CAP_DB_READ);
    if (opts.db.allowWrite === true) {
      capabilities.add(CAP_DB_WRITE);
    }
  }
  // read_document always ships now — grant the capability unconditionally.
  capabilities.add("document:parse");
  // Tri-state: only an explicit true grants vision. Absent stays unknown so
  // a gateway that cannot describe its models does not lose pure image
  // producers; mixed tools (read_file / read_document) gate at call time.
  if (opts.modelVision === true) {
    capabilities.add(CAP_MODEL_VISION);
  }
  if (resolve(opts.enableTaskTool, "enableTaskTool")) {
    capabilities.add("agent:task");
  }
  // Delegation budget: the main agent is depth 0, so it holds the budget
  // while the configured cap is above zero (default 2). Without it the
  // task tools' requires gate hides them from the visible set.
  if (0 < (opts.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH)) {
    capabilities.add(CAP_AGENT_DEPTH_AVAILABLE);
  }
  if (opts.skillRegistry) {
    capabilities.add("skill:load");
  }

  // ── Build adapter tools ──────────────────
  const adapterTools: Tool[] = [];
  if (opts.fs) {
    adapterTools.push(
      createReadFileTool(opts.fs, {
        attachments: attachmentStore,
        visionSupported: opts.modelVision,
        // `.pdf` dispatch: without a parser read_file refuses the file
        // (isError) instead of dumping utf-8 mojibake. The same default-on
        // parser read_document gets — real sessions always have one.
        documentParser,
      }),
      createEditFileTool(opts.fs),
      createWriteFileTool(opts.fs),
      createApplyPatchTool(opts.fs),
      createMultiEditTool(opts.fs),
      createLsTool(opts.fs),
      createGlobTool(opts.fs),
      createGrepTool(opts.fs),
    );
  }
  if (opts.shell) {
    adapterTools.push(
      createBashTool(effectiveShell!, { getSession }),
      createBashOutputTool(effectiveShell!),
      createKillShellTool(effectiveShell!),
    );
    adapterTools.push(
      createGitStatusTool(effectiveShell!),
      createGitDiffTool(effectiveShell!),
      createGitCommitTool(effectiveShell!),
      createGitPushTool(effectiveShell!),
      createRunTestsTool(effectiveShell!),
      createBuildTool(effectiveShell!),
    );
  }
  if (network) {
    adapterTools.push(createWebFetchTool(network), createWebSearchTool(network));
    adapterTools.push(createHttpQueryTool(network));
  }
  if (opts.lsp) {
    adapterTools.push(
      createLspDefinitionTool(opts.lsp),
      createLspReferencesTool(opts.lsp),
      createLspRenameTool(opts.lsp),
      createLspDiagnosticsTool(opts.lsp),
      createLspHoverTool(opts.lsp),
    );
  }
  if (opts.browserAdapter) {
    adapterTools.push(
      createBrowserNavigateTool(opts.browserAdapter),
      createBrowserClickTool(opts.browserAdapter),
      createBrowserTypeTool(opts.browserAdapter),
      createBrowserScreenshotTool(opts.browserAdapter),
      createBrowserGetPageTextTool(opts.browserAdapter),
    );
  }
  if (opts.db) {
    adapterTools.push(createDbQueryTool(opts.db.opener));
    // Only an explicit allowWrite materializes the write tool. Registering it
    // and letting the `db:write` gate hide it would be equivalent for the
    // visible set, but keeping it unregistered means a configuration mistake
    // cannot surface a write tool through some other path.
    if (opts.db.allowWrite === true) {
      adapterTools.push(createDbExecTool(opts.db.opener));
    }
  }
  // read_document always ships — the default lazy node parser degrades
  // per format (missing library → that call's isError) instead of hiding
  // the tool behind an opt-in adapter the host may never learn about.
  // The default parser uses raw fs, so constrain paths to the workspace
  // via the FileSystem port (same boundary read_file enforces). Hosts that
  // bring their own documentParser keep the existing unrooted contract.
  adapterTools.push(
    createReadDocumentTool(documentParser, {
      attachments: attachmentStore,
      visionSupported: opts.modelVision,
      ...(opts.documentParser ? {} : { fs: opts.fs }),
    }),
  );
  if (opts.scheduler) {
    capabilities.add("scheduler:exec");
    adapterTools.push(
      createScheduleTool(opts.scheduler),
      createCancelScheduleTool(opts.scheduler),
    );
  }

  // ── File watcher wiring state ──────────────
  // Tools themselves are registered after allCustomTools is declared (they
  // are FileWatcher-backed, not FileSystem-backed — see
  // FS_EXECUTOR_TOOL_NAMES in tools-fs).
  let fileWatchAutoWake = false;
  const pendingFileInputs: AgentInput[] = [];
  let drainScheduled = false;
  // Late-bound public run — the wrap is built before the AgentInstance
  // object exists, so the handler closes over this cell instead.
  let agentRun: ((input: string | AgentInput) => Promise<ReducerState>) | null = null;

  function drainPendingFileInputs(): void {
    if (drainScheduled) return;
    const next = pendingFileInputs.shift();
    if (!next) return;
    drainScheduled = true;
    // After the current turn settles (run/stream finally already flipped
    // turnInFlight), start the next auto-wake turn. queueMicrotask keeps
    // this off the synchronous finally path.
    queueMicrotask(() => {
      drainScheduled = false;
      if (turnInFlight) {
        // Still busy (should not happen — finally drains) — requeue and
        // wait for the next settle rather than starting a concurrent runner.
        pendingFileInputs.unshift(next);
        return;
      }
      void runAutoWake(next);
    });
  }

  function emitAutoWakeError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      (opts.eventSink ?? defaultEventSink).emit({
        type: "error",
        data: { error: message },
      });
    } catch {
      // EventSink must never turn an auto-wake failure into an unhandled throw.
    }
  }

  async function runAutoWake(input: AgentInput): Promise<void> {
    if (!agentRun) return;
    try {
      await agentRun(input);
    } catch (err) {
      emitAutoWakeError(err);
    }
  }

  function handleFileWatchBatch(watchId: string, events: FileWatchEvent[]): void {
    try {
      opts.onFileWatchEvents?.(watchId, events);
    } catch {
      // Host callback must not break the agent or the watcher.
    }
    if (!fileWatchAutoWake) return;
    const input: AgentInput = { type: "file_changed", watchId, events };
    if (turnInFlight) {
      pendingFileInputs.push(input);
      return;
    }
    void runAutoWake(input);
  }

  if (opts.fileWatcher) {
    fileWatchAutoWake = opts.fileWatchAutoWake !== false;
    capabilities.add(CAP_FS_WATCH);
  }

  // ── Compaction config ─────────────────────
  const resolvedCompaction = resolve(opts.compaction, "compaction") as
    (Omit<CompactionConfig, "tokenizer"> & { tokenizer?: CompactionConfig["tokenizer"] }) | undefined;
  const compactionConfig: CompactionConfig | undefined = resolvedCompaction
    ? { ...resolvedCompaction, tokenizer: resolvedCompaction.tokenizer ?? defaultTokenizer }
    : undefined;

  // ── Assemble all tools ────────────────────
  // Collect plugins first — their tools are merged into the custom tool set
  const pluginData: CollectedPlugins = opts.plugins && opts.plugins.length > 0
    ? collectPlugins(opts.plugins)
    : { tools: [], providers: new Map(), hooks: [], commands: [], skills: [], agentSpecs: [] };

  const allCustomTools: Tool[] = [...(opts.tools ?? []), ...pluginData.tools];

  if (opts.fileWatcher) {
    // customToolMap (not adapterTools / fsExecutor): these tools call the
    // FileWatcher port, not FileSystem — FS_EXECUTOR_TOOL_NAMES does not
    // list them, so toolExecutor below routes via customToolMap.
    const wrappedWatcher = wrapFileWatcher(opts.fileWatcher, handleFileWatchBatch);
    allCustomTools.push(
      createWatchFilesTool(wrappedWatcher),
      createUnwatchFilesTool(wrappedWatcher),
      createListWatchesTool(wrappedWatcher),
    );
  }

  // ask_user tool — always available. Defaults to auto-allow rather than
  // falling back to the shared permission approvalGate: see the
  // `askUserGate` option doc comment above for why that default would hang
  // the turn forever (or worse, silently fabricate an answer) unless a host
  // opts in with a gate whose UI can actually display the question.
  const resolvedAskUserGate = opts.askUserGate ?? createAutoAllowGate();
  const resolvedEventSink = opts.eventSink ?? defaultEventSink;
  allCustomTools.push(
    createAskUserTool({ approvalGate: resolvedAskUserGate, eventSink: resolvedEventSink, id: idPort }),
  );

  if (opts.planStore) {
    const planStore = opts.planStore;
    adapterTools.push({
      definition: {
        name: "save_plan",
        description:
          "Save the current plan document (markdown) to volto's storage. " +
          "One plan per session; saving again overwrites it. Available in plan mode.",
        inputSchema: {
          type: "object",
          properties: { content: { type: "string", description: "Full plan document in markdown" } },
          required: ["content"],
        },
        requires: [],
        riskTier: "READ_ONLY",
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const content = String(input["content"] ?? "");
        await planStore.save(opts.chatSessionId ?? "default", opts.cwd ?? process.cwd(), content);
        return {
          modelContent:
            "PLAN_SAVED\n计划已保存到 volto 存储，用户可在计划面板查看。请简短总结计划要点并等待用户批准。",
        };
      },
    });
  }

  // Standing todos: pure state tool (no ports). Capability-gated by plan:write.
  capabilities.add(CAP_PLAN_WRITE);
  allCustomTools.push(createTodoWriteTool());

  // Registry of detached background tasks for this agent instance.
  // Promises live here, never in AgentState (not serializable). Declared
  // outside the enableTaskTool block so every Runner this agent creates
  // can receive it for turn-boundary draining (undefined = no drain).
  let backgroundRegistry: BackgroundRegistry | undefined;

  if (opts.enableTaskTool) {
    const agentSpecs = withPluginAgentSpecs(opts.agentSpecs ?? [], pluginData.agentSpecs);
    const executor = createSubAgentExecutor(
      // The sub-agent inherits the parent's egress-wrapped network — a raw
      // opts pass-through would let a dispatched child bypass the policy.
      { ...opts, network },
      allCustomTools,
      adapterTools,
      capabilities,
      attachmentStore,
      compactionConfig,
      1,
      effectiveShell,
      idPort,
      () => currentTurnEventSink,
      opts.chatStore,
      opts.chatSessionId,
      () => turnCounter,
      agentSpecs,
      getSession,
    );
    // Assign into the outer binding so createNextRunner's runnerOpts can
    // hand the registry to each Runner for turn-boundary draining.
    const registry = createBackgroundRegistry();
    backgroundRegistry = registry;
    const dispatch: SubAgentDispatch = async ({ message, subagentType, background }) => {
      if (background) {
        const taskId = idPort.next();
        // Fire the executor detached; the registry normalizes a rejection so
        // an uncollected failure can never surface as an unhandled rejection
        // or take the parent loop down.
        registry.register(
          taskId,
          executor({ message, subagentType }).then((outcome) => outcome.text),
        );
        // Record the task in serializable state so a checkpoint/resume can
        // discover it. Mid-turn feed is safe: the background_task_started
        // handler is status-independent and emits no effects.
        lastRunner?.send({
          type: "background_task_started",
          taskId,
          ...(subagentType !== undefined ? { subagentType } : {}),
        });
        return { taskId };
      }
      // A synchronous dispatch still gets its own id: "sync" collided across
      // every dispatch in a session, so a UI could not tell two apart.
      const outcome = await executor({ message, subagentType });
      return {
        taskId: idPort.next(),
        text: outcome.text,
        ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
      };
    };
    allCustomTools.push(
      createTaskTool(dispatch, { types: toAgentTypeSummaries(agentSpecs) }),
    );
    // task_output collects a previously dispatched background task; the
    // registry's collect is idempotent and normalizes unknown ids to errors.
    allCustomTools.push(createTaskOutputTool((taskId) => registry.collect(taskId)));
  }
  if (opts.skillRegistry) {
    // Local const so the narrowing survives inside the loader callback.
    const skillRegistry = opts.skillRegistry;
    allCustomTools.push(createSkillTool((name) => skillRegistry.load(name)));
  }

  // ── Resolve ToolSources (backward-compat: single toolSource → array) ──
  const resolvedToolSources: ToolSource[] = (() => {
    if (opts.toolSources && opts.toolSources.length > 0) return opts.toolSources;
    if (opts.toolSource && opts.toolSource !== defaultToolSource) return [opts.toolSource];
    return [];
  })();

  // Merge ToolSource tools into customToolMap so the executor can route them.
  // We store a marker to identify source-backed tools for onChange refresh.
  const sourceToolHandlers = new Map<string, (input: Record<string, unknown>) => Promise<ToolResult>>();
  const _sourceUnsubscribers: Array<() => void> = [];

  // Synchronous initial merge — for async sources, callers should call
  // refreshToolSources() before the first turn or use a connectAll() preamble.
  // For MCP, McpToolSource.list() is async; the caller connects servers
  // and the SDK calls list() lazily on first run/stream.
  let _toolSourcesInitialized = false;

  async function initToolSources(): Promise<void> {
    if (_toolSourcesInitialized) return;
    _toolSourcesInitialized = true;
    await refreshToolSources();
    // Subscribe to changes — debounced to turn boundary
    let _pendingRefresh = false;
    for (const source of resolvedToolSources) {
      if (source.onChange) {
        const unsub = source.onChange(() => {
          if (!_pendingRefresh) {
            _pendingRefresh = true;
            // Schedule refresh for next microtask (debounce multiple rapid changes)
            Promise.resolve().then(async () => {
              await refreshToolSources();
              _pendingRefresh = false;
            });
          }
        });
        _sourceUnsubscribers.push(unsub);
      }
    }
  }

  async function refreshToolSources(): Promise<void> {
    // Clear previous source tools from customToolMap
    for (const [name] of sourceToolHandlers) {
      customToolMap.delete(name);
    }
    sourceToolHandlers.clear();

    // Discover tools from all sources
    const sourceDefs: ToolDefinition[] = [];
    for (const source of resolvedToolSources) {
      let defs: ToolDefinition[];
      try {
        defs = await source.list();
      } catch {
        continue; // Source failed — skip silently
      }
      for (const def of defs) {
        sourceDefs.push(def);
        // Create a Tool with handler that routes back through the source
        const tool: Tool = {
          definition: def,
          handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
            // Route through source's callTool if available (McpToolSource pattern)
            const src = source as unknown as Record<string, unknown>;
            if (typeof src.callTool === "function") {
              return (src.callTool as (name: string, input: Record<string, unknown>) => Promise<ToolResult>)(def.name, input);
            }
            return { modelContent: `ToolSource does not support callTool: ${def.name}`, isError: true };
          },
        };
        customToolMap.set(def.name, tool);
        sourceToolHandlers.set(def.name, tool.handler);
      }
    }

    // Rebuild stepContext.tools: base tools + source tools (for ContextAssembler)
    toolDefs.length = 0;
    for (const t of [...allCustomTools, ...adapterTools]) {
      toolDefs.push(t.definition);
    }
    toolDefs.push(...sourceDefs);

    // Apply scope/limit trimming after merging source tools
    if (toolDefs.length > visibilityLimit || visibilityScope) {
      const trimmed = filterByScope(toolDefs, visibilityScope, visibilityLimit);
      toolDefs.length = 0;
      toolDefs.push(...trimmed);
    }
  }

  const allTools = [...allCustomTools, ...adapterTools];
  const toolDefs: ToolDefinition[] = [...allTools.map((t) => t.definition)];

  // Apply scope/limit trimming to initial tool set
  // When toolVisibility is not provided, default to no limit (Infinity)
  // to preserve backward compatibility with pre-M10 behavior.
  const resolvedVisibility = resolve(opts.toolVisibility, "toolVisibility") as
    { scope?: ToolScopeConfig; limit?: number } | undefined;
  const visibilityLimit = resolvedVisibility?.limit ?? (resolvedVisibility ? 20 : Infinity);
  const visibilityScope = resolvedVisibility?.scope ?? null;
  if (toolDefs.length > visibilityLimit || visibilityScope) {
    const trimmed = filterByScope(toolDefs, visibilityScope, visibilityLimit);
    toolDefs.length = 0;
    toolDefs.push(...trimmed);
  }

  // ── Permission config ─────────────────────
  const permissionConfig = resolve(opts.permissionConfig, "permissionConfig") ?? createDefaultPermissionConfig();
  // The sandbox mode fixes the highest risk tier the session may reach at
  // all. Passed to every Runner as `riskCeiling` so above-ceiling tools are
  // pruned from the model's visible set (filterVisibleTools) instead of only
  // being refused after the model tries them.
  const riskCeiling = ceilingOf(permissionConfig.sandbox);

  // ── Step context ─────────────────────────
  const resolvedReasoningEffort = resolve(opts.reasoningEffort, "reasoningEffort");
  const stepContext: StepContext = {
    tools: toolDefs,
    model: resolve(opts.model, "model"),
    ...(opts.providerId !== undefined ? { providerId: opts.providerId } : {}),
    maxTokens: resolve(opts.maxTokens, "maxTokens"),
    temperature: resolve(opts.temperature, "temperature"),
    maxLoopCount: resolve(opts.maxLoopCount, "maxLoopCount"),
    responseFormat: resolve(opts.responseFormat, "responseFormat"),
    permissionConfig,
    id: idPort,
    ...(opts.workflowReminder ? { workflowReminder: opts.workflowReminder } : {}),
    // Stamps BackgroundTask.startedAt via the reducer's ctx.clock — same
    // injected Clock the Runner uses, so replay stays deterministic.
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(resolvedReasoningEffort !== undefined
      ? { reasoningEffort: ReasoningEffortId(resolvedReasoningEffort) }
      : {}),
  };

  // ── Compose tool executor ────────────────
  const customToolMap = new Map<string, Tool>();
  for (const t of allCustomTools) {
    customToolMap.set(t.definition.name, t);
  }

  // Specialized executors own the fs/shell/network name sets; everything else
  // routes through customToolMap. Adapter tools that are not covered by those
  // three (read_document, lsp, browser, db, scheduler, …) must land in the
  // map or the model sees a callable definition and gets "Unknown tool".
  for (const t of adapterTools) {
    if (!customToolMap.has(t.definition.name)) {
      customToolMap.set(t.definition.name, t);
    }
  }

  const fsExecutor = opts.fs
    ? createFsToolExecutor({
        fs: opts.fs,
        attachments: attachmentStore,
        visionSupported: opts.modelVision,
        documentParser,
      })
    : undefined;
  const shellExecutor = effectiveShell
    ? createShellToolExecutor({ shell: effectiveShell, getSession })
    : undefined;
  const networkExecutor = network ? createNetworkToolExecutor({ network }) : undefined;

  const toolExecutor: ToolExecutor = async (
    call: PendingToolCall,
    ctx: { readFiles: ReadFileRecord[]; abortSignal?: AbortSignal },
  ): Promise<ToolResult> => {
    if (fsExecutor && FS_EXECUTOR_TOOL_NAMES.has(call.name)) {
      return fsExecutor(call, ctx);
    }
    if (shellExecutor && SHELL_TOOL_NAMES.has(call.name)) return shellExecutor(call, ctx);
    if (networkExecutor && NETWORK_TOOL_NAMES.has(call.name)) return networkExecutor(call, ctx);
    const tool = customToolMap.get(call.name);
    if (!tool) return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    return tool.handler(call.input);
  };

  // ── Approval gate ──────────────────────────
  const approvalGate = opts.approvalGate ?? createAutoAllowGate();

  // ── Session store ─────────────────────────
  const sessionStore = opts.sessionStore ?? createDefaultSessionStore();
  const chatStore = opts.chatStore ?? defaultChatStore;
  if (opts.chatStore && opts.chatMeta && opts.chatSessionId) {
    bestEffortAppend(chatStore, opts.chatSessionId, [
      {
        time: opts.clock?.now() ?? Date.now(),
        type: "session_meta",
        data: opts.chatMeta,
      },
    ]);
  }

  // ── M8: Resolve new ports ────────────────
  const resolvedPorts: ResolvedPorts = {
    toolSource: opts.toolSource ?? defaultToolSource,
    memoryStore: opts.memoryStore ?? createDefaultMemoryStore(),
    embedder: opts.embedder ?? defaultEmbedder,
    telemetry: opts.telemetry ?? defaultTelemetry,
    cache: opts.cache ?? createDefaultCache(),
    sandbox: opts.sandbox ?? defaultSandbox,
    secrets: opts.secrets ?? defaultSecrets,
    scheduler: opts.scheduler ?? defaultScheduler,
    policyEngine: opts.policyEngine ?? defaultPolicyEngine,
    ...(effectiveShell ? { shell: effectiveShell } : {}),
  };

  // ── Build initial messages (system prompt) ──
  const resolvedSystemPrompt = resolve(opts.systemPrompt, "systemPrompt");
  const seedMessages: Message[] = [];
  if (resolvedSystemPrompt) {
    seedMessages.push({ id: idPort.next(), role: "system", content: resolvedSystemPrompt });
  }
  if (opts.initialMessages && opts.initialMessages.length > 0) {
    seedMessages.push(...opts.initialMessages);
  }

  // ── M9: Cost meter (created per-run via wrapping EventSink) ──
  const costMeter = opts.pricing
    ? createCostMeter({ pricing: opts.pricing, eventSink: opts.eventSink ?? defaultEventSink, telemetry: resolvedPorts.telemetry })
    : null;

  // ── Public API ────────────────────────────

  // Concurrency contract: one createAgent() instance serves ONE turn at a
  // time. `lastRunner`, `lastFinalState`, `turnCounter`, and
  // `currentTurnEventSink` below are mutable state shared across every call
  // to `run()`/`stream()` on this instance, with no lock or queue guarding
  // them. `run()`/`stream()` calling `resolveInput()` then `createNextRunner()`
  // is not an atomic section: `createNextRunner()` increments `turnCounter`
  // synchronously (the "turn claim", see the comment there) but only reads
  // `lastFinalState` and resets `lastRunner`/`lastFinalState` to null *after*
  // awaiting `opts.resolveContextLayers()` and `appendSkillCatalogLayer()`
  // (which itself awaits `opts.skillRegistry.list()`) — both were already
  // async and already sat inside this span before this file ever had a
  // `resolveInput()` (see commits 53e9e48 and 50d1140). So two overlapping,
  // un-awaited `run()`/`stream()` calls on the same instance could already
  // interleave turn claims and state hand-off out of issue order whenever a
  // host configured `resolveContextLayers` or `skillRegistry` — this is a
  // pre-existing lack of guard, not something introduced by any one call's
  // async shape. Overlapping calls on one instance are simply out of
  // contract; a host that needs concurrent conversations must use separate
  // `createAgent()` instances, or serialize calls on the same one.
  let lastRunner: Runner | null = null;
  let lastFinalState: ReducerState | null = null;
  /**
   * True while a turn claimed via run()/stream() (or an auto-wake turn) is
   * still in flight. File-watch batches arriving during a turn are queued and
   * drained after settle so auto-wake never starts a concurrent runner.
   */
  let turnInFlight = false;
  // Most recently resolved per-turn contextLayers, cached for resume()'s
  // fallback branch (see below). Only covers same-process resume
  // (lastRunner.resume() throwing but the agent instance still alive) — a
  // resume in a fresh process after this one exits has no prior turn's
  // resolved layers to fall back on.
  let lastTurnContextLayers: ContextLayer[] | undefined;
  // Incremented once per createNextRunner() call — every new turn this
  // instance runs, whether via run() or stream(). Not incremented by
  // resume(), which continues the same turn rather than starting a new one.
  // Seeded from `initialTurn` (the last turn already in the transcript) so a
  // rebuilt agent instance continues numbering instead of restarting at 1 —
  // see CreateAgentOptions.initialTurn.
  let turnCounter = opts.initialTurn ?? 0;
  // The EventSink actually in use for the turn currently running — read by
  // createSubAgentExecutor at call time, since the task tool is built once
  // at construction but each turn's real sink (channel.eventSink for
  // stream(), or whatever run() was given) is only known per-call.
  let currentTurnEventSink: EventSink | undefined;

  /**
   * Appends the skill-catalog context layer (names + descriptions only) after
   * the host's own layers for this turn. No registry → layers pass through
   * unchanged; a registry with zero model-invocable skills also passes
   * through (an empty catalog layer would only spend tokens).
   */
  async function appendSkillCatalogLayer(
    hostLayers: ContextLayer[] | undefined,
  ): Promise<ContextLayer[] | undefined> {
    const catalogLayer = await buildSkillCatalogLayer(opts.skillRegistry, opts.skillCatalogDescriptionMaxLength);
    if (!catalogLayer) return hostLayers;
    return hostLayers === undefined ? [catalogLayer] : [...hostLayers, catalogLayer];
  }

  async function createNextRunner(
    runnerEventSink: EventSink,
    abortSignal: AbortSignal | undefined,
    inputText: string,
  ): Promise<Runner> {
    // Wrap EventSink to intercept usage events for cost metering
    // and filter reasoning_delta based on reasoningStrategy.
    const reasoningStrategy = resolve(opts.reasoningStrategy, "reasoningStrategy") ?? "emit";
    const effectiveSink: EventSink = (costMeter || reasoningStrategy !== "emit")
      ? {
          emit(event) {
            // Filter reasoning_delta based on strategy
            if (event.type === "reasoning_delta" && reasoningStrategy === "meter-only") {
              // Meter-only: drop reasoning events from the consumer-facing stream
              return;
            }

            // Cost metering: the Runner no longer emits raw model_done events
            // (task-r6) — usage rides on the transcript assistant_message it
            // records and streams, so that is what the meter intercepts.
            if (event.type === "assistant_message" && costMeter) {
              const usage = event.data.usage as { inputTokens?: number; outputTokens?: number } | undefined;
              if (usage) {
                costMeter.record({
                  type: "usage",
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                });
              }
            }

            runnerEventSink.emit(event);
          },
        }
      : runnerEventSink;

    currentTurnEventSink = effectiveSink;

    // M13: Merge hooks from opts + plugins (plugin hooks appended after opts hooks)
    const allHooks: import("@volto/core").Hook[] = [
      ...(opts.hooks ?? []),
      ...pluginData.hooks.map((ph) => ({
        name: ph.name,
        lifecycle: ph.lifecycle,
        handler: ph.handler,
      })),
    ];

    // Incremented before resolveContextLayers runs — a turn is "claimed" the
    // moment createNextRunner() is invoked, regardless of whether it goes on
    // to construct a Runner. If this were incremented only after
    // resolveContextLayers resolves, a rejection there would leave
    // turnCounter pointing at the *previous* turn, so a caught failure would
    // misattribute its turn_end to the last successful turn instead of this
    // one (and a first-turn failure would record turn 0).
    turnCounter++;
    // History-derived hints: structured fs paths touched so far. After a
    // rebuild (fresh process) lastFinalState is null — seedMessages already
    // carries the rebuilt history, so discovery survives cross-process resume.
    const hintsSource: Message[] = lastFinalState?.messages ?? seedMessages;
    const hints: ContextLayerHints = { touchedPaths: extractTouchedToolPaths(hintsSource) };
    const hostLayers = opts.resolveContextLayers
      ? await opts.resolveContextLayers(inputText, hints)
      : undefined;
    const catalogedLayers = await appendSkillCatalogLayer(hostLayers);
    const turnStepContext: StepContext =
      catalogedLayers !== undefined ? { ...stepContext, contextLayers: catalogedLayers } : stepContext;
    lastTurnContextLayers = turnStepContext.contextLayers;

    // Reset only after resolveContextLayers has succeeded — if it rejects,
    // lastRunner/lastFinalState must remain untouched so a subsequent retry
    // still carries forward the prior turn's state instead of silently
    // starting a fresh conversation.
    const previousState = lastFinalState;
    lastRunner = null;
    lastFinalState = null;

    const runnerOpts: RunnerOptions = {
      modelPort,
      stepContext: turnStepContext,
      eventSink: effectiveSink,
      toolExecutor,
      availableCapabilities: capabilities,
      permissionConfig,
      riskCeiling,
      approvalGate,
      sessionStore,
      compaction: compactionConfig,
      abortSignal,
      sessionId: `session-${idPort.next()}`,
      chatStore: opts.chatStore ? chatStore : undefined,
      chatSessionId: opts.chatSessionId,
      turn: turnCounter,
      // Header-only visibility for the seed system prompt (see RunnerOptions.
      // seedSystemPrompt): the seed message path already puts it in the model
      // request, mirroring it as a context layer would duplicate it there.
      // Same truthiness gate as the seed message above — an empty prompt
      // produces neither.
      ...(resolvedSystemPrompt ? { seedSystemPrompt: resolvedSystemPrompt } : {}),
      clock: opts.clock,
      policyEngine: resolvedPorts.policyEngine,
      telemetry: resolvedPorts.telemetry,
      pricing: opts.pricing,
      auditSink: opts.auditSink ?? defaultAuditSink,
      hooks: allHooks.length > 0 ? allHooks : undefined,
      // State keeps AttachmentStore refs; the Runner swaps them for base64
      // on the ModelRequest surface just before calling the model.
      attachmentStore,
      // Turn-boundary drain: lets the Runner collect background tasks the
      // model never picked up via task_output before the turn ends.
      backgroundRegistry,
      pathRoot: opts.cwd ?? process.cwd(),
    };

    if (previousState && previousState.status === "done") {
      // Carry forward conversation history. resetTurnForNextInput() is the
      // public core helper that handles clearing turn-scoped accumulator
      // fields (including reducer-private ones) without leaking internals.
      return createRunner({
        ...runnerOpts,
        initialState: resetTurnForNextInput(previousState),
      });
    }

    // First turn: apply systemPrompt + maxIterations + tokenBudget + M8 limits
    const resolvedMaxIterations = resolve(opts.maxIterations, "maxIterations");
    const resolvedTokenBudget = resolve(opts.tokenBudget, "tokenBudget");
    const resolvedMaxToolCalls = resolve(opts.maxToolCalls, "maxToolCalls");
    const resolvedMaxCostTokens = resolve(opts.maxCostTokens, "maxCostTokens");
    const resolvedMaxTokensPerTurn = resolve(opts.maxTokensPerTurn, "maxTokensPerTurn");
    const resolvedMaxDollarsPerTurn = resolve(opts.maxDollarsPerTurn, "maxDollarsPerTurn");
    const resolvedMaxWallclockMs = resolve(opts.maxWallclockMs, "maxWallclockMs");
    // P2-11: maxCostTokens is deprecated; new fields take precedence
    const effectiveMaxCostDollars = resolvedMaxDollarsPerTurn ?? resolvedMaxCostTokens;
    const initStateOverrides: Partial<ReducerState> = {
      ...(resolvedMaxIterations !== undefined ? { maxIterations: resolvedMaxIterations } : {}),
      ...(resolvedTokenBudget !== undefined ? { tokenBudget: resolvedTokenBudget } : {}),
      ...(resolvedMaxToolCalls !== undefined ? { maxToolCalls: resolvedMaxToolCalls } : {}),
      ...(effectiveMaxCostDollars !== undefined ? { maxCostDollars: effectiveMaxCostDollars } : {}),
      ...(resolvedMaxTokensPerTurn !== undefined ? { maxTokensPerTurn: resolvedMaxTokensPerTurn } : {}),
      ...(resolvedMaxWallclockMs !== undefined ? { maxWallclockMs: resolvedMaxWallclockMs } : {}),
      ...(seedMessages.length > 0 ? { messages: [...seedMessages] } : {}),
      ...(opts.initialAnnouncedWorkflowMode !== undefined
        ? { _announcedWorkflowMode: opts.initialAnnouncedWorkflowMode }
        : {}),
    };
    const initState = createInitialState(
      Object.keys(initStateOverrides).length > 0 ? initStateOverrides : undefined,
    );

    return createRunner({
      ...runnerOpts,
      initialState: initState,
    });
  }

  /**
   * Best-effort: records a `turn_end` (reason: "error") directly via chatStore
   * for a turn that fails before a Runner ever existed (e.g.
   * resolveContextLayers rejected). This is the *only* recording point for
   * that case — a Runner that never ran can't record its own turn_end. Never
   * throws into the caller.
   */
  function recordTurnEndError(error: unknown): void {
    if (!opts.chatStore || !opts.chatSessionId) return;
    const message = error instanceof Error ? error.message : String(error);
    bestEffortAppend(chatStore, opts.chatSessionId, [
      {
        time: opts.clock?.now() ?? Date.now(),
        type: "turn_end",
        data: { turn: turnCounter, reason: "error", error: message },
        turn: turnCounter,
      },
    ]);
  }

  /**
   * Best-effort: records an `error` event (not `turn_end`) when a Runner
   * already exists but its `run()` call rejects. A rejection normally means
   * the Runner's own try/finally has already stamped that turn's generic
   * `turn_end` (see `runner.ts`'s `recordTurnEnd()`), so recording a second
   * `turn_end` here would duplicate the turn-close event — `error` preserves
   * the message without that duplication. The one exception is the
   * gate-threw-while-paused corner: the state is still waiting_for_approval,
   * recordTurnEnd() skips the bracket, so no `turn_end` exists — the turn
   * legitimately stays open (the resume that completes it closes it) and only
   * the `error` event is added here. Never throws into the caller.
   */
  function recordTurnError(error: unknown): void {
    if (!opts.chatStore || !opts.chatSessionId) return;
    const message = error instanceof Error ? error.message : String(error);
    bestEffortAppend(chatStore, opts.chatSessionId, [
      {
        time: opts.clock?.now() ?? Date.now(),
        type: "error",
        data: { message },
        turn: turnCounter,
      },
    ]);
  }

  // ── M13: Slash command resolution ──────────────
  const commands = opts.commands ?? [];

  /**
   * Resolve raw input into an AgentInput, applying the `/name` resolution
   * order (Plan 018 Task 10 ruling — commands and skills are independent
   * namespaces, checked in this order):
   *
   *   1. A registered SlashCommand wins first. Checked synchronously via
   *      `matchCommand` so the existing command path never awaits the
   *      (async) skill registry.
   *   2. Otherwise, `expandSkillInvocation` checks whether the name matches
   *      a real skill at all (`recognized`). If it does — whether or not it
   *      is user-invocable — the user's own text (`/name args`) is kept
   *      verbatim. A recognized-but-unavailable skill must NOT fall through
   *      to step 3 (Finding I-2): that would silently replace the user's
   *      whole message with "Unknown command: ...", discarding whatever they
   *      asked for. The skill body is NOT injected into the message; the
   *      catalog layer instructs the model to load `/name` skills via the
   *      skill tool.
   *   3. Only when the name matches no skill at all (`recognized: false`)
   *      does today's unchanged `renderCommand` fallback — the
   *      "Unknown command: ..." prompt — apply verbatim.
   *
   * A same-named SKILL.md on disk must never silently shadow a command that
   * the host registered explicitly in code; that is why step 1 never touches
   * the skill registry at all.
   *
   * This function is `async` only because step 2 awaits the skill registry;
   * the command-match branch (step 1) never awaits anything. This does not
   * add a new atomicity requirement for callers — one agent instance already
   * only supports one turn at a time with no concurrency guard, and
   * `createNextRunner()` already had async gaps in the turn-claim span
   * before this function existed. See the concurrency-contract comment above
   * `let lastRunner` for the full picture.
   */
  async function resolveInput(raw: string | AgentInput): Promise<AgentInput> {
    if (typeof raw === "string" && raw.trimStart().startsWith("/")) {
      if (matchCommand(commands, raw) !== undefined) {
        return { type: "user_message", content: renderCommand(commands, raw) };
      }
      const rawInput: AgentInput = { type: "user_message", content: raw };
      const { recognized, input: expanded } = await expandSkillInvocation(rawInput, opts.skillRegistry);
      // recognized=false is the ONLY case that falls through to the
      // unknown-command prompt: no registry, no gesture grammar match, or a
      // gesture whose name matches no skill at all. Any recognized gesture —
      // even one that couldn't load — keeps its (possibly unmodified) input.
      if (recognized) return expanded;
      return { type: "user_message", content: renderCommand(commands, raw) };
    }
    return normalizeInput(raw);
  }

  const agentInstance: AgentInstance = {
    ports: resolvedPorts,

    async run(input: string | AgentInput): Promise<ReducerState> {
      turnInFlight = true;
      try {
        await initToolSources();
        const agentInput = await resolveInput(input);
        // `runner` stays undefined until createNextRunner() actually returns
        // one — the catch block below uses that to distinguish "the Runner
        // never existed" (record turn_end ourselves) from "the Runner existed
        // and its own run() rejected" (the Runner's try/finally has normally
        // already recorded turn_end for the turn — except the
        // gate-threw-while-paused corner, where no turn_end exists and the
        // turn legitimately stays open; either way record only the error text,
        // via a separate `error` event).
        let runner: Runner | undefined;
        try {
          runner = await createNextRunner(
            opts.eventSink ?? defaultEventSink,
            undefined,
            extractInputText(agentInput),
          );
          lastRunner = runner;
          const finalState = await runner.run(agentInput);
          lastFinalState = finalState;
          return finalState;
        } catch (err: unknown) {
          if (runner) recordTurnError(err);
          else recordTurnEndError(err);
          throw err;
        }
      } finally {
        turnInFlight = false;
        drainPendingFileInputs();
      }
    },

    async *stream(
      input: string | AgentInput,
      streamOpts?: { signal?: AbortSignal },
    ): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
      turnInFlight = true;
      try {
        await initToolSources();
        const agentInput = await resolveInput(input);
        const channel = createStreamChannel();
        // AbortController lets us cancel the runner if the consumer breaks
        // out of `for await` early. Without it, the detached runner would
        // keep going and any error it threw would be swallowed silently.
        const abortController = new AbortController();
        // An external signal (e.g. a UI "stop" button) is linked into the same
        // controller, so cancelling from the outside takes the identical path
        // as an early `break`: the runner observes the abort, unwinds, and
        // closes the turn with `reason: "cancelled"`.
        const externalSignal = streamOpts?.signal;
        if (externalSignal) {
          if (externalSignal.aborted) abortController.abort();
          else
            externalSignal.addEventListener("abort", () => abortController.abort(), {
              once: true,
            });
        }
        let runner: Runner;
        try {
          runner = await createNextRunner(
            channel.eventSink,
            abortController.signal,
            extractInputText(agentInput),
          );
        } catch (err: unknown) {
          recordTurnEndError(err);
          throw err;
        }
        lastRunner = runner;

        let runError: unknown;
        const runPromise = runner.run(agentInput).then(
          async (finalState) => {
            lastFinalState = finalState;
            channel.done();
          },
          async (err) => {
            runError = err;
            // The Runner exists here (constructed above) — a rejection normally
            // means its own try/finally already recorded turn_end; record the
            // error text separately rather than duplicating turn_end. (The one
            // gap is the gate-threw-while-paused corner: status is still
            // waiting_for_approval, no turn_end is recorded, and the turn
            // legitimately stays open with only this `error` event added.)
            recordTurnError(err);
            channel.done();
          },
        );

        // try/finally so that consumer break / return / throw still awaits the
        // runner and surfaces its error. AsyncGenerator runs `finally` blocks
        // when `.return()` is invoked (e.g. by an early `break`), which gives
        // us a deterministic place to abort and observe runError.
        try {
          yield* channel.events();
        } finally {
          abortController.abort();
          // Drain queued events / let runner observe abort. Errors thrown by
          // the runner during abort are captured in runError above; we still
          // wait for the promise to settle before propagating.
          await runPromise;
        }
        if (runError) throw runError;
      } finally {
        turnInFlight = false;
        drainPendingFileInputs();
      }
    },

    async resume(sessionId: string, decision: "allow" | "deny"): Promise<ReducerState> {
      // Try the in-memory runner first (same-process resume)
      if (lastRunner) {
        try {
          const finalState = await lastRunner.resume(sessionId, decision);
          lastFinalState = finalState;
          return finalState;
        } catch {
          // Runner doesn't have this session — fall through to store-based resume
        }
      }

      // Cross-process resume: load from session store and create a fresh runner
      const snapshot = await sessionStore.load(sessionId);
      if (!snapshot) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const restoredState = snapshot.state as ReducerState;
      if (restoredState.status !== "waiting_for_approval") {
        throw new Error(
          `Cannot resume session ${sessionId}: expected "waiting_for_approval" but got "${restoredState.status}"`,
        );
      }
      if (!restoredState.pendingApprovalTool) {
        throw new Error(
          `Cannot resume session ${sessionId}: missing pendingApprovalTool`,
        );
      }

      const resumeRunner = createRunner({
        modelPort,
        stepContext: lastTurnContextLayers
          ? { ...stepContext, contextLayers: lastTurnContextLayers }
          : stepContext,
        eventSink: opts.eventSink ?? defaultEventSink,
        toolExecutor,
        availableCapabilities: capabilities,
        permissionConfig,
        riskCeiling,
        approvalGate,
        sessionStore,
        compaction: compactionConfig,
        sessionId,
        initialState: restoredState,
        pathRoot: opts.cwd ?? process.cwd(),
        // Wire the transcript the same way createNextRunner() does — without
        // this, the tool_result and the assistant_message that follow it
        // never reach the durable log, leaving it ending on an
        // `assistant_message` with stopReason "tool_use" and no matching
        // `tool_result` (a shape both Anthropic and OpenAI reject outright
        // as the seed for the next turn).
        chatStore: opts.chatStore ? chatStore : undefined,
        chatSessionId: opts.chatSessionId,
        // Not turnCounter + 1: this resumes the turn that was already
        // claimed (and counted) when it originally started via
        // createNextRunner() — the same reason lastRunner.resume() above
        // doesn't touch turnCounter either. Using the current value keeps
        // this fallback runner's events attributed to that same turn instead
        // of silently starting a new one.
        turn: turnCounter,
        // Seed the step counter the same way the host seeds turnCounter via
        // initialTurn: the paused turn's earlier steps are already in the
        // transcript, and a fresh counter would restart at 1 and overwrite
        // them — see CreateAgentOptions.initialStep. Note this seeds ONLY
        // the fallback resume runner; createNextRunner() must never receive
        // it, or every new turn would continue the old turn's step numbers.
        initialStep: opts.initialStep,
        // Same header-only system-prompt mirror as createNextRunner()'s
        // runners: a fresh process rebuilt mid-turn still writes its own
        // request_header for the resumed model call, and without this the
        // resumed turn's header would silently drop the seed system prompt.
        ...(resolvedSystemPrompt ? { seedSystemPrompt: resolvedSystemPrompt } : {}),
        clock: opts.clock,
        attachmentStore,
        // Same registry as the live runners: an in-process fallback resume
        // keeps its handles; a cross-process rebuild constructs a fresh
        // agent (empty registry), so a checkpointed running task drains as
        // a ghost — collect() fails it with an explanation (F-036).
        backgroundRegistry,
      });

      lastRunner = resumeRunner;
      const finalState = await resumeRunner.resume(sessionId, decision);
      lastFinalState = finalState;
      return finalState;
    },

    async compactNow(): Promise<CompactNowResult | null> {
      // No runner yet — nothing to compact.
      if (!lastRunner) return null;
      // Delegates to the Runner so the write-back path is shared with the
      // automatic pre-request compaction. Throws CompactionBusyError when
      // a turn is in flight.
      const result = await lastRunner.compactNow();
      // The write-back feed replaces the runner's state object; re-sync
      // lastFinalState so getState() and the next turn's carry-forward
      // see the compacted messages.
      lastFinalState = lastRunner.getState();
      return result;
    },

    getState(): ReducerState {
      if (lastFinalState) return lastFinalState;
      if (lastRunner) return lastRunner.getState();
      throw new Error("No active session. Run a turn first.");
    },

    // Expose the backing session store so hosts can inspect checkpoint
    // history (time-travel debugger) and drive rewind/resume themselves.
    sessionStore,

    tools: allTools,

    async dispose(): Promise<void> {
      if (agentDisposed) return;
      agentDisposed = true;
      // The session kill is started first — killing a stuck session command
      // releases the agent's stdio pipes — and the remaining reclamation
      // (background processes, the LSP manager, the database opener) runs
      // concurrently with it: they are independent resources, so nothing is
      // gained by serializing them. `closeAll()` is only safe once no `open()`
      // is still in flight, which holds here because dispose runs at rest
      // (hosts must not call it mid-turn).
      const session = shellSession;
      shellSession = undefined;
      const sessionKill = session?.kill();
      // Each reclamation is wrapped in its own thunk so one failure cannot
      // skip the others — including a *synchronous* throw from a provider that
      // does not really return a promise, which would otherwise abort the
      // argument list before `closeAll()` was ever called. `allSettled` then
      // keeps the second and later failures from being silently dropped.
      const reclamations: Array<() => Promise<void>> = [
        async () => {
          await sessionKill;
        },
        async () => {
          await effectiveShell?.disposeProcesses?.();
        },
        async () => {
          await opts.lsp?.dispose();
        },
        async () => {
          await opts.db?.opener.closeAll();
        },
      ];
      const results = await Promise.allSettled(reclamations.map((reap) => reap()));
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason as unknown);
      if (failures.length > 0) {
        // Loud on purpose: a leaked language-server child or sqlite handle is a
        // real defect, and swallowing it would hide exactly that.
        throw new AggregateError(
          failures,
          `agent dispose failed to reap ${failures.length} of ${reclamations.length} resources`,
        );
      }
    },
  };

  // Late-bind so watch-batch auto-wake can start a turn through the public
  // run() (which owns turnInFlight) after the instance object exists.
  agentRun = (input) => agentInstance.run(input);
  return agentInstance;
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Wrap an injected FileWatcher so every `watch()` registration delivers
 * batches through the agent's handler (host callback + auto-wake) as well as
 * the tool's own onEvents. Tools stay unchanged; the SDK owns event wiring.
 * Batches that somehow fire before `watch()` resolves are buffered and
 * flushed once the id is known, so the watchId in FileChangedInput is never
 * empty.
 */
function wrapFileWatcher(
  inner: FileWatcher,
  onBatch: (watchId: string, events: FileWatchEvent[]) => void,
): FileWatcher {
  return {
    async watch(reg, onEvents) {
      // Object cell rather than a reassignable let: the adapter callback may
      // fire before watch() resolves, and prefer-const rejects a let whose
      // only write is the post-await assignment.
      const cell: { id: string | undefined } = { id: undefined };
      const early: FileWatchEvent[][] = [];
      const deliver = (id: string, events: FileWatchEvent[]): void => {
        try {
          onBatch(id, events);
        } catch {
          // Never throw into the adapter — a host/agent handler failure must
          // not crash the watcher.
        }
        try {
          onEvents(events);
        } catch {
          // Same isolation for the tool-provided callback.
        }
      };
      const id = await inner.watch(reg, (events) => {
        if (cell.id === undefined) {
          early.push(events);
          return;
        }
        deliver(cell.id, events);
      });
      cell.id = id;
      for (const batch of early) deliver(id, batch);
      return id;
    },
    async unwatch(id) {
      return inner.unwatch(id);
    },
    async list() {
      return inner.list();
    },
    async dispose() {
      await inner.dispose?.();
    },
  };
}

/**
 * Codepoint comparator by skill name — locale-independent determinism.
 * localeCompare() is locale-sensitive (e.g. "a" sorts before "B" under en-US
 * collation but after it by codepoint), so the catalog order must not depend
 * on the host's locale.
 */
function compareSkillSummariesByName(a: SkillSummary, b: SkillSummary): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Default cap on a catalog entry's description. The catalog is injected into
 * the system layer every turn and is not covered by the instruction byte
 * budget, so a machine with dozens of skills carrying paragraph-length
 * descriptions would otherwise spend kilobytes per turn on it.
 */
export const DEFAULT_SKILL_CATALOG_DESCRIPTION_MAX_LENGTH = 200;
const MIN_SKILL_CATALOG_DESCRIPTION_MAX_LENGTH = 16;

/**
 * Cuts `value` to at most `limit` Unicode code points (not UTF-16 code
 * units), appending an ellipsis if it was longer. `String.prototype.slice`
 * cuts on code units and can split an astral-plane character's surrogate
 * pair, leaving a lone unpaired surrogate that becomes U+FFFD once
 * serialized to UTF-8 for transport. Iterating with `Array.from` walks by
 * code point instead, so the cut always lands on a whole-character boundary.
 */
function truncateDescription(value: string, limit: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) {
    return value;
  }
  return `${codePoints.slice(0, limit).join("")}…`;
}

/**
 * Deterministic catalog text — names and descriptions only, never bodies.
 * Sorted by name codepoint-wise (on a copy — the input array is not mutated)
 * so the layer text is stable regardless of the registry's discovery order or
 * the host's locale; descriptions are collapsed to a single line and capped
 * (in Unicode code points, see `truncateDescription`).
 */
export function renderSkillCatalog(
  summaries: SkillSummary[],
  descriptionMaxLength: number = DEFAULT_SKILL_CATALOG_DESCRIPTION_MAX_LENGTH,
): string {
  // A non-finite descriptionMaxLength (e.g. NaN from a bad config parse)
  // must fall back to the default cap rather than defeating the cap
  // entirely: Math.max(MIN, NaN) is NaN, and `length > NaN` is always false.
  const requestedLimit = Number.isFinite(descriptionMaxLength)
    ? descriptionMaxLength
    : DEFAULT_SKILL_CATALOG_DESCRIPTION_MAX_LENGTH;
  const limit = Math.max(MIN_SKILL_CATALOG_DESCRIPTION_MAX_LENGTH, requestedLimit);
  const sorted = [...summaries].sort(compareSkillSummariesByName);
  const lines = sorted.map((s) => {
    const collapsed = s.description.replace(/\s+/g, " ").trim();
    const description = truncateDescription(collapsed, limit);
    return `- ${s.name}: ${description}`;
  });
  return [
    "Available skills (load full instructions with the skill tool):",
    'When the user message starts with "/<skill-name>" matching a skill below, load that skill with the skill tool first, then follow it.',
    ...lines,
  ].join("\n");
}

/**
 * Builds the skill-catalog `ContextLayer` (names + descriptions only) shared
 * by the main turn and subagent dispatch. Returns `undefined` when there is
 * no registry, or when the registry lists zero model-invocable skills — an
 * empty catalog layer would only spend tokens for nothing.
 */
async function buildSkillCatalogLayer(
  skillRegistry: SkillRegistry | undefined,
  descriptionMaxLength: number | undefined,
): Promise<ContextLayer | undefined> {
  if (!skillRegistry) return undefined;
  const summaries = (await skillRegistry.list())
    .filter((s) => s.invocation.modelInvocable)
    .sort(compareSkillSummariesByName);
  if (summaries.length === 0) return undefined;
  return {
    id: "skill-catalog",
    text: renderSkillCatalog(summaries, descriptionMaxLength),
  };
}

function normalizeInput(input: string | AgentInput): AgentInput {
  if (typeof input === "string") {
    return { type: "user_message", content: input };
  }
  return input;
}

/**
 * Result of {@link expandSkillInvocation}: whether the first line named an
 * actual entry in the skill registry (`recognized`), and the (unmodified)
 * input.
 *
 * `recognized` is the signal `resolveInput` needs to fix Finding I-2: a name
 * that matches the `/name` grammar but corresponds to no skill at all is
 * genuinely unknown and must still fall through to the existing
 * "Unknown command: ..." prompt. But a name that DOES match a real skill —
 * whether it turns out not to be user-invocable or the registry throws —
 * is not "unknown"; the user's original text must survive unchanged instead
 * of being replaced by that prompt. Distinguishing the two only from the
 * final `input` value is impossible: both cases leave `input` untouched.
 */
export interface SkillGestureResult {
  recognized: boolean;
  input: AgentInput;
}

/**
 * Recognizes a `/name` gesture that names a real skill.
 *
 * Does NOT inject the skill body into the user message. The user's text
 * (`/name args`) is delivered verbatim; the model loads the body on demand
 * via the `skill` tool (progressive disclosure — bodies never sit in
 * `messages` and are not resent every subsequent turn).
 *
 * `recognized` is false only when the gesture grammar didn't match at all, or
 * matched a name with no corresponding registry entry — see
 * {@link SkillGestureResult}. In every `recognized: false` case `input` is
 * returned by identity (not a structural copy), same as every
 * `recognized: true` case; `resolveInput` does not currently
 * depend on that identity (it branches on `recognized`), but tests pin it as
 * a cheap invariant.
 *
 * Independent of the slash-command namespace: `resolveInput` only reaches
 * this function after `matchCommand` has already found no registered
 * command for the name, so a same-named SlashCommand always wins first (see
 * Plan 018 Task 10 ruling). Exported for direct unit testing only — not
 * re-exported from the package's public entry point (index.ts).
 */
export async function expandSkillInvocation(
  input: AgentInput,
  registry: SkillRegistry | undefined,
): Promise<SkillGestureResult> {
  if (registry === undefined) return { recognized: false, input };
  if (input.type !== "user_message") return { recognized: false, input };
  const text = typeof input.content === "string" ? input.content : undefined;
  if (text === undefined) return { recognized: false, input };

  const name = parseSkillInvocation(text);
  if (name === null) return { recognized: false, input };

  try {
    const summary = (await registry.list()).find((s) => s.name === name);
    // No skill by this name at all — the gesture is genuinely unknown, same
    // as today: let resolveInput fall through to "Unknown command: ...".
    if (summary === undefined) return { recognized: false, input };
    // From here the name IS a real skill. Whatever happens next — not
    // user-invocable, or a throw below — must preserve the user's text and
    // must NOT fall through to the unknown-command prompt (Finding I-2).
    // The body itself is never injected: the catalog layer tells the model
    // to load `/name` skills via the skill tool.
    return { recognized: true, input };
  } catch {
    // A registry failure must not turn a normal message into an error, and
    // (Finding I-2) the name already matched a skill gesture, so it must not
    // be treated as unknown either — the user's text survives.
    return { recognized: true, input };
  }
}

/** Extracts the plain text of a user_message input; empty string for any other input type. */
function extractInputText(input: AgentInput): string {
  if (input.type !== "user_message") return "";
  if (typeof input.content === "string") return input.content;
  return input.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Wrap an EventSink so every emitted event is tagged with the originating
 * agent depth and an optional label. Used by sub-agents so the host can
 * distinguish nested output from the main agent's stream without breaking
 * existing event payload shapes. `childSessionId` (when the sub-agent has a
 * real parent session to link back to) makes parallel dispatches
 * attributable on the shared parent channel.
 */
function tagEventSink(
  inner: EventSink,
  depth: number,
  label?: string,
  childSessionId?: string,
): EventSink {
  return {
    emit(event) {
      // Spread the whole envelope: the runner's transcript emissions carry
      // {time, turn?, step?} stamps the gateway's frame() narrows on —
      // rebuilding {type, data} stripped them, so every sub-agent transcript
      // event was dropped at the gateway (deltas survived because the delta
      // branch reads data alone) and any live sub-agent view froze on its
      // first fetch snapshot.
      inner.emit({
        ...event,
        data: {
          ...event.data,
          agentDepth: depth,
          ...(label !== undefined ? { agentLabel: label } : {}),
          ...(childSessionId !== undefined ? { childSessionId } : {}),
        },
      });
    },
  };
}

/**
 * Result of intersecting an AgentSpec with the parent agent's resources.
 *
 * Tools and capabilities are intersections, never substitutions: a definition
 * naming a tool or capability the parent does not have cannot conjure it into
 * existence. Permissions are narrowed via core `narrowPermission` — the
 * definition may tighten, never widen.
 */
export interface AssembledSubAgent {
  tools: Tool[];
  capabilities: Set<string>;
  permissionConfig: PermissionConfig;
  /** Axes where the definition asked for more than the parent allows. */
  downgrades: Array<{ field: string; requested: string; effective: string }>;
}

/**
 * Resolve a definition into assembly parameters, intersected with the parent.
 *
 * Tools and capabilities are intersections, not substitutions: a definition
 * naming a tool the parent does not have must not conjure it into existence.
 * An omitted `tools`/`capabilities` field means "no extra restriction" (the
 * full parent set); an empty list means "none".
 *
 * A partial `spec.policy` is completed from the parent on missing axes
 * (missing = inherit, never widen), then the completed pair is run through
 * core `narrowPermission` so every axis is at most as permissive as the
 * parent. Axes the definition asked to widen are reported in `downgrades` so
 * the host can surface why the child did not get what its definition asked
 * for (F-023).
 */
export function assembleSubAgent(opts: {
  spec: AgentSpec;
  parentTools: Tool[];
  parentPolicy: PermissionConfig;
  parentCapabilities: Set<string>;
}): AssembledSubAgent {
  const { spec, parentTools, parentPolicy, parentCapabilities } = opts;

  // Tools: keep parent order; drop declared names the parent does not own.
  const parentToolsByName = new Map(
    parentTools.map((t) => [t.definition.name, t] as const),
  );
  const tools: Tool[] =
    spec.tools === undefined
      ? [...parentTools]
      : spec.tools.flatMap((name) => {
          const t = parentToolsByName.get(name);
          return t ? [t] : [];
        });

  // Capabilities: same intersection rule as tools.
  const capabilities =
    spec.capabilities === undefined
      ? new Set(parentCapabilities)
      : new Set(spec.capabilities.filter((c) => parentCapabilities.has(c)));

  // Complete a partial policy from the parent (missing axis = inherit, not
  // widen), then let core narrowPermission take the stricter option on every
  // axis. Never reimplement that math here.
  const requestedPolicy: PermissionConfig = {
    sandbox: spec.policy?.sandbox ?? parentPolicy.sandbox,
    approval: spec.policy?.approval ?? parentPolicy.approval,
    ...(spec.policy?.rules !== undefined ? { rules: spec.policy.rules } : {}),
  };
  const permissionConfig = narrowPermission(parentPolicy, requestedPolicy);

  const downgrades: AssembledSubAgent["downgrades"] = [];
  if (requestedPolicy.sandbox !== permissionConfig.sandbox) {
    downgrades.push({
      field: "sandbox",
      requested: requestedPolicy.sandbox,
      effective: permissionConfig.sandbox,
    });
  }
  if (requestedPolicy.approval !== permissionConfig.approval) {
    downgrades.push({
      field: "approval",
      requested: requestedPolicy.approval,
      effective: permissionConfig.approval,
    });
  }

  return { tools, capabilities, permissionConfig, downgrades };
}

/**
 * Create a sync sub-agent executor that spins up a fresh Runner with
 * isolated state per dispatch.
 *
 * Without a `subagentType` the child inherits the parent's tools, minus the
 * `task` / `task_output` instances bound to this executor. With one, the
 * matching AgentEntry is assembled via `assembleSubAgent` so the child gets
 * only what the definition declares AND the parent owns, a policy at most as
 * permissive as the parent's, the definition's body as its system prompt and
 * its `model:` for the dispatch. A child still below `maxAgentDepth` also
 * gets a `task` bound one level deeper, so delegation nests and each level
 * is counted. Sub-agent events are forwarded to the parent's event sink with
 * an `agentDepth` tag so the host can render them separately.
 *
 * Background dispatch is the parent agent's only: a sub-agent has no turn
 * boundary of its own to drain on, so its `task` refuses one.
 */
function createSubAgentExecutor(
  opts: CreateAgentOptions,
  parentCustomTools: Tool[],
  parentAdapterTools: Tool[],
  capabilities: Set<string>,
  attachmentStore: AttachmentStore,
  compactionConfig?: CompactionConfig,
  depth: number = 1,
  shellOverride?: Shell,
  idPort: Id = defaultId,
  getCurrentEventSink: () => EventSink | undefined = () => undefined,
  chatStore?: TranscriptStore,
  parentChatSessionId?: string,
  getCurrentTurn: () => number = () => 0,
  agentSpecs: AgentEntry[] = [],
  // Sub-agents share the parent agent's single persistent session: from the
  // user's point of view there is one workspace, and a task tool dispatch
  // must see the same cd/export state the parent built up.
  getSession?: () => BashSessionLike | undefined,
): SyncSubAgentExecutor {
  return async ({
    message,
    subagentType,
  }: SyncSubAgentRequest): Promise<SyncSubAgentOutcome> => {
    const nowMs = (): number => opts.clock?.now() ?? Date.now();
    const turn = getCurrentTurn();

    // A sub-agent writes its own session file rather than sharing the parent's.
    // Sharing would collide: both Runners number their steps from 1 within the
    // same (turn, step) space. Independent sessions also let a deep task tree
    // stay readable one level at a time.
    // Only computed when there is a real parent session to hang it off of —
    // without parentChatSessionId there is nothing to link a child session
    // back to, so it would be an orphan (unattributable to any conversation)
    // if the store ever wrote it.
    const childSessionId = parentChatSessionId ? `${parentChatSessionId}-sub-${idPort.next()}` : undefined;
    const startedAt = nowMs();
    // The parent's live sink, read once per dispatch (hoisted from the runner
    // construction below: the brackets must reach it first, and nothing
    // reassigns the turn sink between here and there).
    const currentSink = getCurrentEventSink();
    const agentLabel = subagentType ?? "task";

    // ── Assemble the child's tools / capabilities / policy ──
    // Done before any bracket so the label and the downgrade event describe
    // the same dispatch. The inherited `task` / `task_output` instances are
    // always stripped: both are bound to THIS executor's depth and to this
    // agent's background registry, so a child calling them would spawn its
    // siblings at the same depth, or collect tasks it never dispatched. A
    // child below the cap gets a freshly bound `task` instead — see the
    // nested executor below.
    const parentPolicyResolved = resolveConfigValue(
      opts.permissionConfig,
      opts.config?.config,
      "permissionConfig",
    );
    const parentToolsForChild = [
      ...parentCustomTools.filter(
        (t) => t.definition.name !== "task" && t.definition.name !== "task_output",
      ),
      ...parentAdapterTools,
    ];
    const parentCapabilitiesForChild = new Set(capabilities);
    // The delegation budget follows the child's own depth: below the cap it
    // is granted, at or past it the parent's grant is withdrawn so the
    // delegation tools leave the child's visible set through capability
    // gating rather than a post-call refusal.
    const childCanDelegate = depth < (opts.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH);
    if (childCanDelegate) {
      parentCapabilitiesForChild.add(CAP_AGENT_DEPTH_AVAILABLE);
    } else {
      parentCapabilitiesForChild.delete(CAP_AGENT_DEPTH_AVAILABLE);
      parentCapabilitiesForChild.delete(CAP_AGENT_TASK);
    }

    let childTools: Tool[] = parentToolsForChild;
    let childCapabilities: Set<string> = parentCapabilitiesForChild;
    // General-purpose path keeps the parent's resolved value as-is (possibly
    // undefined → the Runner applies no permission layer, matching prior
    // behavior). A typed path always gets a concrete narrowed policy.
    let childPermissionConfig: PermissionConfig | undefined = parentPolicyResolved;
    let downgrades: AssembledSubAgent["downgrades"] = [];
    // The resolved definition, kept for the settings the Runner reads below
    // (prompt, model). Undefined on the general-purpose path.
    let childSpec: AgentSpec | undefined;

    if (subagentType !== undefined) {
      const entry = agentSpecs.find(
        (e) => !e.shadowed && e.spec.name === subagentType,
      );
      if (!entry) {
        // The task tool pre-checks known types when a registry is present;
        // this is the executor-side backstop for a subagent_type that reached
        // dispatch with no matching non-shadowed definition. Fail loudly
        // rather than silently falling back to general-purpose — the model
        // asked for a specific definition and must not get a different one.
        throw new Error(`Unknown subagent_type "${subagentType}"`);
      }
      const assembled = assembleSubAgent({
        spec: entry.spec,
        parentTools: parentToolsForChild,
        // Completing from the default here (rather than passing undefined)
        // keeps narrowPermission total: a parent that never configured a
        // policy still cannot be widened past workspace-write + ask by a
        // definition file the agent itself can write.
        parentPolicy: parentPolicyResolved ?? createDefaultPermissionConfig(),
        parentCapabilities: parentCapabilitiesForChild,
      });
      childTools = assembled.tools;
      childCapabilities = assembled.capabilities;
      childPermissionConfig = assembled.permissionConfig;
      downgrades = assembled.downgrades;
      childSpec = entry.spec;
    }

    // ── Nested delegation (design §9) ──
    // A child below the cap gets its own `task`, bound to an executor one
    // level deeper, so "research agent fans out sub-searches" works and each
    // level is counted. A definition that lists its tools must name `task`
    // to get it: the intersection rule owns that decision, not this block.
    // `task_output` is deliberately not re-created — the background registry
    // is per agent instance, and a child's turn ends inside the parent's
    // tool call, leaving no turn boundary of its own to drain on.
    const childWantsTask =
      childSpec?.tools === undefined || childSpec.tools.includes("task");
    if (childCanDelegate && childCapabilities.has(CAP_AGENT_TASK) && childWantsTask) {
      const nestedExecutor = createSubAgentExecutor(
        opts,
        childTools,
        [],
        childCapabilities,
        attachmentStore,
        compactionConfig,
        depth + 1,
        shellOverride,
        idPort,
        getCurrentEventSink,
        chatStore,
        childSessionId,
        getCurrentTurn,
        agentSpecs,
        getSession,
      );
      const nestedDispatch: SubAgentDispatch = async (req) => {
        if (req.background) {
          // Refuse rather than silently running it synchronously: the model
          // would otherwise be told it holds a task id it can never collect.
          throw new Error(
            "Background dispatch is not available to a sub-agent; run the task synchronously.",
          );
        }
        const outcome = await nestedExecutor({
          message: req.message,
          ...(req.subagentType !== undefined ? { subagentType: req.subagentType } : {}),
        });
        return {
          taskId: idPort.next(),
          text: outcome.text,
          ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
        };
      };
      childTools = [
        ...childTools,
        createTaskTool(nestedDispatch, { types: toAgentTypeSummaries(agentSpecs) }),
      ];
    }

    if (chatStore && parentChatSessionId && childSessionId) {
      bestEffortAppend(chatStore, parentChatSessionId, [
        {
          time: startedAt,
          type: "subagent_started",
          data: { childSessionId, label: agentLabel, depth },
          turn,
        },
      ]);
      bestEffortAppend(chatStore, childSessionId, [
        {
          time: startedAt,
          type: "session_meta",
          data: {
            projectId: null,
            providerId: null,
            modelId: null,
            permissionMode: null,
            parentSessionId: parentChatSessionId,
            delegationDepth: depth,
            origin: "subagent" as const,
          },
        },
      ]);
    }

    // Live path (Task 5c): the same bracket also rides the parent's event
    // sink so SSE clients see it in real time — the store write above alone
    // only reaches replay/resume. Brackets are parent-level events: never
    // tagged agentDepth (they must stay on the main feed, not be routed into
    // a child bucket), and the parent turn stamp is mandatory — an unstamped
    // bracket would fall into a phantom turn 0 in the client projection.
    // Emission needs only a child session to link (childSessionId implies
    // parentChatSessionId); it deliberately does not depend on the chatStore,
    // whose absence only disables persistence. Sink absent → skipped silently.
    // The stamp rides along as top-level extras on the sink payload, the same
    // convention the Runner's toSinkEvent uses for streamed transcript events
    // (task-r6 isomorphism).
    if (childSessionId) {
      const startedBracket: TranscriptEventInput<"subagent_started"> = {
        time: startedAt,
        type: "subagent_started",
        data: { childSessionId, label: agentLabel, depth },
        turn,
      };
      currentSink?.emit(startedBracket);
    }

    // F-023: a definition that asked for more than the parent allows must say
    // so on the main feed — otherwise the user sees a silent, inexplicable
    // restriction. Parent-level (un-tagged), like the brackets above.
    if (downgrades.length > 0 && subagentType !== undefined) {
      currentSink?.emit({
        type: "subagent_permission_downgraded",
        data: {
          ...(childSessionId !== undefined ? { childSessionId } : {}),
          subagentType,
          downgrades,
          turn,
        },
      });
    }

    const finishSubAgent = (isError: boolean): void => {
      if (chatStore && parentChatSessionId && childSessionId) {
        bestEffortAppend(chatStore, parentChatSessionId, [
          {
            time: nowMs(),
            type: "subagent_finished",
            data: { childSessionId, isError, durationMs: nowMs() - startedAt },
            turn,
          },
        ]);
      }
      if (childSessionId) {
        const finishedBracket: TranscriptEventInput<"subagent_finished"> = {
          time: nowMs(),
          type: "subagent_finished",
          data: { childSessionId, isError, durationMs: nowMs() - startedAt },
          turn,
        };
        currentSink?.emit(finishedBracket);
      }
    };

    const subToolDefs: ToolDefinition[] = childTools.map((t) => t.definition);

    const subCustomToolMap = new Map<string, Tool>();
    for (const t of childTools) {
      subCustomToolMap.set(t.definition.name, t);
    }
    // Same gap as the parent: non-specialized adapter tools must be routable.
    for (const t of parentAdapterTools) {
      if (!subCustomToolMap.has(t.definition.name)) {
        subCustomToolMap.set(t.definition.name, t);
      }
    }

    const subFsExecutor = opts.fs
      ? createFsToolExecutor({
          fs: opts.fs,
          attachments: attachmentStore,
          visionSupported: opts.modelVision,
          // Same default-on parser the parent wires: the sub path is a
          // top-level factory and cannot see createAgent's local const, so
          // resolve it again here (lazy — no construction cost until used).
          documentParser: opts.documentParser ?? createLazyNodeDocumentParser(),
        })
      : undefined;
    const subShellExecutor = shellOverride
      ? createShellToolExecutor({ shell: shellOverride, getSession })
      : undefined;
    const subNetworkExecutor = opts.network ? createNetworkToolExecutor({ network: opts.network }) : undefined;

    const subExecutor: ToolExecutor = async (call, ctx) => {
      if (subFsExecutor && FS_EXECUTOR_TOOL_NAMES.has(call.name)) {
        return subFsExecutor(call, ctx);
      }
      if (subShellExecutor && SHELL_TOOL_NAMES.has(call.name)) return subShellExecutor(call, ctx);
      if (subNetworkExecutor && NETWORK_TOOL_NAMES.has(call.name)) return subNetworkExecutor(call, ctx);
      const tool = subCustomToolMap.get(call.name);
      if (!tool) return { modelContent: `Unknown tool: ${call.name}`, isError: true };
      return tool.handler(call.input);
    };

    // A subagent that keeps skill:load (and the `skill` tool) can only guess
    // skill names without this. Rebuilt per dispatch rather than reusing the
    // parent turn's catalog: correctness (a registry can change mid-session)
    // over the one extra `list()` call per subagent. Deliberately does NOT
    // carry the host's other context layers (project instructions, user
    // memory, …) — plan-015 decided subagents start from a clean context,
    // and widening that is a design change, not this fix's scope.
    const subCatalogLayer = await buildSkillCatalogLayer(opts.skillRegistry, opts.skillCatalogDescriptionMaxLength);

    // Every model setting the definition declares outranks the parent's for
    // this dispatch; anything it leaves out is inherited. A retrieval
    // sub-agent pinned to a small model at temperature 0 is the whole point
    // of these fields — silently running it on the parent's settings is the
    // "configured it, nothing happened" failure the design calls out.
    const resolvedSubReasoningEffort =
      childSpec?.reasoningEffort ??
      resolveConfigValue(opts.reasoningEffort, opts.config?.config, "reasoningEffort");
    const resolvedSubResponseFormat =
      childSpec?.responseFormat ??
      resolveConfigValue(opts.responseFormat, opts.config?.config, "responseFormat");
    const subStepContext: StepContext = {
      tools: subToolDefs,
      model: childSpec?.model ?? resolveConfigValue(opts.model, opts.config?.config, "model"),
      ...(opts.providerId !== undefined ? { providerId: opts.providerId } : {}),
      maxTokens:
        childSpec?.maxTokens ?? resolveConfigValue(opts.maxTokens, opts.config?.config, "maxTokens"),
      temperature:
        childSpec?.temperature ??
        resolveConfigValue(opts.temperature, opts.config?.config, "temperature"),
      id: idPort,
      ...(resolvedSubReasoningEffort !== undefined
        ? { reasoningEffort: ReasoningEffortId(resolvedSubReasoningEffort) }
        : {}),
      ...(resolvedSubResponseFormat !== undefined
        ? { responseFormat: resolvedSubResponseFormat }
        : {}),
      ...(subCatalogLayer ? { contextLayers: [subCatalogLayer] } : {}),
    };

    // currentSink was read at the top of this dispatch (the brackets emitted
    // there need it before the runner exists); reuse the same snapshot here.
    const taggedSink = currentSink
      ? tagEventSink(currentSink, depth, agentLabel, childSessionId)
      : undefined;

    const subRunner = createRunner({
      modelPort: opts.modelPort,
      stepContext: subStepContext,
      toolExecutor: subExecutor,
      availableCapabilities: childCapabilities,
      permissionConfig: childPermissionConfig,
      // Derived from the child's OWN (narrowed) policy, not the parent's: a
      // definition narrowed to read-only must lose its write tools from the
      // visible set exactly like a parent session configured read-only.
      riskCeiling: childPermissionConfig
        ? ceilingOf(childPermissionConfig.sandbox)
        : undefined,
      pathRoot: opts.cwd ?? process.cwd(),
      // Sub-agents cannot prompt the parent's human mid-turn; "ask" resolves
      // to "deny" so a WRITE_HIGH tool needing confirmation in the parent is
      // never silently executed in the child.
      approvalGate: createSubAgentApprovalGate(),
      eventSink: taggedSink,
      sessionStore: createDefaultSessionStore(),
      compaction: compactionConfig,
      sessionId: `sub-${idPort.next()}`,
      // Guarded on parentChatSessionId too: without a parent session there
      // is no valid childSessionId (see above), so never hand the Runner a
      // chatStore it would use to write an orphaned "undefined-sub-…" session.
      chatStore: parentChatSessionId ? chatStore : undefined,
      chatSessionId: childSessionId,
      clock: opts.clock,
      attachmentStore,
      // P2-9: inherit parent budget limits so sub-agents respect cost/wallclock caps
      initialState: createInitialState({
        // The definition's body is the sub-agent's system prompt. Seeded the
        // same way the parent seeds its own (a system message ahead of the
        // dispatch), and deliberately without the parent's prompt: a typed
        // sub-agent starts from its own instructions, not the parent's.
        ...(childSpec?.systemPrompt
          ? {
              messages: [
                {
                  id: idPort.next(),
                  role: "system" as const,
                  content: childSpec.systemPrompt,
                },
              ],
            }
          : {}),
        // Loop caps the definition declares. These are the child's own
        // runaway guards, independent of the parent's: a sub-agent told to
        // answer in two iterations must stop at two even when the parent
        // allows twenty.
        ...(childSpec?.maxIterations !== undefined
          ? { maxIterations: childSpec.maxIterations }
          : {}),
        ...(childSpec?.maxToolCalls !== undefined
          ? { maxToolCalls: childSpec.maxToolCalls }
          : {}),
        ...(resolveConfigValue(opts.maxDollarsPerTurn, opts.config?.config, "maxDollarsPerTurn") !== undefined
          ? { maxCostDollars: resolveConfigValue(opts.maxDollarsPerTurn, opts.config?.config, "maxDollarsPerTurn") }
          : resolveConfigValue(opts.maxCostTokens, opts.config?.config, "maxCostTokens") !== undefined
            ? { maxCostDollars: resolveConfigValue(opts.maxCostTokens, opts.config?.config, "maxCostTokens") }
            : {}),
        ...(resolveConfigValue(opts.maxTokensPerTurn, opts.config?.config, "maxTokensPerTurn") !== undefined
          ? { maxTokensPerTurn: resolveConfigValue(opts.maxTokensPerTurn, opts.config?.config, "maxTokensPerTurn") }
          : {}),
        ...(opts.maxWallclockMs !== undefined
          ? { maxWallclockMs: resolveConfigValue(opts.maxWallclockMs, opts.config?.config, "maxWallclockMs") }
          : {}),
      }),
    });

    try {
      const finalState = await subRunner.run({
        type: "user_message",
        content: message,
      });
      finishSubAgent(false);

      const lastMsg = finalState.messages[finalState.messages.length - 1];
      const text = lastMsg && lastMsg.role === "assistant" ? extractPlainText(lastMsg) : "";
      return { text, ...(childSessionId !== undefined ? { sessionId: childSessionId } : {}) };
    } catch (err) {
      finishSubAgent(true);
      throw err;
    }
  };
}
