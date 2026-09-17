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
} from "@volto/core";
import {
  createDefaultPermissionConfig,
  extractPlainText,
  createInitialState,
  resetTurnForNextInput,
  filterByScope,
  extractTouchedToolPaths,
  parseSkillInvocation,
  ReasoningEffortId,
} from "@volto/core";
import type { StepContext, ReducerState, TranscriptStore, TranscriptEventInput, ChatSessionMeta } from "@volto/core";
import { createRunner, type Runner, type ToolExecutor } from "@volto/runtime-node";
import type { RunnerOptions, CompactNowResult } from "@volto/runtime-node";
import {
  createFsToolExecutor,
  createShellToolExecutor,
  createNetworkToolExecutor,
} from "@volto/runtime-node";
import { createAutoAllowGate } from "@volto/runtime-node";
import { createSandboxedShell, type SandboxConfig } from "@volto/runtime-node";
import type { Tool } from "@volto/tools-common";
import type { SubAgentExecutor } from "@volto/tools-agent";
import { createTaskTool } from "@volto/tools-agent";
import {
  createReadFileTool,
  createEditFileTool,
  createWriteFileTool,
  createApplyPatchTool,
  createMultiEditTool,
  createLsTool,
  createGlobTool,
  createGrepTool,
  FS_TOOL_NAMES,
} from "@volto/tools-fs";
import {
  createBashTool,
  createBashOutputTool,
  createKillShellTool,
  SHELL_TOOL_NAMES,
} from "@volto/tools-shell";
import { createWebFetchTool, createWebSearchTool, NETWORK_TOOL_NAMES } from "@volto/tools-web";
import {
  createLspDefinitionTool,
  createLspReferencesTool,
  createLspRenameTool,
  createLspDiagnosticsTool,
  createLspHoverTool,
} from "@volto/tools-code";
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
import { createHttpQueryTool, createDbQueryTool, createDbExecTool } from "@volto/tools-data";
import type { DatabaseAdapter } from "@volto/tools-data";
import { createReadDocumentTool } from "@volto/tools-document";
import type { DocumentParserAdapter } from "@volto/tools-document";
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
  collectPlugins,
} from "./plugin.js";
import { renderCommand, matchCommand } from "./commands.js";
import { type AuditSink, defaultAuditSink } from "@volto/runtime-node";

// ──────────────────────────────────────────────
// Config resolution helper
// ──────────────────────────────────────────────

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
// Public types
// ──────────────────────────────────────────────

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
   */
  sandboxConfig?: SandboxConfig;

  /** Network adapter */
  network?: Network;

  /** LSP client adapter — when provided, LSP code intelligence tools are auto-created */
  lspClient?: import("@volto/tools-code").LspClient;

  /** Browser adapter — when provided, browser/computer-use tools are auto-created */
  browserAdapter?: BrowserAdapter;

  /** Database adapter — when provided, db_query / db_exec tools are auto-created */
  dbAdapter?: DatabaseAdapter;

  /** Document parser adapter — when provided, read_document tool is auto-created */
  documentParser?: DocumentParserAdapter;

  /** Available capabilities (auto-populated from injected adapters if not set) */
  capabilities?: Set<string>;

  /** Enable the task sub-agent tool */
  enableTaskTool?: boolean;

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
   * Tear down agent-owned resources when the host ends the session.
   * Currently kills every managed background shell process via
   * `Shell.disposeProcesses` (when the shell implements it). Safe to call
   * when no shell was configured — it resolves as a no-op.
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
  if (opts.network) {
    capabilities.add("network:fetch");
  }
  if (opts.lspClient) {
    capabilities.add("lsp:query");
  }
  if (opts.browserAdapter) {
    capabilities.add("browser:control");
  }
  if (opts.dbAdapter) {
    capabilities.add("db:query");
    capabilities.add("db:exec");
  }
  if (opts.documentParser) {
    capabilities.add("document:parse");
  }
  if (resolve(opts.enableTaskTool, "enableTaskTool")) {
    capabilities.add("agent:task");
  }
  if (opts.skillRegistry) {
    capabilities.add("skill:load");
  }

  // ── Build adapter tools ──────────────────
  const adapterTools: Tool[] = [];
  if (opts.fs) {
    adapterTools.push(
      createReadFileTool(opts.fs),
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
      createBashTool(effectiveShell!),
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
  if (opts.network) {
    adapterTools.push(createWebFetchTool(opts.network), createWebSearchTool(opts.network));
    adapterTools.push(createHttpQueryTool(opts.network));
  }
  if (opts.lspClient) {
    adapterTools.push(
      createLspDefinitionTool(opts.lspClient),
      createLspReferencesTool(opts.lspClient),
      createLspRenameTool(opts.lspClient),
      createLspDiagnosticsTool(opts.lspClient),
      createLspHoverTool(opts.lspClient),
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
  if (opts.dbAdapter) {
    adapterTools.push(
      createDbQueryTool(opts.dbAdapter),
      createDbExecTool(opts.dbAdapter),
    );
  }
  if (opts.documentParser) {
    adapterTools.push(
      createReadDocumentTool(opts.documentParser),
    );
  }
  if (opts.scheduler) {
    capabilities.add("scheduler:exec");
    adapterTools.push(
      createScheduleTool(opts.scheduler),
      createCancelScheduleTool(opts.scheduler),
    );
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

  // Standing todos: pure state tool (no ports). Capability-gated by plan:write.
  capabilities.add(CAP_PLAN_WRITE);
  allCustomTools.push(createTodoWriteTool());

  if (opts.enableTaskTool) {
    const taskTool = createTaskTool(
      createSubAgentExecutor(
        opts,
        allCustomTools,
        adapterTools,
        capabilities,
        compactionConfig,
        1,
        effectiveShell,
        idPort,
        () => currentTurnEventSink,
        opts.chatStore,
        opts.chatSessionId,
        () => turnCounter,
      ),
    );
    allCustomTools.push(taskTool);
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

  // ── Step context ─────────────────────────
  const resolvedReasoningEffort = resolve(opts.reasoningEffort, "reasoningEffort");
  const stepContext: StepContext = {
    tools: toolDefs,
    model: resolve(opts.model, "model"),
    maxTokens: resolve(opts.maxTokens, "maxTokens"),
    temperature: resolve(opts.temperature, "temperature"),
    maxLoopCount: resolve(opts.maxLoopCount, "maxLoopCount"),
    responseFormat: resolve(opts.responseFormat, "responseFormat"),
    permissionConfig,
    id: idPort,
    ...(resolvedReasoningEffort !== undefined
      ? { reasoningEffort: ReasoningEffortId(resolvedReasoningEffort) }
      : {}),
  };

  // ── Compose tool executor ────────────────
  const customToolMap = new Map<string, Tool>();
  for (const t of allCustomTools) {
    customToolMap.set(t.definition.name, t);
  }

  const fsExecutor = opts.fs ? createFsToolExecutor({ fs: opts.fs }) : undefined;
  const shellExecutor = effectiveShell ? createShellToolExecutor({ shell: effectiveShell }) : undefined;
  const networkExecutor = opts.network ? createNetworkToolExecutor({ network: opts.network }) : undefined;

  const toolExecutor: ToolExecutor = async (
    call: PendingToolCall,
    ctx: { readFiles: ReadFileRecord[]; abortSignal?: AbortSignal },
  ): Promise<ToolResult> => {
    if (fsExecutor && FS_TOOL_NAMES.has(call.name)) return fsExecutor(call, ctx);
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

  return {
    ports: resolvedPorts,

    async run(input: string | AgentInput): Promise<ReducerState> {
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
    },

    async *stream(
      input: string | AgentInput,
      streamOpts?: { signal?: AbortSignal },
    ): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
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
        approvalGate,
        sessionStore,
        compaction: compactionConfig,
        sessionId,
        initialState: restoredState,
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

    async dispose(): Promise<void> {
      await effectiveShell?.disposeProcesses?.();
    },
  };
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

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
 * Create a SubAgentExecutor that spins up a fresh Runner with isolated state,
 * shared ModelPort and tools (without task tools to prevent recursion).
 * Sub-agent events are forwarded to the parent's event sink with an
 * `agentDepth` tag so the host can render them separately from the main
 * agent's output.
 */
function createSubAgentExecutor(
  opts: CreateAgentOptions,
  parentCustomTools: Tool[],
  parentAdapterTools: Tool[],
  capabilities: Set<string>,
  compactionConfig?: CompactionConfig,
  depth: number = 1,
  shellOverride?: Shell,
  idPort: Id = defaultId,
  getCurrentEventSink: () => EventSink | undefined = () => undefined,
  chatStore?: TranscriptStore,
  parentChatSessionId?: string,
  getCurrentTurn: () => number = () => 0,
): SubAgentExecutor {
  return async (message: string): Promise<string> => {
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

    if (chatStore && parentChatSessionId && childSessionId) {
      bestEffortAppend(chatStore, parentChatSessionId, [
        {
          time: startedAt,
          type: "subagent_started",
          data: { childSessionId, label: "task", depth },
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
        data: { childSessionId, label: "task", depth },
        turn,
      };
      currentSink?.emit(startedBracket);
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

    const subCustomTools = parentCustomTools.filter(
      (t) => t.definition.name !== "task",
    );
    const subAllTools = [...subCustomTools, ...parentAdapterTools];
    const subToolDefs: ToolDefinition[] = subAllTools.map((t) => t.definition);

    const subCustomToolMap = new Map<string, Tool>();
    for (const t of subCustomTools) {
      subCustomToolMap.set(t.definition.name, t);
    }

    const subFsExecutor = opts.fs ? createFsToolExecutor({ fs: opts.fs }) : undefined;
    const subShellExecutor = shellOverride ? createShellToolExecutor({ shell: shellOverride }) : undefined;
    const subNetworkExecutor = opts.network ? createNetworkToolExecutor({ network: opts.network }) : undefined;

    const subExecutor: ToolExecutor = async (call, ctx) => {
      if (subFsExecutor && FS_TOOL_NAMES.has(call.name)) return subFsExecutor(call, ctx);
      if (subShellExecutor && SHELL_TOOL_NAMES.has(call.name)) return subShellExecutor(call, ctx);
      if (subNetworkExecutor && NETWORK_TOOL_NAMES.has(call.name)) return subNetworkExecutor(call, ctx);
      const tool = subCustomToolMap.get(call.name);
      if (!tool) return { modelContent: `Unknown tool: ${call.name}`, isError: true };
      return tool.handler(call.input);
    };

    const subCapabilities = new Set(capabilities);
    subCapabilities.delete("agent:task");

    // A subagent that keeps skill:load (and the `skill` tool) can only guess
    // skill names without this. Rebuilt per dispatch rather than reusing the
    // parent turn's catalog: correctness (a registry can change mid-session)
    // over the one extra `list()` call per subagent. Deliberately does NOT
    // carry the host's other context layers (project instructions, user
    // memory, …) — plan-015 decided subagents start from a clean context,
    // and widening that is a design change, not this fix's scope.
    const subCatalogLayer = await buildSkillCatalogLayer(opts.skillRegistry, opts.skillCatalogDescriptionMaxLength);

    const resolvedSubReasoningEffort = resolveConfigValue(
      opts.reasoningEffort,
      opts.config?.config,
      "reasoningEffort",
    );
    const subStepContext: StepContext = {
      tools: subToolDefs,
      model: resolveConfigValue(opts.model, opts.config?.config, "model"),
      maxTokens: resolveConfigValue(opts.maxTokens, opts.config?.config, "maxTokens"),
      temperature: resolveConfigValue(opts.temperature, opts.config?.config, "temperature"),
      id: idPort,
      ...(resolvedSubReasoningEffort !== undefined
        ? { reasoningEffort: ReasoningEffortId(resolvedSubReasoningEffort) }
        : {}),
      ...(subCatalogLayer ? { contextLayers: [subCatalogLayer] } : {}),
    };

    // currentSink was read at the top of this dispatch (the brackets emitted
    // there need it before the runner exists); reuse the same snapshot here.
    const taggedSink = currentSink
      ? tagEventSink(currentSink, depth, "task", childSessionId)
      : undefined;

    const subRunner = createRunner({
      modelPort: opts.modelPort,
      stepContext: subStepContext,
      toolExecutor: subExecutor,
      availableCapabilities: subCapabilities,
      permissionConfig: resolveConfigValue(opts.permissionConfig, opts.config?.config, "permissionConfig"),
      approvalGate: createAutoAllowGate(),
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
      // P2-9: inherit parent budget limits so sub-agents respect cost/wallclock caps
      initialState: createInitialState({
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
      if (lastMsg && lastMsg.role === "assistant") {
        return extractPlainText(lastMsg);
      }
      return "";
    } catch (err) {
      finishSubAgent(true);
      throw err;
    }
  };
}
