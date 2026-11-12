/**
 * Runner — thin effect interpreter for the agent core loop.
 *
 * Drives the step(state, input, ctx) → { state, effects[] } cycle,
 * interpreting each Effect by calling the corresponding port adapter.
 * All I/O happens here; the core reducer stays pure.
 */

import type {
  AgentInput,
  AgentState,
  AgentStatus,
  Effect,
  ModelPort,
  VerificationSummary,
  EventSink,
  PendingToolCall,
  ModelEvent,
  ToolResult,
  ToolResultBlock,
  ToolResultContent,
  ContentBlock,
  ImageContent,
  ModelRequestManifest,
  ModelRequestMessage,
  ToolDefinition,
  AttachmentStore,
  ReadFileRecord,
  PermissionConfig,
  SessionStore,
  TranscriptStore,
  TranscriptEventInput,
  TranscriptEventMap,
  ApprovalGate,
  CompactionConfig,
  Message,
  Clock,
  PolicyEngine,
  Telemetry,
  Validator,
  MemoryStore,
  TokenUsage,
  AssistantMessage,
  PricingEntry,
  RiskTier,
  SpillStore,
} from "@volto/core";
import {
  step,
  createInitialState,
  filterVisibleTools,
  routeToolCall,
  resolvePermission,
  hasParameterRules,
  hasCommandRules,
  policyDenialMessage,
  decideCompaction,
  estimateFromAnchor,
  estimateContextLayerTokens,
  estimateToolDefinitionTokens,
  estimateTokens,
  pruneOversizedToolResults,
  renderVerificationNotice,
  classifyError,
  annotateUntrusted,
  decideSelfCorrect,
  assembleContext,
  computeUsageCost,
  totalUsageTokens,
  decideSpill,
  renderSpillReference,
  planImageOffload,
  extractBlockText,
  detectLoop,
  renderLoopReminder,
  renderLoopIntervention,
} from "@volto/core";
import type { PromptAnchorState, StepContext, ReducerState, TurnEndReason } from "@volto/core";
import type { OffloadCandidate } from "@volto/core";
import type { Hook, HookContext } from "@volto/core";
import { runHookPipeline } from "@volto/core";
import { computeRAGInjectionIndex, buildRAGMessage } from "@volto/core";
import { createTranscriptRecorder } from "./transcript-recorder.js";
import { createToolInputFactResolver } from "./tool-input-facts.js";
import * as crypto from "node:crypto";

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

/**
 * Tool executor. Receives the call plus a read-only view of serializable gate
 * state (readFiles) so write-class tools can enforce read-before-edit/staleness
 * before performing any side effect.
 */
export interface ToolExecutorContext {
  readFiles: ReadFileRecord[];
  /** Abort signal from the Runner, for forwarding to cancellable ports (e.g. Network) */
  abortSignal?: AbortSignal;
}
export type ToolExecutor = (call: PendingToolCall, ctx: ToolExecutorContext) => Promise<ToolResult>;

/**
 * Flatten tool-result content to the plain text that string-only consumers
 * (validators) still expect. Only text-bearing blocks are joined —
 * validators inspect textual output, not image refs. Structured blocks
 * contribute their REQUIRED text projection.
 */
function toolResultText(content: string | ToolResultBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" || b.type === "structured" ? b.text : ""))
    .join("\n");
}

/**
 * Annotate untrusted tool output. Block arrays keep their shape so image
 * refs survive; text and structured blocks carry the isolation banner on
 * their text (structured kind/data ride along untouched).
 */
function annotateUntrustedContent(
  content: string | ToolResultBlock[],
): string | ToolResultBlock[] {
  if (typeof content === "string") return annotateUntrusted(content);
  return content.map((b) => {
    if (b.type === "text") return { ...b, text: annotateUntrusted(b.text) };
    if (b.type === "structured") return { ...b, text: annotateUntrusted(b.text) };
    return b;
  });
}

/**
 * Request-surface image block: the base64 bytes a provider needs.
 *
 * Deliberately a Runner-local type, not core's `ImageContent`. Core state
 * only ever holds `{ type: "ref" }` so a snapshot stays small; this wire
 * shape exists only between resolveImageRefs and modelPort.stream(). Adding
 * `"base64"` back into core's ImageContent would give state two shapes again.
 */
export interface WireImageContent {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
  width?: number;
  height?: number;
}

/**
 * Swap AttachmentStore references for the base64 bytes providers expect.
 *
 * Runs on the request surface only: AgentState keeps refs, so a snapshot
 * never carries image bytes. A missing attachment — or a lookup that
 * rejects on I/O failure — degrades to placeholder text and emits a
 * warning: replaying an old session whose files were cleaned up (or a
 * store having a bad day) must not break the loop.
 */
export async function resolveImageRefs(
  messages: Message[],
  store: AttachmentStore,
  eventSink: EventSink,
): Promise<Message[]> {
  const unavailable = (id: string): ContentBlock => {
    eventSink.emit({
      type: "attachment_unavailable",
      data: { id },
    });
    return { type: "text", text: `[image unavailable: ${id}]` };
  };

  const resolveBlock = async (block: ContentBlock): Promise<ContentBlock> => {
    if (block.type !== "image" || block.source.type !== "ref") return block;
    // The port contract allows get() to reject on I/O failure. A rejecting
    // store must degrade exactly like a missing id — same placeholder, same
    // warning — never an unhandled rejection that kills the turn.
    let found: { data: string; mimeType: string } | undefined;
    try {
      found = await store.get(block.source.id);
    } catch {
      return unavailable(block.source.id);
    }
    if (!found) return unavailable(block.source.id);
    // The wire shape is not part of core's ContentBlock union — state stays
    // ref-only. Cast at this boundary; providers narrow on source.type.
    return {
      type: "image",
      source: { type: "base64", mediaType: found.mimeType, data: found.data },
      ...(block.width !== undefined ? { width: block.width } : {}),
      ...(block.height !== undefined ? { height: block.height } : {}),
    } as unknown as ContentBlock;
  };

  return Promise.all(
    messages.map(async (msg) => {
      if (typeof msg.content === "string" || !Array.isArray(msg.content)) return msg;
      const content = await Promise.all(
        msg.content.map(async (block) => {
          if (block.type === "tool_result") {
            // tool_result content is text | image only; resolveBlock on those
            // yields text | wire-image. The wire-image cast is the same
            // request-surface boundary as above.
            const resolved = await Promise.all(block.content.map(resolveBlock));
            return { ...block, content: resolved as ToolResultBlock[] };
          }
          return resolveBlock(block);
        }),
      );
      return { ...msg, content } as Message;
    }),
  );
}

/**
 * Collapse a raw string into a single storage-path segment: any character
 * outside the safe set becomes "-", and dot runs are collapsed so a
 * messageId containing ".." can never produce a traversal segment (the
 * store's isValidSegment would reject it and the image would degrade).
 */
function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, ".");
}

/**
 * Deterministic AttachmentStore id for an offload candidate (spec D4):
 * the message id plus the container-local idSuffix, sanitized to one
 * segment. Same replaced span ⇒ same id sequence across reruns/replays —
 * a re-compaction overwrites the same slot instead of minting a new uuid.
 */
export function deriveDeterministicId(candidate: OffloadCandidate): string {
  const cleaned = sanitizeSegment(`${candidate.messageId}-${candidate.idSuffix}`);
  return cleaned === "" ? `img-${candidate.idSuffix}` : cleaned;
}

/**
 * Oversized tool-result spill configuration (T5).
 *
 * When set, the Runner intercepts string tool results AFTER the
 * postToolUse hook and BEFORE they are fed to the reducer: core decides
 * purely (`decideSpill`), the injected store persists the full text, and
 * the model sees only the kept head plus a text reference pointing at the
 * spill file.
 *
 * Defaults: `thresholdChars` 16_000 (code points; at or below it a result
 * passes through untouched) and `headChars` 2_000 (code points kept
 * inline). Code-point semantics come from `decideSpill` — never UTF-16
 * units.
 *
 * Exemptions (all pass through untouched, zero store writes):
 * - `isError: true` results;
 * - `modelContent` given as a block array (not a string) — image refs
 *   must survive;
 * - a missing `spill` / `spill.store` on the Runner — zero behavior
 *   change.
 *
 * Degradation (spec §6): a store `write` that throws never interrupts
 * the loop — the Runner emits a `spill_failed` EventSink event and
 * returns the ORIGINAL result untouched.
 */
export interface SpillConfig {
  /** Injected persistence port; `write` throws on I/O failure (caller degrades). */
  store: SpillStore;
  /** Code-point count at or below which a result passes through untouched. Default 16_000. */
  thresholdChars?: number;
  /** Code points kept inline as the head when spilling. Default 2_000. */
  headChars?: number;
}

export interface RunnerOptions {
  modelPort: ModelPort;
  stepContext: StepContext;
  eventSink?: EventSink;
  toolExecutor?: ToolExecutor;
  abortSignal?: AbortSignal;
  initialState?: ReducerState;
  availableCapabilities?: Set<string>;
  /**
   * Risk ceiling for visible-set filtering. Tools whose riskTier ranks above
   * it are pruned from the model's visible tool set before any call happens
   * (filterVisibleTools) — the model never sees them, rather than seeing them
   * refused. Hosts derive it from the session's sandbox mode via `ceilingOf`.
   * Omit for no ceiling (capability gating still applies).
   */
  riskCeiling?: RiskTier;
  /**
   * The workspace root a model-supplied relative path resolves against —
   * i.e. what the FileSystem port was constructed with. Required for
   * `pathPattern` rules to mean anything; must be the same root the sandbox
   * decorator was given, or the permission layer and the boundary would
   * resolve the same relative target differently.
   */
  pathRoot?: string;
  /** Permission policy — if set, tools are checked before execution */
  permissionConfig?: PermissionConfig;
  /** Session store for checkpoint/resume persistence */
  sessionStore?: SessionStore;
  /** Session ID for checkpoint persistence */
  sessionId?: string;
  /** Durable transcript/trajectory store — mirrors sessionStore's optionality; a missing chatStore just means no durable record is kept. */
  chatStore?: TranscriptStore;
  /** The chatStore's session id — distinct from `sessionId` above, which is regenerated per turn for HITL checkpointing. This one is the host's stable, whole-conversation id. */
  chatSessionId?: string;
  /** This turn's ordinal within the whole conversation (tracked by the SDK across turns). Defaults to 0 when omitted. */
  turn?: number;
  /**
   * Seeds the step counter — the highest step number already persisted for
   * this turn in the durable transcript. The first model call this Runner
   * makes is then recorded as `initialStep + 1` instead of 1.
   *
   * A host that rebuilds a Runner mid-turn for a cross-process resume must
   * pass it: a fresh Runner's step counter otherwise restarts at 1 and its
   * events collide with the paused turn's existing steps 1..N in the same
   * turn, so a projection merges/overwrites distinct model calls. Omit for a
   * brand-new turn (the default 0 makes the first step 1, as always).
   *
   * Known limitation: an in-process fallback resume on a REPLACED lastRunner
   * seeds from the option captured at construction, which can go stale for a
   * turn that paused after later turns ran (a step gap); the primary
   * cross-process rebuild path is always fresh.
   */
  initialStep?: number;
  /**
   * The conversation's seed system prompt, mirrored into request_header's
   * `systemLayers` so the transcript shows it. Never added to the model
   * request — the seed `{role:"system"}` message already handles that;
   * putting it in stepContext.contextLayers would make the ContextAssembler
   * emit a second system message and the model would see the prompt twice.
   */
  seedSystemPrompt?: string;
  /**
   * Cross-turn holder for the last recorded request_header hash (the same
   * sharing pattern as promptAnchor). The static prefix usually survives
   * many turns, so a matching hash skips the duplicate transcript write —
   * one context row in the trajectory, not one per turn. A genuinely
   * changed prefix (new tools, a new layer) hashes differently and still
   * gets its own record.
   */
  headerHashState?: { hash?: string };
  /** Approval gate for HITL interaction (auto-allow or interactive) */
  approvalGate?: ApprovalGate;
  /** Compaction config — enables automatic context compression when messages grow large */
  compaction?: CompactionConfig;
  /**
   * Provider-usage anchor shared by the per-turn Runners of one agent
   * instance. The Runner updates it after each successful model call and
   * clears it whenever compaction or pruning rewrites the surface; a host
   * that omits it gets a fresh anchor per Runner (still correct, just no
   * cross-turn reuse).
   */
  promptAnchor?: PromptAnchorState;
  /**
   * Cache breakpoints — message indices where provider-side prompt cache
   * should be anchored. Passed through to ModelRequest for provider translation.
   */
  cacheBreakpoints?: number[];
  /**
   * Clock for checkpoint timestamps. Inject a seeded Clock for deterministic
   * runner-level replay; defaults to wall-clock (Date.now) when omitted.
   */
  clock?: Clock;
  /**
   * External policy engine for authorization decisions.
   * When provided, evaluated alongside core PermissionPolicy (most restrictive wins).
   * Fail-closed: if PolicyEngine evaluation throws, decision defaults to "deny".
   */
  policyEngine?: PolicyEngine;
  /**
   * Structured telemetry (OTel-style).
   * Runner instruments turn / model / tool call span boundaries.
   * Defaults to undefined (no-op); SDK resolves defaultTelemetry.
   */
  telemetry?: Telemetry;
  /**
   * Per-model pricing table for cost metrics.
   * Key: model name; value: cost per million tokens (input/output/cache).
   * When provided, Runner records `cost_usd` metric on model call spans.
   */
  pricing?: Record<string, PricingEntry>;
  /**
   * Structured audit sink for approval decisions and high-risk tool executions.
   * When provided, Runner records audit entries for HITL decisions and
   * WRITE_HIGH/IRREVERSIBLE tool executions.
   */
  auditSink?: AuditSink;
  /**
   * Lifecycle hooks — called at session:start/end, turn:start/end,
   * preToolUse (after permission, before executor), postToolUse (after result).
   * preToolUse hooks can deny (→ normalized tool_result isError) or modify input.
   * postToolUse hooks can modify tool result before it's fed to the reducer.
   */
  hooks?: Hook[];
  /**
   * Validators run against tool results after execution. If any validator fails
   * and the self-correction budget allows, the Runner injects a repair prompt
   * as a user_message so the model can retry. Empty array = no self-correction.
   */
  validators?: Validator[];
  /**
   * Maximum self-corrections per turn. When a validator fails and this budget
   * remains, the Runner injects a repair prompt and loops. When exhausted, the
   * budget-exhausted error is included in the final result.
   * Default 0 = self-correction disabled.
   */
  selfCorrectionMax?: number;
  /**
   * Retry policy for retriable model errors. Exponential backoff with
   * circuit breaker. Undefined = no retries (backward compat).
   */
  retryPolicy?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    circuitBreakerThreshold?: number;
  };
  /**
   * RAG pipeline — when configured, queries MemoryStore before the turn's
   * first model call and injects retrieved fragments into every model call's
   * message array without breaking the static prefix cache.
   *
   * The retrieval is cached per runner (one runner = one turn): the store is
   * queried once and the rendered text is reused on subsequent model calls.
   */
  rag?: {
    memoryStore: MemoryStore;
    topK?: number;
    queryBuilder?: (messages: Message[]) => string;
    /**
     * Project scope for the query filter (host passes chatMeta.projectId).
     * With a projectId the filter means "this project + global" (unless
     * includeGlobal is false). Without one the filter is global-only — never
     * every project (spec 2026-10-20 §4.5 / §4.1).
     */
    projectId?: string;
    /**
     * Whether global-scope entries join the project result. Defaults to true.
     * Only meaningful together with projectId; omitted, it still rides the
     * filter explicitly so the store sees the resolved value.
     */
    includeGlobal?: boolean;
  };
  /**
   * Attachment store for image bytes. When set, the Runner resolves
   * AttachmentStore refs into base64 on the request surface just before
   * calling the model — state keeps the refs, providers get the bytes.
   */
  attachmentStore?: AttachmentStore;
  /**
   * Registry of detached background sub-agent tasks. When present, a turn
   * that would end (model stopReason "end_turn") with tasks still `running`
   * in state drains them first — see drainBackgroundTasks. The SDK's
   * BackgroundRegistry satisfies this shape structurally.
   */
  backgroundRegistry?: BackgroundTaskCollector;
  /**
   * Oversized tool-result spill (T5). See {@link SpillConfig} for the
   * defaults (thresholdChars 16_000 / headChars 2_000), the exemptions
   * (isError / block-array content / missing config), and the degradation
   * contract (failed write → `spill_failed` event, original result
   * untouched). Omit for zero behavior change.
   */
  spill?: SpillConfig;
}

/**
 * Result of a successful {@link Runner.compactNow} call.
 * `replacedCount` is the number of messages replaced by the summary
 * (0 when only oversized tool results were pruned);
 * `tokensFreedEstimate` is the tokenizer-based before/after delta.
 */
export interface CompactNowResult {
  replacedCount: number;
  tokensFreedEstimate: number;
}

/**
 * Thrown by {@link Runner.compactNow} when the agent is mid-turn
 * (calling_model / executing_tools / waiting_for_approval / …).
 * Carries the offending status so hosts can map it to an HTTP 409.
 */
export class CompactionBusyError extends Error {
  readonly code = "busy" as const;
  constructor(readonly status: AgentStatus) {
    super(`compaction busy: agent status is ${status}`);
    this.name = "CompactionBusyError";
  }
}

/**
 * Character cap for the rendered RAG injection (spec 2026-10-20 §4.5).
 * The `buildRAGMessage` output is sliced so the total injected text —
 * including the marker below — never exceeds this cap.
 */
/** Truncate by code point so surrogate pairs (emoji) are never split. */
function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

const RAG_MAX_CHARS = 4000;
/** Appended to the RAG injection when it had to be cut at RAG_MAX_CHARS. */
const RAG_TRUNCATION_MARKER = "\n(truncated)";

export interface Runner {
  run(initialInput: AgentInput): Promise<ReducerState>;
  getState(): ReducerState;
  /** The most recently closed turn's outcome, for callers that need to know
   *  whether a resolved run() ended in error rather than normal completion. */
  getLastTurnEnd(): { reason: TurnEndReason; error?: string } | undefined;
  /** Resume from a checkpoint with an approval decision */
  resume(sessionId: string, decision: "allow" | "deny"): Promise<ReducerState>;
  /**
   * Feed an input into the turn currently in flight — e.g. a user message
   * typed while the model is still working ("steering"). Unlike `run()`,
   * this does not start a new turn: it does not reset budget tracking, run
   * session/turn hooks, or record turn_start/turn_end. The reducer alone
   * decides what happens with the input for the current status (typically
   * queuing it and emitting steering_queued); an input that makes no sense
   * for the current status is normalized to an error emit like any other
   * invalid input, never thrown.
   *
   * Two boundary behaviors:
   * - Sent before the turn opened (run() has not fed its initial input yet):
   *   a turn-opening input (user_message / steering_flush / file_changed) is
   *   held and fed right after the open, so it queues behind the opening
   *   input instead of opening the turn itself. steering_edit /
   *   steering_remove pass through immediately (they never open a turn and
   *   must beat the opening flush).
   * - Sent after the run loop ended: the recorder is flushed
   *   fire-and-forget so the record still reaches the durable transcript.
   */
  send(input: AgentInput): void;
  /**
   * Run the same prune + summarize + write-back path the automatic
   * pre-request compaction uses, but on demand while the agent is idle.
   *
   * - Status must be `idle` or `done`; anything else throws
   *   {@link CompactionBusyError}.
   * - Returns `null` when there is no compaction config, or when no
   *   write-back landed (under threshold / nothing useful can be
   *   compressed). A prune-only pass is a write-back: it returns
   *   `replacedCount: 0` with a positive `tokensFreedEstimate`.
   * - On success, `state.messages` is rewritten in place (via the same
   *   `feed()` path) and the result reports how many messages were
   *   replaced and the estimated token savings.
   */
  compactNow(): Promise<CompactNowResult | null>;
}

/** Structured audit entry for approval decisions and high-risk tool executions. */
export interface AuditEntry {
  kind: "approval" | "high_risk_exec" | "rule_allow";
  toolName: string;
  riskTier?: string;
  decision?: "allow" | "deny";
  timestamp: number;
  isError?: boolean;
  sessionId?: string;
  /** For `rule_allow`: a compact summary of the rule that matched. */
  ruleSummary?: string;
  /** For `rule_allow`: the command text the rule matched. */
  commandText?: string;
}

/** Sink for audit entries — records structured audit data. */
export interface AuditSink {
  record(entry: AuditEntry): void;
}

/** No-op audit sink — entries are discarded. */
export const defaultAuditSink: AuditSink = {
  record(): void {},
};

/**
 * Structural view of the SDK's BackgroundRegistry that the turn-boundary
 * drain needs. runtime-node must not depend on @volto/sdk (dependency
 * direction: core ← runtimes ← sdk), so the shape is restated here; the
 * SDK registry satisfies it structurally.
 */
export interface BackgroundTaskCollector {
  collect(
    taskId: string,
  ): Promise<
    | {
        text: string;
        childSessionId?: string;
        /** Acceptance verdict carried by a verified dispatch (Task 7 SDK envelope). */
        verification?: VerificationSummary;
        /** True when the final verdict failed after exhausting reworks. */
        rejected?: boolean;
      }
    | { error: string }
  >;
  /**
   * True when this id's result was already collected — e.g. the model
   * picked it up mid-turn via the task_output tool. The drain skips those
   * ids: their result already reached the model as a tool_result, and
   * feeding a completion here would deliver it a second time. Optional so
   * a minimal registry (or test double) without the flag still drains.
   */
  isCollected?(taskId: string): boolean;
}

/**
 * Collect every background task the model has not picked up before the turn
 * is allowed to end.
 *
 * A resumed Runner holds no handles, so an uncollectable task is failed with
 * an explanation instead of awaited: leaving it pending would deadlock the
 * turn, and dropping it silently would let the model believe it is still
 * running.
 */
export async function drainBackgroundTasks(opts: {
  state: AgentState;
  registry: BackgroundTaskCollector;
  feed: (input: AgentInput) => void;
}): Promise<void> {
  const running = (opts.state.backgroundTasks ?? []).filter((t) => t.status === "running");
  if (running.length === 0) return;

  for (const task of running) {
    // Double-feed guard (Task 8 concern): task_output collection updates
    // only the registry cache, never state.backgroundTasks.status — state
    // still says "running" after the model holds the result. An id the
    // registry has already collected is skipped here. An id the registry
    // never knew (a resumed Runner's ghost) is NOT "collected": collect()
    // fails it with an explanation, which is exactly what F-036 wants.
    if (opts.registry.isCollected?.(task.id) === true) continue;

    let result:
      | { text: string; childSessionId?: string; verification?: VerificationSummary; rejected?: boolean }
      | { error: string };
    try {
      result = await opts.registry.collect(task.id);
    } catch (err) {
      // Error isolation: a collector that throws anyway fails the task
      // with an explanation rather than taking the turn down.
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    if ("error" in result) {
      opts.feed({
        type: "background_task_completed",
        taskId: task.id,
        text: result.error,
        isError: true,
      });
    } else {
      // This is the path where the model never called task_output: a
      // failed acceptance verdict must not arrive as an ordinary
      // completion, so the drain prefixes the verdict notice and flips
      // the input to an error when the SDK marked the task rejected.
      const text =
        result.verification === undefined
          ? result.text
          : renderVerificationNotice(result.verification) + "\n" + result.text;
      opts.feed({
        type: "background_task_completed",
        taskId: task.id,
        ...(result.childSessionId === undefined ? {} : { childSessionId: result.childSessionId }),
        text,
        ...(result.rejected === true ? { isError: true } : {}),
      });
    }
  }
}

// ──────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────

/**
 * A loop-ladder tier collected at a model_done decision site and fired only
 * after the batch's tool_results are fed (spec 2026-10-16 D2). The literal
 * discriminants/flags are part of the input contract — the reducer's
 * handlers branch on them exactly as written.
 */
type PendingLoopInjection = Extract<AgentInput, { type: "loop_reminder" | "loop_intervention" }>;

function manifestImage(
  source: ImageContent["source"],
  width?: number,
  height?: number,
): { id: string; mediaType: string; width?: number; height?: number } {
  return {
    id: source.type === "ref" ? source.id : "inline",
    mediaType: source.mediaType,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function manifestMessage(message: Message): ModelRequestMessage {
  if (typeof message.content === "string") {
    return {
      id: message.id,
      role: message.role,
      blocks: ["text"],
      textChars: message.content.length,
    };
  }
  const blocks: string[] = [];
  const toolUseIds: string[] = [];
  const toolResultIds: string[] = [];
  const imageRefs: Array<{ id: string; mediaType: string; width?: number; height?: number }> = [];
  let textChars = 0;

  const scan = (block: ContentBlock | ToolResultContent): void => {
    blocks.push(block.type);
    if (block.type === "text" || block.type === "structured") {
      textChars += block.text.length;
    } else if (block.type === "image") {
      imageRefs.push(manifestImage(block.source, block.width, block.height));
    } else if (block.type === "tool_use") {
      toolUseIds.push(block.id);
    } else if (block.type === "tool_result") {
      toolResultIds.push(block.toolUseId);
      for (const nested of block.content) scan(nested);
    }
  };
  for (const block of message.content) scan(block);

  return {
    id: message.id,
    role: message.role,
    blocks,
    ...(textChars > 0 ? { textChars } : {}),
    ...(toolUseIds.length > 0 ? { toolUseIds } : {}),
    ...(toolResultIds.length > 0 ? { toolResultIds } : {}),
    ...(imageRefs.length > 0 ? { imageRefs } : {}),
  };
}

/** Structural, byte-free snapshot of one model request. */
function buildRequestManifest(
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  headerHash: string,
  model: string | undefined,
  temperature: number | undefined,
  maxTokens: number | undefined,
): ModelRequestManifest {
  return {
    headerHash,
    ...(model !== undefined ? { model } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    toolNames: tools.map((tool) => tool.name),
    messages: messages.map(manifestMessage),
  };
}

export function createRunner(opts: RunnerOptions): Runner {
  // Validate: permissionConfig requires approvalGate (otherwise "ask" decisions hang)
  if (opts.permissionConfig && !opts.approvalGate) {
    throw new Error(
      "permissionConfig requires an approvalGate to handle 'ask' decisions. " +
      "Configure an ApprovalGate or remove permissionConfig.",
    );
  }

  let state: ReducerState = {
    ...(opts.initialState ?? createInitialState()),
    selfCorrectionCount: 0,
    maxSelfCorrections: opts.selfCorrectionMax,
  };
  let cancelled = false;
  // Tool call ids that have already cleared an HITL "ask" (decision = allow).
  const approvedToolCallIds = new Set<string>();
  // Tool call ids the user has already denied via HITL "ask". A denied tool
  // stays on `pendingTools` (the reducer keeps it on the roster so a mixed
  // batch can still flush once its siblings resolve — see
  // handleWaitingForApproval's deny branch) so the partition loop below sees
  // it again on the next pass. Without tracking denials the same way allows
  // are tracked, that re-classification would push it back into the approval
  // queue and re-prompt the gate for a decision that was already made.
  const deniedToolCallIds = new Set<string>();
  // Tool call ids for which an `approval_asked` transcript record has already
  // been written by THIS Runner instance. Guards the common in-process HITL
  // flow — request_approval writes the record while `run()` is still on the
  // stack, then `resume()` is called on the very same Runner (the SDK tries
  // `lastRunner.resume()` first) — from writing a second, slightly different
  // `approval_asked` record for the same callId. A fresh Runner instance
  // (the SDK's cross-process fallback, which constructs a brand-new Runner
  // from a loaded checkpoint) starts with an empty set, so that path still
  // writes the record — it may be the only copy that ever reaches the store
  // if the original process never flushed.
  const askedToolCallIds = new Set<string>();
  // M8 Phase 4: wallclock and cost tracking for the current turn
  let turnStartTime = 0;
  let cumulativeCost = 0;
  let cumulativeTokens = 0;
  // M12 Phase 1: track whether this turn encountered any model/tool error
  let turnHadError = false;
  // Why the turn ended, when it ended without the model finishing normally
  // (iteration/tool-call/token cap, loop guard, budget, truncated stream).
  // Carried into turn_end.error: the raw reducer `error` events are unstamped
  // and never persisted, so without this the durable transcript (and
  // therefore a page reload) shows a clean "done" for a turn that was
  // actually cut off. First writer wins — a later, unrelated error must not
  // overwrite the reason the turn actually closed.
  let turnTerminalError: string | undefined;
  /** Last closed turn's reason, exposed to embedders such as sub-agent dispatch. */
  let lastTurnEnd: { reason: TurnEndReason; error?: string } | undefined;
  // Track whether this turn ended because a budget was exceeded — a more
  // specific turn_end reason than "error", checked first when both could
  // apply (the budget check can fire after a turn has already seen an error).
  let turnHadBudgetExceeded = false;
  // True only while runLoop() is executing (run()/resume() bracket it). A
  // send() landing outside that span has no loop left to flush the recorder
  // for it — see the flush guard in send().
  let runLoopActive = false;
  // True once the turn is open (run() has fed its initial input, or resume()
  // continued the paused turn). Inputs sent before that would hit the
  // reducer's idle handler and OPEN the turn themselves (scrambling the
  // order against the real opening input), so send() holds them in
  // preOpenQueue until the open drains them — right after the opening feed,
  // where the reducer queues them (D4) instead.
  let turnOpened = false;
  const preOpenQueue: AgentInput[] = [];

  /** Feed everything send() buffered before the turn opened (FIFO). */
  function drainPreOpenQueue(): void {
    while (preOpenQueue.length > 0) {
      forwardEmit(feed(preOpenQueue.shift()!));
    }
  }
  // M12 Phase 4: checkpoint history sequence counter
  let checkpointSeq = 0;
  // Retry state for retriable model errors
  let consecutiveModelErrors = 0;

  // Sequential step counter for this turn — one per model call, 1-based.
  // Resets naturally each turn since a fresh Runner instance is created per
  // turn. Seeded from `initialStep` when the host is resuming a turn whose
  // earlier steps are already in the transcript — see RunnerOptions.initialStep.
  let stepCounter = opts.initialStep ?? 0;
  // Loop-ladder tier (spec 2026-10-16 D2) collected when a model_done
  // tool_use is fed — the reducer books the tier (loopRemindedCount /
  // loopInterventionCount / hard termination), the Runner fires the input.
  // Exactly one item can be pending per batch: the decision site overwrites
  // it on every model_done, the post-batch site fires or clears it.
  let pendingLoopInjection: PendingLoopInjection | null = null;
  // Hash of the last request_header written for this conversation; a
  // matching hash means the static prefix has not changed and need not be
  // written again. Seeded from the cross-turn holder so a fresh per-turn
  // Runner keeps skipping records for a prefix an earlier turn already
  // logged (one context row in the trajectory, not one per turn).
  let lastHeaderHash: string | null = opts.headerHashState?.hash ?? null;
  // Provider-usage anchor for compaction pressure. Shared with other
  // per-turn Runners through RunnerOptions.promptAnchor; never serialized.
  const promptAnchorState: PromptAnchorState = opts.promptAnchor ?? {};
  // One calibration observation per turn (a fresh Runner is created per turn).
  let calibrationEmitted = false;
  // RAG retrieval cache — one runner serves exactly one turn (opts.turn is
  // fixed at construction), so the store is queried ONCE and every later
  // model call of this turn reuses the same rendered text. `ragCacheComputed`
  // stays false when the query returned nothing or failed, so a later call
  // does not re-query an empty/failed result either (spec 2026-10-20 §5.2).
  let ragCacheComputed = false;
  let ragCacheText = "";
  let ragCacheFragmentCount = 0;
  let ragCacheMemoryIds: string[] = [];
  // One context_reminder per turn, not per model call: a tool-loop turn
  // injects the same cached text several times, and the audit trail should
  // record the retrieval once (spec 2026-10-20 memory-rag §5.2).
  let ragReminderRecorded = false;
  // Timing/aggregation state for the in-flight model call. Hoisted here
  // (rather than declared inside runModelStream) because forwardEmit() reads
  // them when it intercepts the model_done emit to record assistant_message —
  // and forwardEmit is defined outside runModelStream. Reset at the top of
  // each runModelStream() call.
  let callStartedAt = 0;
  let firstDeltaAt: number | undefined;

  const nowMs = (): number => opts.clock?.now() ?? Date.now();

  /**
   * Accumulate one reported usage into the turn's raw-token and cost totals.
   * Shared by the main model loop and the compaction summarizer: a summary
   * call spends real tokens, so it must count against the same budgets
   * instead of being invisible to them.
   */
  function accumulateUsage(usage: TokenUsage): void {
    // Raw tokens always accumulate, regardless of pricing — includes cache
    // tokens, since input+output alone can undercount a cache-heavy turn.
    cumulativeTokens += totalUsageTokens(usage);
    // Cost: dollar pricing when available, else the pre-existing raw-token
    // fallback (a documented conflation — cumulativeCost is compared against
    // maxCostDollars, a dollar figure, but the fallback adds token counts).
    // Kept as-is; this refactor only shares it with the summarizer.
    if (opts.pricing && stepContext.model) {
      const entry = opts.pricing[stepContext.model];
      cumulativeCost += entry ? computeUsageCost(entry, usage) : totalUsageTokens(usage);
    } else {
      cumulativeCost += totalUsageTokens(usage);
    }
  }

  const recorder = createTranscriptRecorder({
    store: opts.chatStore,
    sessionId: opts.chatSessionId,
    turn: opts.turn ?? 0,
    now: nowMs,
    // Task R6 double write: every event the recorder stamps is streamed to
    // the EventSink — the same data and the same time/turn/step that get
    // persisted — so the live SSE path and the durable log are isomorphic.
    emit: opts.eventSink ? (event) => opts.eventSink!.emit(toSinkEvent(event)) : undefined,
  });

  const availableCapabilities = opts.availableCapabilities ?? new Set<string>();
  const visibleTools = filterVisibleTools(
    opts.stepContext.tools,
    availableCapabilities,
    opts.riskCeiling,
  );
  const stepContext: StepContext = {
    ...opts.stepContext,
    tools: visibleTools,
  };

  const onAbort = (): void => { cancelled = true; };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      cancelled = true;
    } else {
      opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  /** Feed an input to the pure reducer, update state, return effects. */
  function feed(input: AgentInput): Effect[] {
    const result = step(state, input, stepContext);
    state = result.state;
    return result.effects;
  }

  /**
   * Decide which loop-ladder tier (spec 2026-10-16 D2), if any, this batch's
   * model_done fired. MUST mirror the reducer's model_done ladder
   * (reducer.ts tool_use branch) byte for byte — same dual-probe inputs
   * (prior messages + the batch's tool calls), K probe first and the K-1
   * probe only when nothing reached K and K >= 3 — or injection tiers and
   * reducer bookkeeping diverge.
   *
   * @param priorMessages message history BEFORE the model_done feed (the
   *   exact `state.messages` the reducer's probe sees)
   * @param preRemindedCount `state.loopRemindedCount` BEFORE the feed —
   *   a value increase after the feed means the reducer booked a fresh
   *   reminder tier for this batch (its once-only `loopRemindedCount <
   *   consecutiveCount` guard), which is precisely when the Runner fires.
   *
   * Called AFTER the model_done feed so the budget gate can read the
   * resulting state: an exhausted budget hard-terminated the turn inside the
   * feed (status left executing_tools), so firing optimistically here is safe.
   */
  function decideLoopInjection(
    priorMessages: Message[],
    preRemindedCount: number,
  ): PendingLoopInjection | null {
    // Hard termination (budget exhausted) or a limit stop: nothing to inject.
    if (state.status !== "executing_tools") return null;
    const k = stepContext.maxLoopCount;
    if (k === undefined || k < 2) return null;
    const newToolCalls = state.pendingTools;
    const currentAssistantMsg = state.messages[state.messages.length - 1];
    if (newToolCalls.length === 0 || currentAssistantMsg?.role !== "assistant") return null;

    // Dual-probe mirror of the reducer ladder (byte-identical calls).
    let loopResult = detectLoop(priorMessages, currentAssistantMsg, newToolCalls, k);
    if (!loopResult.detected && k >= 3) {
      loopResult = detectLoop(priorMessages, currentAssistantMsg, newToolCalls, k - 1);
    }
    if (!loopResult.detected || loopResult.toolName === undefined) return null;
    const { toolName, consecutiveCount } = loopResult;

    // Fresh reminder tier booked by the reducer during this very feed:
    // error chain at exactly K-1 (K >= 3), or a repeat chain reaching K.
    // The reducer's monotonic guard makes each count tier once-only, so the
    // before/after comparison is exactly its `loopRemindedCount <
    // consecutiveCount` condition re-evaluated across the feed.
    if (state.loopRemindedCount > preRemindedCount) {
      return {
        type: "loop_reminder",
        repairPrompt: renderLoopReminder({
          toolName,
          consecutiveCount,
          kind: loopResult.kind === "repeat" ? "repeat" : "error",
        }),
        consumesBudget: false,
      };
    }

    // Intervention tier: error chain at/over K with budget remaining. The
    // gate reads the SAME config the reducer reads (StepContext
    // .maxLoopInterventions, default 2); exhaustion already hard-terminated
    // above, so no separate exhaustion re-derivation is needed here. Repeat
    // chains never reach this branch (kind !== "error-loop") — spec D4.
    if (
      loopResult.kind === "error-loop" &&
      consecutiveCount >= k &&
      state.loopInterventionCount < (stepContext.maxLoopInterventions ?? 2)
    ) {
      return {
        type: "loop_intervention",
        repairPrompt: renderLoopIntervention({ toolName, consecutiveCount }),
        consumesBudget: true,
      };
    }
    return null;
  }

  /**
   * T10 Task 3 — notification hook (spec 2026-10-17, D3 / F-033): observe-
   * only point on runner system events — `budget_warning` before a
   * budget_exceeded feed, `approval_requested` before an approval ask
   * reaches the gate.
   *
   * OBSERVE-ONLY: the pipeline is awaited and then its outcome is IGNORED
   * entirely — anti-hijack by design (spec D3). A hook can watch system
   * events but can never alter, delay-forever (timeout is Task 2's fail-
   * closed layer), or swallow them. Do not "fix" this by consuming the
   * outcome.
   */
  async function runNotificationHook(
    kind: "budget_warning" | "approval_requested",
  ): Promise<void> {
    await runObserveOnlyHook("notification", {
      sessionId: opts.sessionId,
      notification: { kind },
    });
  }

  /**
   * Shared invocation for the two OBSERVE-ONLY hook points
   * (`subagentStop`, `notification`) — spec 2026-10-17 §6: a failed
   * observation must not vanish silently (the "illusion of working" the
   * spec warns against), but an observe-only point has no deny surface, so
   * failures surface as a raw `hook_error` EventSink event (same
   * observability-only channel shape as `preCompact_skipped`) and NEVER as
   * a deny — state is unchanged, the turn continues. Two failure shapes:
   *  - a THROWN handler error (custom JS hooks; the pipeline propagates
   *    handler throws) — caught here so one broken observer cannot break
   *    the turn;
   *  - a `deny` outcome — command hooks never throw (they resolve
   *    fail-closed denies on timeout / non-zero exit); at an observe-only
   *    point a deny means the hook FAILED to do its observational job, so
   *    it is reported as `hook_error` with the deny reason.
   */
  async function runObserveOnlyHook(
    lifecycle: "subagentStop" | "notification",
    ctx: Omit<HookContext, "lifecycle">,
  ): Promise<void> {
    try {
      const outcome = await runHookPipeline(opts.hooks ?? [], lifecycle, ctx);
      if (outcome.action === "deny") {
        opts.eventSink?.emit({
          type: "hook_error",
          data: { lifecycle, error: outcome.reason },
        });
      }
    } catch (err) {
      opts.eventSink?.emit({
        type: "hook_error",
        data: {
          lifecycle,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  /**
   * Check wallclock and cost budget limits at the Runner level.
   * Feeds a budget_exceeded input if limits are breached.
   * Returns true if a budget_exceeded was fed (caller should break/return).
   */
  async function checkBudgetLimits(): Promise<boolean> {
    if (state.status === "done" || state.status === "idle") return false;

    if (turnStartTime > 0 && state.maxWallclockMs !== undefined) {
      const elapsed = Date.now() - turnStartTime;
      if (elapsed > state.maxWallclockMs) {
        await runNotificationHook("budget_warning");
        forwardEmit(feed({ type: "budget_exceeded", reason: "Wallclock limit exceeded" }));
        return true;
      }
    }

    if (state.maxCostDollars !== undefined && cumulativeCost > state.maxCostDollars) {
      await runNotificationHook("budget_warning");
      forwardEmit(feed({ type: "budget_exceeded", reason: "Cost budget exceeded" }));
      return true;
    }

    if (state.maxTokensPerTurn !== undefined && cumulativeTokens > state.maxTokensPerTurn) {
      await runNotificationHook("budget_warning");
      forwardEmit(feed({ type: "budget_exceeded", reason: "Token budget exceeded" }));
      return true;
    }

    return false;
  }

  /**
   * Forward reducer emit effects onto the wire, translating each event into
   * the transcript vocabulary when it has one.
   *
   * Since task-r6 the EventSink carries transcript events (the same stamped
   * `{time, type, data, turn?, step?}` the recorder persists — the recorder's
   * `emit` hook performs the double write) plus the streaming delta
   * increments. The reducer's own raw vocabulary is therefore NOT forwarded
   * verbatim for events that have a transcript twin:
   *   - model_done → assistant_message
   *   - tool_use_complete → tool_call
   *   - tool_result → tool_result (transcript shape)
   *   - budget_exceeded / steering_queued / steering_delivered /
   *     steering_edited / steering_removed / context_reminder → same-name
   *     transcript events
   *   - user_message (only ever emitted for the initial idle feed) → covered
   *     by the runner-originated record at run(), which now streams too
   * Delta increments (text_delta / reasoning_delta / tool_use_delta) ride raw
   * — they are not transcript events and are never persisted. A few raw
   * events have no transcript counterpart (error / cancelled);
   * they keep flowing for observability (see the report for the decision
   * table).
   */
  function forwardEmit(effects: Effect[]): void {
    // The reducer closes a turn by emitting `done`. An `error` emit in that
    // same batch is therefore the reason the turn is ENDING, not a transient
    // observation: a retriable model_error is fed WITHOUT `done` and the turn
    // continues. Only terminal errors need a durable record — they are the
    // sole trace of a turn that stopped without the model finishing, and
    // turn_end.error is the transcript field that carries it.
    const endsTurn = effects.some((e) => e.type === "done");
    for (const e of effects) {
      if (e.type !== "emit") continue;

      const event = e.event;
      switch (event.type) {
        case "text_delta":
        case "reasoning_delta":
        case "tool_use_delta":
          // Streaming increments: raw on the wire, never recorded.
          opts.eventSink?.emit(event);
          continue;

        case "user_message":
          // The reducer emits this only when the initial input (fed from
          // run()) enters from idle. run() records — and therefore streams —
          // the transcript user_message at the same logical moment; emitting
          // this raw twin would duplicate it on the wire.
          continue;

        case "steering_queued":
          // steering_queued is the one transcript event the Runner cannot
          // observe directly: whether a mid-turn user_message is queued or
          // starts a new turn is decided inside the reducer. Duplicating that
          // branch here would drift; intercepting the event keeps the reducer
          // the single source. The stamped id rides along so projections can
          // match the entry to its steering_delivered.
          recorder.record("steering_queued", {
            id: event.data["id"] as string,
            content: event.data["content"] as TranscriptEventMap["steering_queued"]["content"],
          });
          // Flush now, not at the batch boundary: the durable queue is what a
          // mid-turn `GET /sessions/:id` folds for a client that just
          // reconnected, and a long tool call can hold the batch open for
          // minutes. A refresh inside that window must still see the entry.
          void recorder.flush();
          continue;

        case "steering_delivered":
          // Queue drained at a turn boundary: record the delivered ids the
          // same way as steering_queued — recorder.record double-writes to
          // the EventSink, so the live SSE path and the durable log match.
          recorder.record("steering_delivered", {
            ids: event.data["ids"] as string[],
          });
          // Same immediate-durability rule as steering_queued: a rebuild or a
          // mid-turn detail read must not resurrect a delivered entry.
          void recorder.flush();
          continue;

        case "steering_edited":
          // Queue mutation before delivery (D14): recorded the same way as
          // steering_delivered — the durable transcript is what Task 10's
          // queue rebuild folds, so an unrecorded edit would silently revert
          // on resume. recorder.record double-writes to the EventSink too.
          recorder.record("steering_edited", {
            id: event.data["id"] as string,
            content: event.data["content"] as TranscriptEventMap["steering_edited"]["content"],
          });
          // Immediate durability, same reason as steering_queued.
          void recorder.flush();
          continue;

        case "steering_removed":
          // Queue withdrawal before delivery (D15): same record + double-write
          // discipline as steering_edited above — the rebuild must see the
          // removal or the withdrawn message resurrects after a resume.
          recorder.record("steering_removed", {
            id: event.data["id"] as string,
          });
          // Immediate durability, same reason as steering_queued.
          void recorder.flush();
          continue;

        case "model_done": {
          const message = event.data["message"] as AssistantMessage | undefined;
          if (!message) continue;
          // Read once and reuse as this event's own `time` — same reasoning
          // as callStartedAt above: durationMs anchors on this exact reading,
          // and the recorded event's `time` field must match it.
          const endedAt = nowMs();
          recorder.record(
            "assistant_message",
            {
              content: message.content,
              ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
              ...(message.source !== undefined ? { source: message.source } : {}),
              ...(message.modelMeta !== undefined ? { modelMeta: message.modelMeta } : {}),
              ...(event.data["usage"] !== undefined ? { usage: event.data["usage"] as TokenUsage } : {}),
              ...(firstDeltaAt !== undefined ? { ttftMs: firstDeltaAt - callStartedAt } : {}),
              durationMs: endedAt - callStartedAt,
            },
            { step: stepCounter, time: endedAt },
          );
          continue;
        }

        case "tool_use_complete":
          recorder.record(
            "tool_call",
            {
              callId: event.data["toolCallId"] as string,
              name: event.data["toolName"] as string,
              input: (event.data["input"] as Record<string, unknown>) ?? {},
            },
            { step: stepCounter },
          );
          continue;

        case "tool_result":
          recorder.record(
            "tool_result",
            {
              callId: event.data["toolCallId"] as string,
              name: event.data["toolName"] as string | undefined,
              content: (event.data["content"] as string) ?? "",
              isError: event.data["isError"] === true,
              durationMs: event.data["durationMs"] as number | undefined,
              displayMetadata: event.data["displayMetadata"] as Record<string, unknown> | undefined,
              orderInBatch: (event.data["orderInBatch"] as number) ?? 0,
            },
            { step: stepCounter },
          );
          continue;

        case "budget_exceeded":
          turnHadBudgetExceeded = true;
          if (endsTurn) {
            const reason = event.data["reason"];
            turnTerminalError ??= typeof reason === "string" ? reason : "Budget exceeded";
          }
          recorder.record("budget_exceeded", { reason: event.data["reason"] as string });
          continue;

        case "context_reminder":
          recorder.record("context_reminder", event.data as TranscriptEventMap["context_reminder"]);
          continue;

        case "todoListUpdated":
          // Standing-plan change for UI docks / SSE clients. Transcript twin
          // so resume can fold the latest list without replaying tool args.
          recorder.record(
            "todoListUpdated",
            event.data as TranscriptEventMap["todoListUpdated"],
          );
          continue;

        case "compaction":
          // Emitted by the reducer's compaction_applied handler (write-back).
          // The recorder's emit hook streams the same stamped event (task-r6
          // double write), so no separate raw emit here.
          promptAnchorState.anchor = undefined;
          recorder.record("compaction", event.data as TranscriptEventMap["compaction"]);
          continue;

        case "tool_results_pruned":
          // Emitted by the reducer's tool_results_pruned handler (write-back).
          // The rewritten surface invalidates the provider-usage anchor.
          promptAnchorState.anchor = undefined;
          recorder.record("tool_results_pruned", event.data as TranscriptEventMap["tool_results_pruned"]);
          continue;

        default:
          // Raw events with no transcript counterpart (error / cancelled,
          // and any future reducer event) keep flowing for observability —
          // see the comment above the switch. Note the
          // reducer's model_error AgentInput produces a generic "error" emit
          // (reducer.ts handleCallingModel), never one literally typed
          // "model_error": model_error transcript events are recorded
          // directly at every site that constructs that AgentInput (the
          // provider-error stream loop and runModelStream's catch block).
          //
          // A terminal error is different: it is the only explanation the
          // user will ever get for a turn that stopped short, and the raw
          // event above never reaches the transcript or the host UI (it
          // carries no stamp, so the gateway drops it). Mark the turn failed
          // and let recordTurnEnd write the reason into turn_end.
          if (endsTurn && event.type === "error") {
            turnHadError = true;
            const message = event.data["error"];
            turnTerminalError ??= typeof message === "string" ? message : "Turn ended with an error";
          }
          opts.eventSink?.emit(event);
          continue;
      }
    }
  }

  function cleanup(): void {
    if (opts.abortSignal) {
      opts.abortSignal.removeEventListener("abort", onAbort);
    }
  }

  function getStatus(): string {
    return state.status;
  }

  // ── Compaction ──────────────────────────────

  /**
   * Internal result of a compaction write-back pass.
   * `didWriteBack` is true when at least one feed (prune or summary) landed.
   * `replacedCount` counts messages replaced by the summary (0 when only
   * pruning happened or nothing was compacted).
   */
  interface CompactionWriteBackOutcome {
    messages: Message[];
    replacedCount: number;
    didWriteBack: boolean;
  }

  /**
   * T7 image offload phase of the compaction write-back (spec 2026-10-16,
   * D1–D5). Pure planning comes from core (`planImageOffload`); this shell
   * performs the I/O: every surviving inline base64 candidate is `put` into
   * the AttachmentStore under a deterministic id and replaced by its ref;
   * existing refs ride along untouched (no store access needed).
   *
   * Fail-soft (spec §6): a throwing put — or a missing store — degrades
   * THAT image to today's placeholder text inside the summary text and
   * emits `attachment_unavailable`; the compaction itself always completes.
   * Cap-dropped placeholders (plan.droppedPlaceholders) join the summary
   * text the same way.
   *
   * Guard: `preserveImageCount <= 0` (spec D3 opt-out; default 4) skips the
   * phase entirely — no plan call, no puts, today's plain-string summary.
   *
   * Returns the (possibly prefixed) summary text plus the final ref blocks —
   * `undefined` when nothing survived, so the reducer keeps its byte-
   * identical string path.
   */
  async function offloadPreservedImages(
    replaced: Message[],
    summaryText: string,
  ): Promise<{ summaryText: string; preservedImages?: ContentBlock[] }> {
    const maxImages = opts.compaction?.preserveImageCount ?? 4;
    if (maxImages <= 0) return { summaryText };

    const plan = planImageOffload(replaced, { maxImages });
    if (plan.preserved.length === 0) {
      return { summaryText };
    }

    // plan.preserved lists kept candidates in span order; its base64-derived
    // blocks carry the placeholder id "pending" and pair 1:1, in order, with
    // plan.toOffload (both are the kept candidates split by source type).
    const degraded: string[] = [];
    if (plan.droppedPlaceholders) degraded.push(plan.droppedPlaceholders);
    const preserved: ContentBlock[] = [];
    let offloadCursor = 0;
    for (const block of plan.preserved) {
      if (block.type !== "image" || block.source.type !== "ref" || block.source.id !== "pending") {
        preserved.push(block);
        continue;
      }
      const candidate = plan.toOffload[offloadCursor++];
      const degrade = (): void => {
        degraded.push(extractBlockText(block));
      };
      if (!candidate || candidate.source.type !== "base64") {
        // Pairing failure (plan.preserved "pending" block without a matching
        // base64 candidate): pushing the placeholder-id block would ship a
        // ref the AttachmentStore cannot resolve. Degrade to the placeholder
        // text instead — same fail-soft as a missing store / failed put.
        degrade();
        continue;
      }
      if (!opts.attachmentStore) {
        // No store configured: skip the offload (inline bytes have nowhere
        // to go) but keep existing refs — they need no store access here.
        degrade();
        continue;
      }
      const derivedId = deriveDeterministicId(candidate);
      try {
        const stored = await opts.attachmentStore.put(
          candidate.source.data,
          candidate.source.mediaType,
          { id: derivedId },
        );
        preserved.push({
          type: "image",
          source: { type: "ref", id: stored.id, mediaType: candidate.source.mediaType },
          ...(candidate.width !== undefined ? { width: candidate.width } : {}),
          ...(candidate.height !== undefined ? { height: candidate.height } : {}),
        });
      } catch {
        // Fail-soft: warn, degrade to placeholder text, keep the summary
        // flowing — never abort the compaction.
        (opts.eventSink ?? { emit: () => {} }).emit({
          type: "attachment_unavailable",
          data: { id: derivedId },
        });
        degrade();
      }
    }

    const finalSummaryText = [...degraded, summaryText].join("\n");
    return {
      summaryText: finalSummaryText,
      ...(preserved.length > 0 ? { preservedImages: preserved } : {}),
    };
  }

  /**
   * Apply context compaction before a model call.
   * If the message history exceeds the token threshold, issues a summarization
   * call to the model and replaces compressible messages with the summary.
   * Returns the messages to use for the main request — always `state.messages`
   * after any write-back, so the request surface and canonical state agree.
   *
   * Sequence: decide → prune oversized tool results → write-back prune →
   * re-decide → summarize only if still over budget → write-back summary.
   * A single huge tool dump often accounts for most of the pressure; pruning
   * alone may be enough, and the pruned surface is preferred over a lossy
   * summary. On any summarization failure the pruned (or original) surface
   * is returned — the prune write-back already happened, so its progress is
   * kept even when summarization fails.
   */
  async function runCompactionWriteBack(
    messages: Message[],
    measuredTokens?: number,
  ): Promise<CompactionWriteBackOutcome> {
    const passthrough = (msgs: Message[]): CompactionWriteBackOutcome => ({
      messages: msgs,
      replacedCount: 0,
      didWriteBack: false,
    });

    if (!opts.compaction) return passthrough(messages);

    const reservedTokens =
      estimateContextLayerTokens(stepContext.contextLayers ?? [], opts.compaction.tokenizer)
      + estimateToolDefinitionTokens(stepContext.tools, opts.compaction.tokenizer);
    const decideOpts = {
      tokenizer: opts.compaction.tokenizer,
      maxTokens: opts.compaction.maxTokens,
      recentKeepCount: opts.compaction.recentKeepCount ?? 4,
      pinnedMessageIds: state.pinnedMessageIds,
      reservedTokens,
    };

    const decision = decideCompaction(messages, {
      ...decideOpts,
      ...(measuredTokens !== undefined ? { measuredTokens } : {}),
    });
    if (!decision.shouldCompact || !decision.summaryPrompt) return passthrough(messages);

    // T10 Task 3 — preCompact hook (spec 2026-10-17, D3 / F-032): fires
    // after the compaction decision, BEFORE any write-back (the prune feed
    // below) or the summarization model call. A deny skips this compaction
    // entirely: passthrough returns the caller's ORIGINAL messages array —
    // same reference, byte-identical — and the UI is told via a
    // `preCompact_skipped` event (raw EventSink emit, same observability-only
    // shape as `usage_unavailable`: outside the reducer vocabulary by
    // design). The turn itself is unaffected and continues normally.
    const preCompactOutcome = await runHookPipeline(opts.hooks ?? [], "preCompact", {
      sessionId: opts.sessionId,
      compactInfo: {
        compressibleCount: decision.compressibleMessages.length,
        currentTokens: decision.currentTokens,
      },
    });
    if (preCompactOutcome.action === "deny") {
      opts.eventSink?.emit({
        type: "preCompact_skipped",
        data: { reason: preCompactOutcome.reason },
      });
      return passthrough(messages);
    }

    // Prune oversized tool results. `pruned.length > 0` means at least one
    // block was rewritten. The pruned message array itself is not used
    // directly — the write-back feed below rewrites state.messages, and
    // that post-feed state is the canonical surface.
    let pruned: ReturnType<typeof pruneOversizedToolResults>["pruned"] = [];
    if (opts.compaction.prunePolicy !== "off") {
      try {
        pruned = pruneOversizedToolResults(messages, {
          maxChars: opts.compaction.toolResultMaxChars ?? 8_192,
          ...(opts.compaction.toolResultHeadChars !== undefined
            ? { headChars: opts.compaction.toolResultHeadChars }
            : {}),
          ...(opts.compaction.toolResultTailChars !== undefined
            ? { tailChars: opts.compaction.toolResultTailChars }
            : {}),
        }).pruned;
      } catch {
        // Direct Runner users bypass createAgent's construction-time check.
        // Degrade to "no prune" rather than failing the turn; the summary path
        // below still handles the pressure.
        pruned = [];
      }
    }

    // Write-back: feed tool_results_pruned so state.messages carries the
    // pruned content. Status-independent reducer handler — safe while
    // calling_model. After this feed, state.messages is the canonical
    // pruned surface.
    let didWriteBack = false;
    let totalSavedTokens = 0;
    if (pruned.length > 0) {
      const tokenizer = opts.compaction.tokenizer;
      const originalText = new Map<string, string>();
      for (const msg of messages) {
        if (msg.role !== "tool") continue;
        for (const block of msg.content) {
          if (block.type !== "tool_result") continue;
          const text = block.content
            .map((b) => (b.type === "text" || b.type === "structured" ? b.text : ""))
            .join("");
          originalText.set(block.toolUseId, (originalText.get(block.toolUseId) ?? "") + text);
        }
      }
      const prunedIds = new Set(pruned.map((p) => p.toolCallId));
      const firstPrunedIndex = messages.findIndex(
        (m) => m.role === "tool"
          && m.content.some((b) => b.type === "tool_result" && prunedIds.has(b.toolUseId)),
      );
      // Cache invalidation is priced from the local estimate (prefix + the
      // static layers/tool schemas), not a provider-reported cache metric.
      // The event therefore carries `cacheResetEstimated: true` permanently
      // until a provider exposes enough cache telemetry to reconcile it.
      const cacheResetTokens = firstPrunedIndex > 0
        ? estimateTokens(messages.slice(0, firstPrunedIndex), tokenizer) + reservedTokens
        : 0;
      let entries = pruned.map((entry, index) => {
        const after = entry.content
          .map((b) => (b.type === "text" || b.type === "structured" ? b.text : ""))
          .join("");
        const before = originalText.get(entry.toolCallId) ?? "";
        return {
          ...entry,
          savedTokens: Math.max(0, tokenizer.count(before) - tokenizer.count(after)),
          ...(index === 0 ? { cacheResetTokens, cacheResetEstimated: true } : {}),
        };
      });

      if (opts.compaction.pruneSpill && opts.spill?.store) {
        const kept: typeof entries = [];
        for (const entry of entries) {
          const before = originalText.get(entry.toolCallId) ?? "";
          // An already-spilled result has only its head + reference in state;
          // writing that back would destroy the full original on disk, and
          // truncating it again would eat into the model-visible head. Leave
          // it out of the candidate set entirely.
          if (before.includes("full output saved to")) continue;
          try {
            const { relativePath } = await opts.spill.store.write({
              sessionId: opts.sessionId ?? "",
              toolCallId: entry.toolCallId,
              text: before,
            });
            const reference = renderSpillReference({
              relativePath,
              totalChars: [...before].length,
            });
            entry.content = [...entry.content, { type: "text", text: reference }];
            entry.charsAfter += [...reference].length;
            const after = entry.content
              .map((b) => (b.type === "text" || b.type === "structured" ? b.text : ""))
              .join("");
            entry.savedTokens = Math.max(0, tokenizer.count(before) - tokenizer.count(after));
            kept.push(entry);
          } catch (err: unknown) {
            const error = err instanceof Error ? err.message : String(err);
            opts.eventSink?.emit({ type: "spill_failed", data: { toolCallId: entry.toolCallId, error } });
            // Skip this entry: no backup means no pruning.
          }
        }
        entries = kept;
      }

      totalSavedTokens = entries.reduce((sum, entry) => sum + (entry.savedTokens ?? 0), 0);
      if (entries.length > 0) {
        forwardEmit(feed({ type: "tool_results_pruned", entries }));
        didWriteBack = true;
      }
    }
    // Post-feed surface: state.messages (pruned if a write-back happened,
    // otherwise the original reference).
    const surface = pruned.length > 0 ? state.messages : messages;

    // Re-decide only when the surface actually changed. Without a prune the
    // initial decision is still the valid one — recomputing it through the
    // absolute fallback would discard a trusted anchor and could flip an
    // over-threshold decision back to "under" (skipping a needed summary).
    const redecision = didWriteBack
      ? decideCompaction(surface, {
          ...decideOpts,
          // Pruning removed these tokens from the prompt. Carry the prior
          // anchor forward instead of dropping to the absolute fallback: the
          // saved tokens are known, and this is exactly the case where a
          // needless summary used to be paid after pressure was relieved.
          ...(measuredTokens !== undefined
            ? { measuredTokens: Math.max(0, measuredTokens - totalSavedTokens) }
            : {}),
        })
      : decision;
    if (!redecision.shouldCompact || !redecision.summaryPrompt) {
      return { messages: surface, replacedCount: 0, didWriteBack };
    }

    // Issue a summarization model call
    try {
      const summaryEvents = opts.modelPort.stream({
        messages: [
          { id: "compaction-summary-prompt", role: "user", content: redecision.summaryPrompt },
        ],
        tools: [],
        model: stepContext.model,
        maxTokens: opts.compaction.summaryMaxTokens ?? 4096,
        abortSignal: opts.abortSignal,
      });

      let summaryText = "";
      // The summarizer is a real model call. Capture its usage so it counts
      // against this turn's budgets and reaches the turn-usage projection —
      // previously it was silently absent from both.
      let summaryUsage: TokenUsage | undefined;
      for await (const event of summaryEvents) {
        if (event.type === "text_delta") summaryText += event.text;
        if (event.type === "usage") {
          const { type: _type, ...usageFields } = event;
          summaryUsage = usageFields;
          accumulateUsage(usageFields);
        }
        if (event.type === "error") {
          // Compaction failed — proceed with the pruned surface (prune
          // write-back already happened above, so its progress is kept).
          return { messages: surface, replacedCount: 0, didWriteBack };
        }
        if (event.type === "done") break;
      }

      if (!summaryText) return { messages: surface, replacedCount: 0, didWriteBack };

      // Write-back: feed compaction_applied. The reducer replaces the span
      // named by replacedIds with a summary message and emits the
      // `compaction` transcript event (recorded via forwardEmit).
      //
      // replacedIds comes from the redecision (Plan 1 Task 2). An empty
      // list must NOT be fed — the reducer would prepend a summary at
      // index 0 with nothing replaced. That edge case (everything pinned
      // or recent-kept) falls through to the pruned surface below.
      const replacedIds = redecision.replacedIds ?? redecision.compressibleMessages.map((m) => m.id);
      if (replacedIds.length > 0) {
        // T7 image offload (spec 2026-10-16, D1–D5): plan purely, put the
        // inline base64 bytes under deterministic ids, feed the resolved
        // ref blocks via preservedImages. Runs AFTER the summary call
        // succeeded — a failed summarization never touches the store.
        // Guard: preserveImageCount <= 0 (default 4) skips the whole phase
        // and feeds exactly what today's code feeds (D3: 0 = opt-out).
        const { summaryText: finalSummaryText, preservedImages } =
          await offloadPreservedImages(redecision.compressibleMessages, summaryText);

        // summaryId from the Id port (StepContext.id). The hardcoded
        // "compaction-summary" constant is gone — I2 requires the Id port
        // so replayed sessions get deterministic, unique summary ids.
        const summaryId = stepContext.id?.next() ?? `summary-${stepCounter}`;
        forwardEmit(feed({
          type: "compaction_applied",
          summaryId,
          summaryText: finalSummaryText,
          replacedIds,
          ...(preservedImages !== undefined ? { preservedImages } : {}),
          ...(summaryUsage !== undefined ? { usage: summaryUsage } : {}),
        }));
        // Assemble from post-feed state so the request and state agree.
        return { messages: state.messages, replacedCount: replacedIds.length, didWriteBack: true };
      }

      return { messages: surface, replacedCount: 0, didWriteBack };
    } catch {
      // Compaction failed — proceed with the pruned surface
      return { messages: surface, replacedCount: 0, didWriteBack };
    }
  }

  /** Thin wrapper kept for the pre-request call site — returns messages only. */
  async function applyCompaction(messages: Message[], measuredTokens?: number): Promise<Message[]> {
    const { messages: out } = await runCompactionWriteBack(messages, measuredTokens);
    return out;
  }

  // ── Model streaming ──────────────────────────

  /**
   * Stream from ModelPort, feed chunks to the reducer.
   * Returns when the stream is consumed or the agent leaves calling_model status.
   *
   * Key behavior: if the stream ends and the reducer never received a done/error
   * event (e.g. empty stream), synthesizes a model_done(end_turn).
   * If a retriable error occurs and the reducer stays in calling_model,
   * returns without synthesizing — the main loop will call runModelStream again.
   */
  /** The static request header shared by hashing and the transcript record. */
  function buildHeaderPayload() {
    // Mirror the seed system prompt into the header (prepended, so it sits
    // closest to the static prefix). It deliberately does NOT go through
    // stepContext.contextLayers: the ContextAssembler converts every layer
    // into an extra system message, so the model would receive the prompt
    // twice. Skipped when the host's own layers already carry the id, so a
    // host managing its own "system-prompt" layer cannot collide.
    // The once-resolved workspace layers ride on StepContext every turn
    // (stable prefix); the header mirrors that same set so its hash stays
    // identical across the conversation.
    const systemLayers = (stepContext.contextLayers ?? []).map((l) => ({ id: l.id, text: l.text }));
    if (opts.seedSystemPrompt && !systemLayers.some((l) => l.id === "system-prompt")) {
      systemLayers.unshift({ id: "system-prompt", text: opts.seedSystemPrompt });
    }
    return {
      systemLayers,
      tools: stepContext.tools.map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.inputSchema,
      })),
      params: {
        ...(stepContext.model !== undefined ? { model: stepContext.model } : {}),
        ...(stepContext.temperature !== undefined ? { temperature: stepContext.temperature } : {}),
        ...(stepContext.maxTokens !== undefined ? { maxTokens: stepContext.maxTokens } : {}),
      },
    };
  }

  /** Hash the static request header; `undefined` when it is not serializable. */
  function computeHeaderHash(): string | undefined {
    try {
      return crypto
        .createHash("sha256")
        .update(JSON.stringify(buildHeaderPayload()))
        .digest("hex")
        .slice(0, 16);
    } catch {
      return undefined;
    }
  }

  async function runModelStream(): Promise<void> {
    // A new model call starts a new batch: a loop tier that never reached
    // its post-batch fire site must not ride along into a later batch.
    pendingLoopInjection = null;

    // The header hash is needed before compaction (anchor validity) and again
    // for the transcript record; compute it once from the static stepContext.
    const currentHeaderHash = computeHeaderHash();
    const measuredTokens =
      opts.compaction && currentHeaderHash !== undefined
        && promptAnchorState.anchor?.headerHash === currentHeaderHash
        ? estimateFromAnchor(promptAnchorState.anchor, state.messages, opts.compaction.tokenizer)
        : undefined;

    // Apply compaction before building the main request
    const messages = await applyCompaction(state.messages, measuredTokens);

    // ContextAssembler: cache-friendly ordering + breakpoint computation.
    // Same pure function the reducer uses for its `call_model` effect, so
    // host-side compaction/RAG additions still get a stable static prefix
    // and provider-cache breakpoints. Explicit `opts.cacheBreakpoints`
    // (legacy / advanced override) wins when provided.
    const assembled = assembleContext({
      messages,
      tools: stepContext.tools,
      pinnedMessageIds: state.pinnedMessageIds,
      contextLayers: stepContext.contextLayers,
      // Standing todos are re-injected every request so compaction of
      // historical tool results cannot drop the model's plan.
      todos: state.todos,
    });
    let finalMessages = assembled.messages;
    const finalCacheBreakpoints = opts.cacheBreakpoints ?? assembled.cacheBreakpoints;

    stepCounter++;
    const step = stepCounter;

    if (assembled.layerOrigins.length > 0) {
      // record() streams the same stamped context_assembled event (task-r6
      // double write) — no separate raw emit here.
      recorder.record("context_assembled", { layerOrigins: assembled.layerOrigins }, { step });
    }

    // Read once, before anything else below — reused both as the anchor
    // ttftMs/durationMs are computed from and as model_call_start's own
    // `time` (via the recorder's `time` override). A second, independent
    // now() read for either purpose would disagree with this one under a
    // clock that advances per call (real wall-clock jitter is negligible,
    // but an injected stepping clock makes the drift visible and
    // load-bearing for anyone reconstructing durations from event `time`
    // fields instead of the ttftMs/durationMs fields).
    callStartedAt = nowMs();

    // Static-prefix snapshot: system layers + tool catalogue + sampling
    // params. Written once per distinct payload: stepContext is fixed when
    // createRunner() is called (so the hash never changes within a turn),
    // and opts.headerHashState carries the last recorded hash across turns,
    // so an unchanged static prefix is recorded exactly once for the whole
    // conversation — one context row in the trajectory, not one per turn.
    // The hash comparison below enforces "write once"; it also means a
    // future caller with a mutable stepContext gets deduping for free
    // instead of a silent behavior change here.
    //
    // Since task-r6 the recorder's double write makes request_header /
    // model_call_start part of the live event contract, so this runs whenever
    // anything can observe the stream (persistence OR an EventSink) — a
    // recorder with neither is a no-op. Guarded in its own try/catch: a tool
    // whose inputSchema is self-referential (e.g. built from z.lazy) or
    // carries a non-JSON value (e.g. a BigInt default) makes JSON.stringify
    // throw, and that must not fail the turn just because the header can't
    // be hashed — transcript writes are best-effort, never a precondition.
    if (recorder.enabled || opts.eventSink !== undefined) {
      let headerHash: string | undefined;
      try {
        const headerPayload = buildHeaderPayload();
        headerHash = currentHeaderHash;
        if (headerHash !== undefined && headerHash !== lastHeaderHash) {
          // Same callStartedAt reading as model_call_start below — request_header
          // describes the call model_call_start announces, so it must not sort
          // after it when a reader orders the transcript by `time`.
          recorder.record("request_header", { hash: headerHash, ...headerPayload }, { step, time: callStartedAt });
          lastHeaderHash = headerHash;
          if (opts.headerHashState) opts.headerHashState.hash = headerHash;
        }
      } catch {
        // Nothing to point model_call_start's (required) headerHash field at.
        headerHash = undefined;
      }

      if (headerHash !== undefined) {
        recorder.record(
          "model_call_start",
          {
            ...(stepContext.model !== undefined ? { model: stepContext.model } : {}),
            ...(stepContext.temperature !== undefined ? { temperature: stepContext.temperature } : {}),
            ...(stepContext.maxTokens !== undefined ? { maxTokens: stepContext.maxTokens } : {}),
            headerHash,
          },
          { step, time: callStartedAt },
        );
      }
    }
    // Reset per-call timing/aggregation state — these live at createRunner()
    // scope (see the comment there) so forwardEmit() can read them when it
    // intercepts model_done.
    firstDeltaAt = undefined;

    if (opts.rag) {
      const { memoryStore, topK = 5, queryBuilder, projectId, includeGlobal } = opts.rag;
      if (!ragCacheComputed) {
        // Mark the cache computed up front: retrieval happens at most once
        // per turn, whether it succeeds or fails.
        ragCacheComputed = true;
        // The queryBuilder is host-supplied code, same trust level as the
        // store: a throw from it must degrade to "no RAG this turn", never
        // escape and abort the turn (spec 2026-10-20 memory-rag §6).
        try {
          const queryText = queryBuilder ? queryBuilder(messages) : extractLastUserMessage(messages);
          if (queryText) {
            // Scope the query: project + global by default; with no projectId
            // the contract means global-only, never every project.
            const fragments = await memoryStore.query(queryText, topK, {
              projectId,
              includeGlobal: includeGlobal ?? true,
              tier: "semantic",
            });
            if (fragments.length > 0) {
              const rendered = buildRAGMessage(fragments.map((f) => f.text));
              // Cap the INJECTED text at 4000 chars (spec 2026-10-20 §4.5).
              // Cut by code point so surrogate pairs (emoji) stay intact,
              // and cut back to the last COMPLETE block boundary so the
              // declared fragment count matches what the model sees.
              if (Array.from(rendered).length <= RAG_MAX_CHARS) {
                ragCacheText = rendered;
                ragCacheFragmentCount = fragments.length;
              } else {
                const body = truncateCodePoints(
                  rendered,
                  RAG_MAX_CHARS - RAG_TRUNCATION_MARKER.length,
                );
                const cutAt = body.lastIndexOf("\n\n[");
                const kept = cutAt > 0 ? body.slice(0, cutAt) : body;
                ragCacheText = `${kept}${RAG_TRUNCATION_MARKER}`;
                // Each `\n\n[` starts one block (buildRAGMessage always
                // separates the header from block 1 the same way), so the
                // number of occurrences IS the number of complete blocks.
                ragCacheFragmentCount =
                  cutAt > 0 ? (kept.match(/\n\n\[/g)?.length ?? 0) : fragments.length;
              }
              ragCacheMemoryIds = fragments.map((f) => f.id);
            }
          }
        } catch {
          /* Memory retrieval failure degrades to no injection for this turn */
        }
      }

      if (ragCacheText) {
        const index = computeRAGInjectionIndex({
          staticPrefixLength: assembled.staticPrefixLength,
          totalMessages: finalMessages.length,
        });
        // Keep the exact injected string in a local: the audit event must
        // carry the same value the model saw, not a re-derived copy, and
        // reading it here avoids narrowing Message['content'] (string |
        // ContentBlock[]) at the recorder call.
        const ragText = ragCacheText;
        const ragMessage: Message = { id: "rag-injection", role: "user", content: ragText };
        finalMessages = [...finalMessages.slice(0, index), ragMessage, ...finalMessages.slice(index)];
        // `memoryIds` records which entries were retrieved so the UI can trace
        // the injection back to the store; ids are carried alongside the
        // rendered text in the cache slot via the reminder below.
        // Record the retrieval once per turn: every later model call of the
        // same turn injects the same cached text, and duplicating the audit
        // event adds noise, not traceability.
        if (!ragReminderRecorded) {
          ragReminderRecorded = true;
          recorder.record("context_reminder", {
            kind: "retrieval",
            text: ragText,
            displayMetadata: {
              fragmentCount: ragCacheFragmentCount,
              memoryIds: ragCacheMemoryIds,
            },
          });
        }
      }
    }

    // The manifest describes the request before refs become base64, so image
    // entries keep their attachment ids. It includes RAG injection because
    // that is already part of finalMessages here.
    if (currentHeaderHash !== undefined) {
      recorder.record(
        "model_request",
        buildRequestManifest(
          finalMessages,
          stepContext.tools,
          currentHeaderHash,
          stepContext.model,
          stepContext.temperature,
          stepContext.maxTokens,
        ),
        { step, time: callStartedAt },
      );
    }

    // Resolve AttachmentStore refs → base64 for the request surface only.
    // State keeps the refs, so a snapshot never carries image bytes. A
    // missing attachment degrades to placeholder text with a warning —
    // replaying a session whose files were cleaned up must not break the
    // loop. Skipped when no store is configured (text-only hosts).
    if (opts.attachmentStore) {
      finalMessages = await resolveImageRefs(
        finalMessages,
        opts.attachmentStore,
        opts.eventSink ?? { emit: () => {} },
      );
    }

    const req = {
      messages: finalMessages,
      tools: stepContext.tools,
      model: stepContext.model,
      maxTokens: stepContext.maxTokens,
      temperature: stepContext.temperature,
      responseFormat: stepContext.responseFormat,
      cacheBreakpoints: finalCacheBreakpoints,
      abortSignal: opts.abortSignal,
      layerOrigins: assembled.layerOrigins,
      reasoningEffort: stepContext.reasoningEffort,
    };

    /** Full heuristic price of this request, used to vet the usage anchor. */
    const requestEstimate = opts.compaction
      ? estimateTokens(finalMessages, opts.compaction.tokenizer)
        + estimateToolDefinitionTokens(stepContext.tools, opts.compaction.tokenizer)
      : undefined;

    const modelSpan = opts.telemetry?.startSpan("model_call", { model: stepContext.model });
    const modelSpanStartedAt = opts.clock?.now() ?? Date.now();
    let lastUsage: TokenUsage | undefined;
    let capturedUsage: TokenUsage | undefined;
    let receivedTerminal = false; // true after done or error event is fed
    let modelError = false;
    // What this call streamed before the stream ended. Only read by the
    // truncated-stream branch below: a cut inside a tool call must not be
    // turned into an assistant_message with an unpaired tool_use, and an
    // empty stream has no content worth persisting either.
    let sawText = false;
    let sawToolUse = false;

    try {
      const stream = opts.modelPort.stream(req);

      for await (const event of stream) {
        if (cancelled && getStatus() !== "cancelling" && getStatus() !== "done") {
          forwardEmit(feed({ type: "cancel", reason: "abort" }));
          return;
        }

        if (event.type === "text_delta" || event.type === "reasoning_delta") {
          firstDeltaAt ??= nowMs();
          sawText = true;
        }

        if (event.type === "tool_use_start" || event.type === "tool_use_delta") {
          sawToolUse = true;
        }

        // Provider degradation signal: the request asked for usage but the
        // stream ended without one. This is observability-only — forward it
        // straight to the EventSink (the same raw `{type, data}` shape used
        // for tool-result pendingEvents above) without touching the durable
        // transcript or the reducer's own AgentInput vocabulary; it must not
        // change anything the context/cost meters compute.
        if (event.type === "usage_unavailable") {
          opts.eventSink?.emit({
            type: "usage_unavailable",
            data: { model: stepContext.model },
          });
          continue;
        }

        // Track usage separately (attach to the next done event)
        if (event.type === "usage") {
          // Keep every counter the provider reported — cache and reasoning
          // tokens are part of the durable record, and cache tokens now also
          // feed the budget gates below (a heavily-cached turn can be
          // dominated by cache reads, e.g. 5504 of 5619 total tokens).
          const { type: _type, ...usageFields } = event;
          lastUsage = usageFields;
          // Shared helper: tracks raw tokens (always, including cache) and
          // accumulates cost with the dollar-pricing / token-fallback split.
          accumulateUsage(usageFields);
          // Check cost budget immediately after accumulation
          if (state.maxCostDollars !== undefined && cumulativeCost > state.maxCostDollars) {
            await runNotificationHook("budget_warning");
            forwardEmit(feed({ type: "budget_exceeded", reason: "Cost budget exceeded" }));
            return;
          }
          // Check raw token budget
          if (state.maxTokensPerTurn !== undefined && cumulativeTokens > state.maxTokensPerTurn) {
            await runNotificationHook("budget_warning");
            forwardEmit(feed({ type: "budget_exceeded", reason: "Token budget exceeded" }));
            return;
          }
          continue;
        }

        // Mark terminal events (done or error)
        if (event.type === "done" || event.type === "error") {
          receivedTerminal = true;
        }

        // A provider that yields {type:"error"} instead of throwing — the
        // path real providers take (see providers/anthropic|openai's
        // model-port.ts for non-2xx responses, aborts, and empty bodies)
        // never reaches the catch block below, so model_error must be
        // recorded here or it is silently lost. This is a record of what
        // the provider actually said, independent of what happens next:
        // the reducer may retry in place (its own iteration-limited loop,
        // separate from the Runner-level retryPolicy used for thrown
        // exceptions) or end the turn — either way the turn saw an error.
        if (event.type === "error") {
          modelError = true;
          turnHadError = true;
          recorder.record(
            "model_error",
            { error: event.error, retriable: event.retriable ?? false },
            { step: stepCounter },
          );
        }

        // Convert and feed model events
        for (const input of modelEventToInputs(event, lastUsage)) {
          if (event.type === "done") {
            capturedUsage = lastUsage;
            lastUsage = undefined;
          }
          if (input.type === "model_done" && input.stopReason === "tool_use") {
            // Loop ladder (spec 2026-10-16 D2): snapshot the exact state the
            // reducer's model_done ladder probes, then decide the tier from
            // the RESULTING state — fresh-reminder bookkeeping is observable
            // only as a before/after delta of loopRemindedCount.
            const priorMessages = state.messages;
            const preRemindedCount = state.loopRemindedCount;
            forwardEmit(feed(input));
            pendingLoopInjection = decideLoopInjection(priorMessages, preRemindedCount);
          } else {
            forwardEmit(feed(input));
          }
        }

        // After processing events, check if we should stop streaming
        const status = getStatus();
        if (status !== "calling_model") {
          return;
        }
      }

      // Stream ended without a terminal event. The ModelPort contract
      // requires exactly one (`done` or `error`); a stream that merely stops
      // is a TRUNCATED response — a proxy cutting a long generation, a
      // half-open socket, a provider bug — and synthesizing a clean end_turn
      // here is how a long task dies silently with a half-written answer.
      // Close the turn as an error that says so. Two shapes:
      //  - nothing streamed, or the cut landed inside a tool call: feed
      //    model_error. A synthesized assistant_message would either be empty
      //    or carry a tool_use that never gets a tool_result — the next
      //    request then violates the provider's pairing contract;
      //  - otherwise: still persist the assistant text the user already saw
      //    (synthesized end_turn), and mark the turn failed via
      //    turnTerminalError so turn_end explains it.
      if (!receivedTerminal && getStatus() === "calling_model") {
        consecutiveModelErrors = 0;
        const truncated = "Model stream ended without a terminal event (truncated response)";
        turnHadError = true;
        turnTerminalError ??= truncated;
        if (sawToolUse || !sawText) {
          forwardEmit(feed({
            type: "model_error",
            error: truncated,
            retriable: false,
            errorKind: classifyError(truncated).kind,
          }));
        } else {
          forwardEmit(feed({ type: "model_done", stopReason: "end_turn", usage: lastUsage }));
        }
      }
    } catch (err: unknown) {
      // An aborted turn surfaces here as a throw from the model stream (the
      // provider rejects its in-flight request when the signal fires). That
      // is not a model failure: treating it as one would close the turn with
      // `reason: "error"` and show the user a red failure notice for
      // something they asked for. Take the same route the mid-stream
      // cancellation check above takes, and leave `turnHadError` alone so
      // the turn closes with `reason: "cancelled"`.
      if (cancelled) {
        if (getStatus() !== "cancelling" && getStatus() !== "done") {
          forwardEmit(feed({ type: "cancel", reason: "abort" }));
        }
        return;
      }
      modelError = true;
      turnHadError = true;
      if (getStatus() === "calling_model") {
        const error = err instanceof Error ? err.message : String(err);
        const classification = classifyError(err);

        // Retry logic: exponential backoff with circuit breaker
        if (classification.retriable && opts.retryPolicy) {
          const { maxRetries = 3, baseDelayMs = 500, maxDelayMs = 30_000, circuitBreakerThreshold = 5 } = opts.retryPolicy;
          consecutiveModelErrors++;

          if (consecutiveModelErrors <= maxRetries && consecutiveModelErrors < circuitBreakerThreshold) {
            const delay = Math.min(baseDelayMs * Math.pow(2, consecutiveModelErrors - 1), maxDelayMs);
            // record() streams the same stamped model_retry event (task-r6
            // double write) — no separate raw emit here.
            recorder.record("model_retry", { attempt: consecutiveModelErrors, delayMs: delay, error }, { step: stepCounter });
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);
              if (opts.abortSignal) {
                opts.abortSignal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
              }
            });
            if (cancelled || getStatus() !== "calling_model") return;
            // Retry: do not feed model_error, just return to let the loop call runModelStream again
            return;
          }
          // Circuit breaker tripped or max retries exhausted — feed error as non-retriable
          {
            const finalError = `${error} (retried ${consecutiveModelErrors} times)`;
            forwardEmit(feed({ type: "model_error", error: finalError, retriable: false, errorKind: classification.kind }));
            recorder.record(
              "model_error",
              { error: finalError, retriable: false, errorKind: classification.kind },
              { step: stepCounter },
            );
          }
          return;
        }

        // No retry policy or non-retriable: feed error to reducer.
        // When no retryPolicy, mark retriable errors as non-retriable to prevent
        // the reducer from infinitely re-issuing model calls.
        {
          const retriable = opts.retryPolicy ? classification.retriable : false;
          forwardEmit(feed({ type: "model_error", error, retriable, errorKind: classification.kind }));
          recorder.record("model_error", { error, retriable, errorKind: classification.kind }, { step: stepCounter });
        }
      }
    } finally {
      // Best-effort flush after every model call — long turns (many tool
      // round-trips) should not buffer their whole transcript in memory
      // until the turn ends.
      void recorder.flush();

      const endTime = opts.clock?.now() ?? Date.now();
      const usageData = capturedUsage ?? lastUsage;
      if (!calibrationEmitted && opts.eventSink !== undefined && capturedUsage !== undefined) {
        const estimated = measuredTokens ?? requestEstimate;
        if (estimated !== undefined && estimated > 0) {
          // The anchor's estimate already includes the last output, so compare
          // it with total usage; the absolute fallback prices the prompt only.
          const provider = measuredTokens !== undefined
            ? totalUsageTokens(capturedUsage)
            : capturedUsage.inputTokens
              + (capturedUsage.cacheReadTokens ?? 0)
              + (capturedUsage.cacheWriteTokens ?? 0);
          opts.eventSink.emit({
            type: "tokenizer_calibration",
            data: {
              model: stepContext.model,
              estimated,
              provider,
              ratio: provider / estimated,
              source: measuredTokens !== undefined ? "anchor" : "absolute",
            },
          });
          calibrationEmitted = true;
        }
      }
      // A completed call is the only point at which the provider usage and
      // the assistant message describe the same surface. Missing usage (a
      // failed/retried call) leaves the previous anchor untouched: the
      // surface did not change, so that anchor is still valid.
      if (opts.compaction && currentHeaderHash !== undefined && capturedUsage !== undefined) {
        const total = totalUsageTokens(capturedUsage);
        promptAnchorState.anchor = {
          totalTokens: total,
          messageIndex: state.messages.length,
          headerHash: currentHeaderHash,
          trusted: requestEstimate !== undefined && total >= requestEstimate,
        };
      }
      if (modelSpan) {
        if (modelError) modelSpan.setAttribute("error", true);
        if (usageData) {
          modelSpan.setAttribute("inputTokens", usageData.inputTokens);
          modelSpan.setAttribute("outputTokens", usageData.outputTokens);
          // Cache tokens get their own attributes rather than being folded
          // into inputTokens/outputTokens — folding them in would misreport
          // what was actually billed as fresh input/output.
          if (usageData.cacheReadTokens !== undefined) {
            modelSpan.setAttribute("cacheReadTokens", usageData.cacheReadTokens);
          }
          if (usageData.cacheWriteTokens !== undefined) {
            modelSpan.setAttribute("cacheWriteTokens", usageData.cacheWriteTokens);
          }
        }
        modelSpan.end();
      }
      if (opts.telemetry) {
        const attrs: Record<string, unknown> = { model: stepContext.model };
        // Latency
        if (modelSpanStartedAt > 0) {
          opts.telemetry.metric("latency_ms", endTime - modelSpanStartedAt, attrs);
        }
        // Token counts (use capturedUsage since lastUsage is reset after done event)
        if (usageData) {
          opts.telemetry.metric("tokens", usageData.inputTokens, { ...attrs, kind: "input" });
          opts.telemetry.metric("tokens", usageData.outputTokens, { ...attrs, kind: "output" });
          // Cache tokens as their own metric kinds — same reasoning as the
          // span attributes above: never fold them into input/output.
          if (usageData.cacheReadTokens !== undefined) {
            opts.telemetry.metric("tokens", usageData.cacheReadTokens, { ...attrs, kind: "cache_read" });
          }
          if (usageData.cacheWriteTokens !== undefined) {
            opts.telemetry.metric("tokens", usageData.cacheWriteTokens, { ...attrs, kind: "cache_write" });
          }
          // Cost
          if (opts.pricing && stepContext.model) {
            const entry = opts.pricing[stepContext.model];
            if (entry) {
              const cost = computeUsageCost(entry, usageData);
              opts.telemetry.metric("cost_usd", cost, attrs);
            }
          }
        }
      }
    }
  }

  // ── Tool execution ───────────────────────────

  /**
   * T5 spill interception: runs on the finalResult of a tool call, AFTER
   * the postToolUse hook and BEFORE stamp returns — i.e. before anything
   * is fed to the reducer (the untrusted annotation in the feed loop runs
   * later and wraps the already-spilled text; its order must not change).
   *
   * Core decides purely (decideSpill); the injected SpillStore persists;
   * the model sees keptHead + a text reference. Exempt: isError results,
   * block-array modelContent, and a missing spill/store (zero behavior
   * change). A store write that throws degrades (spec §6): spill_failed is
   * emitted and the ORIGINAL result is returned untouched — the loop is
   * never interrupted. `sessionId ?? ""` deliberately fails the store's
   * segment guard so a sessionless Runner degrades the same way.
   */
  async function applySpill(toolCallId: string, result: ToolResult): Promise<ToolResult> {
    const spill = opts.spill;
    if (!spill?.store) return result;
    if (result.isError) return result;
    if (typeof result.modelContent !== "string") return result;

    const text = result.modelContent;
    const decision = decideSpill(text, {
      thresholdChars: spill.thresholdChars ?? 16_000,
      headChars: spill.headChars ?? 2_000,
    });
    if (!decision.spill) return result;

    try {
      const { relativePath } = await spill.store.write({
        sessionId: opts.sessionId ?? "",
        toolCallId,
        text: decision.fullText ?? text,
      });
      // Code-point length of the decideSpill INPUT (same semantics as
      // core's slicing — never UTF-16 units).
      const totalChars = [...text].length;
      return {
        ...result,
        modelContent:
          (decision.keptHead ?? "") +
          renderSpillReference({ relativePath, totalChars }),
        displayMetadata: {
          ...(result.displayMetadata ?? {}),
          spilled: true,
          spillPath: relativePath,
          totalChars,
        },
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      opts.eventSink?.emit({ type: "spill_failed", data: { toolCallId, error } });
      return result;
    }
  }

  async function executeTool(toolCall: PendingToolCall): Promise<ToolResult> {
    // Start the clock as early as possible so durationMs reflects what the
    // user actually waits for (routing, hook pipeline, executor, post hook).
    // Routing/no-executor early returns finish in microseconds and would
    // otherwise be reported as "0ms" — that's accurate enough and consistent.
    const toolStartedAt = opts.clock?.now() ?? Date.now();

    /**
     * Stamp durationMs onto a ToolResult unless the underlying tool already
     * provided its own measurement (some tools time their inner work more
     * precisely than wallclock — never overwrite that).
     */
    const stamp = (result: ToolResult): ToolResult => {
      const existing = result.displayMetadata?.["durationMs"];
      if (typeof existing === "number") return result;
      const elapsed = (opts.clock?.now() ?? Date.now()) - toolStartedAt;
      return {
        ...result,
        displayMetadata: { ...(result.displayMetadata ?? {}), durationMs: elapsed },
      };
    };

    const { result: routingResult } = routeToolCall(visibleTools, availableCapabilities, toolCall);
    if (routingResult) {
      return stamp(routingResult);
    }

    if (!opts.toolExecutor) {
      return stamp({
        modelContent: `Tool "${toolCall.name}" is not available: no tool executor configured.`,
        isError: true,
      });
    }

    const toolDef = visibleTools.find((t) => t.name === toolCall.name);

    // M13: preToolUse hook — after permission, before executor
    const preOutcome = await runHookPipeline(opts.hooks ?? [], "preToolUse", {
      sessionId: opts.sessionId,
      toolCall: { id: toolCall.id, name: toolCall.name, input: toolCall.input },
    });
    if (preOutcome.action === "deny") {
      // Same three things a policy denial says, for the same reason: a bare
      // "denied by hook" reads like a malfunction and invites the model to
      // retry the refused effect through `bash`.
      return stamp({
        modelContent:
          `Tool "${toolCall.name}" was denied by a preToolUse hook: ${preOutcome.reason}\n\n` +
          `A hook is a rule this deployment installed deliberately, not a ` +
          `failure of the tool. Do not route around the refusal: do not reach ` +
          `the refused effect through another tool, and in particular do not ` +
          `use \`bash\` to run an equivalent command. Stop this line of work ` +
          `and report what was refused and the reason given.`,
        isError: true,
      });
    }
    const effectiveCall = preOutcome.action === "modify" && preOutcome.patch.input
      ? { ...toolCall, input: preOutcome.patch.input }
      : toolCall;

    const toolSpan = opts.telemetry?.startSpan("tool_execute", {
      toolName: toolCall.name,
      riskTier: toolDef?.riskTier,
    });
    try {
      const result = await opts.toolExecutor(effectiveCall, { readFiles: state.readFiles, abortSignal: opts.abortSignal });

      // M13: postToolUse hook — can modify result before feeding to reducer
      const postOutcome = await runHookPipeline(opts.hooks ?? [], "postToolUse", {
        sessionId: opts.sessionId,
        toolCall: { id: effectiveCall.id, name: effectiveCall.name, input: effectiveCall.input },
        toolResult: result,
      });
      const finalResult = postOutcome.action === "modify" && postOutcome.patch.result
        ? { ...result, ...postOutcome.patch.result }
        : result;

      // T5: intercept oversized results here — after the postToolUse
      // hook's finalResult, before stamp returns (the reducer and the
      // feed loop's untrusted annotation both see the spilled form).
      const spilledResult = await applySpill(effectiveCall.id, finalResult);

      if (toolSpan && spilledResult.isError) toolSpan.setAttribute("error", true);
      return stamp(spilledResult);
    } catch (err: unknown) {
      turnHadError = true;
      if (toolSpan) toolSpan.setAttribute("error", true);
      const error = err instanceof Error ? err.message : String(err);
      return stamp({
        modelContent: `Tool execution error: ${error}`,
        isError: true,
      });
    } finally {
      const toolEnd = opts.clock?.now() ?? Date.now();
      toolSpan?.end();
      if (opts.telemetry) {
        opts.telemetry.metric("latency_ms", toolEnd - toolStartedAt, {
          toolName: toolCall.name,
          riskTier: toolDef?.riskTier,
        });
      }
    }
  }

  // ── Main loop ────────────────────────────────

  /**
   * Run the agent loop until the turn completes.
   * Handles: model calls → tool execution → model calls → ... → done.
   */
  async function runLoop(): Promise<void> {
    // Initialize wallclock tracking at the start of each turn
    if (turnStartTime === 0) turnStartTime = Date.now();

    const turnSpan = opts.telemetry?.startSpan("turn", { sessionId: opts.sessionId });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const status = getStatus();

      // Budget check: wallclock / cost exceeded → feed budget_exceeded
      if (status !== "done" && status !== "idle" && (await checkBudgetLimits())) continue;

      // Short-circuit: if cancellation fired, transition to cancelling before
      // dispatching any new model call or tool execution. Avoids initiating a
      // wasted model request after abort.
      if (cancelled && status !== "cancelling" && status !== "done") {
        forwardEmit(feed({ type: "cancel", reason: "abort" }));
        continue;
      }

      if (status === "calling_model") {
        // M13: turn:start hook
        await runHookPipeline(opts.hooks ?? [], "turn:start", {
          sessionId: opts.sessionId,
        });
        await runModelStream();
        // Check budget after model call completes — cost may have been
        // updated during streaming but status may already be "done",
        // skipping the top-of-loop budget check.
        if (getStatus() !== "done" && getStatus() !== "idle") {
          if (await checkBudgetLimits()) continue;
        }
        continue;
      }

      if (status === "executing_tools") {
        const pending = [...state.pendingTools];

        // ── Permission classification ─────────────
        // Partition into: parallelBatch (allow) vs approvalQueue (ask)
        const parallelBatch: PendingToolCall[] = [];
        const approvalQueue: PendingToolCall[] = [];

        // Path/host facts are I/O, so they are computed here and never in
        // core. Skipped entirely unless a rule actually needs them.
        const factResolver =
          opts.permissionConfig !== undefined && hasParameterRules(opts.permissionConfig)
            ? createToolInputFactResolver(opts.pathRoot ?? process.cwd())
            : undefined;

        for (const toolCall of pending) {
          if (cancelled) {
            forwardEmit(feed({ type: "cancel", reason: "abort" }));
            break;
          }

          if (deniedToolCallIds.has(toolCall.id)) {
            // Already denied — its result is already buffered by the reducer
            // and it only remains on pendingTools so a mixed batch can flush
            // once its siblings resolve. Skip re-classification entirely: it
            // must not be re-queued for approval (re-prompting the gate) or
            // pushed into the parallel batch (it was never allowed to run).
            continue;
          }

          if (opts.permissionConfig && !approvedToolCallIds.has(toolCall.id)) {
            const toolDef = visibleTools.find((t) => t.name === toolCall.name);
            if (toolDef) {
              const toolCaps = new Set(toolDef.requires ?? []);
              const resolved =
                factResolver !== undefined ? await factResolver.resolve(toolDef, toolCall.input) : undefined;
              // Re-check after the await: the fact resolver performs I/O
              // (realpath, DNS lookups), so the turn may have been cancelled
              // or the status may have changed during that yield.
              if (cancelled || getStatus() !== "executing_tools") break;
              const commandValues =
                opts.permissionConfig !== undefined &&
                toolDef.commandInputs !== undefined &&
                hasCommandRules(opts.permissionConfig)
                  ? collectCommandValues(toolDef.commandInputs, toolCall.input)
                  : undefined;
              const resolution = resolvePermission(
                opts.permissionConfig,
                toolCall.name,
                toolDef.riskTier,
                toolCaps,
                resolved,
                commandValues,
              );
              let permDecision = resolution.decision;
              const matchedRule = resolution.rule;

              // Audit: a command-prefix rule turned an "ask" into an "allow".
              // Recorded before the PolicyEngine can tighten it below, so the
              // entry says what the rule did, not what the final decision was.
              if (
                permDecision === "allow" &&
                matchedRule?.commandPrefix !== undefined &&
                opts.auditSink
              ) {
                opts.auditSink.record({
                  kind: "rule_allow",
                  toolName: toolCall.name,
                  riskTier: toolDef.riskTier,
                  decision: "allow",
                  timestamp: opts.clock?.now() ?? Date.now(),
                  sessionId: opts.sessionId,
                  ruleSummary: `commandPrefix:${matchedRule.commandPrefix.join(" ")}`,
                  ...(commandValues?.[0] !== undefined ? { commandText: commandValues[0] } : {}),
                });
              }

              // Combine with external PolicyEngine (most restrictive wins)
              if (opts.policyEngine && permDecision !== "deny") {
                try {
                  const externalDecision = await opts.policyEngine.evaluate({
                    action: toolCall.name,
                    context: { riskTier: toolDef.riskTier },
                  });
                  permDecision = mostRestrictive(permDecision, externalDecision);
                } catch {
                  // Fail-closed: PolicyEngine failure → deny
                  permDecision = "deny";
                }
              }

              if (permDecision === "deny") {
                forwardEmit(feed({
                  type: "tool_result",
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  result: {
                    modelContent: policyDenialMessage(toolCall.name, opts.permissionConfig),
                    isError: true,
                  },
                }));
                if (getStatus() !== "executing_tools") break;
                continue;
              }
              if (permDecision === "ask") {
                approvalQueue.push(toolCall);
                continue;
              }
            }
          }

          parallelBatch.push(toolCall);
        }

        // ── Approval tools: sequential through existing HITL flow ──
        for (const toolCall of approvalQueue) {
          if (cancelled || getStatus() !== "executing_tools") break;

          // T10 Task 3: the approval request is about to reach the gate —
          // observe-only notification point (see runNotificationHook).
          await runNotificationHook("approval_requested");
          const effects = feed({ type: "request_approval", toolCallId: toolCall.id });
          forwardEmit(effects);
          await interpretEffects(effects);
          if (getStatus() !== "executing_tools") break;
        }

        // ── Parallel batch: execute all allow tools concurrently ──
        if (parallelBatch.length > 0 && getStatus() === "executing_tools" && !cancelled) {
          // allSettled: one rejected sibling must not short-circuit the batch.
          // executeTool already normalizes executor failures into isError
          // ToolResults, so a rejection here is a last-resort guard (e.g. an
          // unexpected abort) — normalize it into an error tool_result and
          // feed it back to the reducer like any other failure.
          const settledResults = await Promise.allSettled(
            parallelBatch.map(async (toolCall) => {
              const result = await executeTool(toolCall);
              approvedToolCallIds.delete(toolCall.id);
              return { toolCall, result };
            }),
          );
          // settledResults mirrors parallelBatch 1:1, so the non-null
          // assertion below is safe (noUncheckedIndexedAccess).
          const results = settledResults.map((settled, index): { toolCall: PendingToolCall; result: ToolResult } => {
            const toolCall = parallelBatch[index]!;
            if (settled.status === "fulfilled") return settled.value;
            approvedToolCallIds.delete(toolCall.id);
            turnHadError = true;
            const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
            return {
              toolCall,
              result: {
                modelContent: `Tool "${toolCall.name}" execution rejected unexpectedly: ${reason}`,
                isError: true,
              },
            };
          });

          // Defer self-correction injection until ALL tool_results have been
          // fed. Injecting mid-batch would interleave a `user` repair message
          // between sibling parallel results, breaking turn-boundary ordering.
          const pendingSelfCorrects: Array<{ repairPrompt: string; consumesBudget: boolean }> = [];

          // Feed results one at a time — the reducer buffers and flushes
          // in pendingTools order for deterministic replay.
          for (const { toolCall, result } of results) {
            if (cancelled) break;

            // T10 Task 3 — subagentStop hook (spec 2026-10-17, D3 / F-033):
            // fires at the point a task tool result returns to the parent
            // session — right before the result is fed back. The sync
            // subagent dispatch carries the child session id in
            // displayMetadata.sessionId (the tools/agent `task` contract);
            // background dispatches and early rejections never do, so they
            // correctly do not fire here (a background child stops later,
            // at the turn-boundary drain).
            //
            // OBSERVE-ONLY: the pipeline is awaited and then its outcome is
            // IGNORED entirely — anti-hijack by design (spec D3). A hook can
            // watch subagent completions but can never alter, deny, or
            // swallow the result that reaches the model. Do not "fix" this
            // by consuming the outcome. A FAILED observation (thrown handler
            // or fail-closed deny) surfaces as a `hook_error` event instead
            // — see runObserveOnlyHook.
            if (
              toolCall.name === "task" &&
              result.displayMetadata?.["sessionId"] !== undefined
            ) {
              await runObserveOnlyHook("subagentStop", {
                sessionId: opts.sessionId,
                subagentInfo: {
                  childSessionId: result.displayMetadata["sessionId"] as string,
                  status: result.isError === true ? "error" : "completed",
                },
              });
            }

            const pendingEvents = result.displayMetadata?.pendingEvents as
              | Array<{ type: string; data: Record<string, unknown> }>
              | undefined;
            if (pendingEvents && opts.eventSink) {
              for (const evt of pendingEvents) {
                opts.eventSink.emit(evt);
              }
            }

            // Annotate untrusted content from tools declared as untrusted
            const toolDef = visibleTools.find((t) => t.name === toolCall.name);
            const isUntrusted = toolDef?.trust === "untrusted";
            const annotatedResult = isUntrusted && !result.isError
              ? { ...result, modelContent: annotateUntrustedContent(result.modelContent) }
              : result;

            forwardEmit(feed({
              type: "tool_result",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: {
                ...annotatedResult,
                ...(annotatedResult.isError ? { errorKind: classifyError(annotatedResult.modelContent).kind } : {}),
              },
            }));
            // Audit: record high-risk tool execution
            if (opts.auditSink) {
              const tDef = visibleTools.find((t) => t.name === toolCall.name);
              if (tDef && (tDef.riskTier === "WRITE_HIGH" || tDef.riskTier === "IRREVERSIBLE")) {
                opts.auditSink.record({
                  kind: "high_risk_exec",
                  toolName: toolCall.name,
                  riskTier: tDef.riskTier,
                  isError: result.isError,
                  timestamp: opts.clock?.now() ?? Date.now(),
                  sessionId: opts.sessionId,
                });
              }
            }

            // Self-correction: validate tool result and queue repair prompt
            // for post-batch injection. We must use the projected budget
            // (state.selfCorrectionCount + already-queued consumers) so that
            // multiple failures within the same batch see consistent budget
            // accounting BEFORE any input is fed.
            if (opts.validators && opts.validators.length > 0 && !result.isError) {
              for (const validator of opts.validators) {
                const vr = validator.validate(toolCall.name, toolResultText(result.modelContent));
                if (!vr.passed) {
                  const projectedCount =
                    state.selfCorrectionCount +
                    pendingSelfCorrects.filter((p) => p.consumesBudget).length;
                  const decision = decideSelfCorrect(
                    vr,
                    projectedCount,
                    state.maxSelfCorrections ?? 0,
                  );
                  if (decision.repairPrompt) {
                    pendingSelfCorrects.push({
                      repairPrompt: decision.repairPrompt,
                      consumesBudget: decision.shouldCorrect,
                    });
                  }
                  break;
                }
              }
            }

            // A timed-out call is the one failure the model can usually fix
            // itself (a larger `timeout`, or run_in_background). Queue ONE
            // budgeted repair prompt so the model — not the Runner — decides
            // whether to re-call the tool; the Runner never re-executes it.
            if (result.displayMetadata?.["timedOut"] === true) {
              const projectedCount =
                state.selfCorrectionCount +
                pendingSelfCorrects.filter((p) => p.consumesBudget).length;
              if (projectedCount < (state.maxSelfCorrections ?? 0)) {
                pendingSelfCorrects.push({
                  repairPrompt:
                    `[TOOL TIMEOUT] ${toolCall.name} was killed when its timeout expired. ` +
                    "If the command is still needed, retry with a larger `timeout` (milliseconds) " +
                    "or run_in_background=true; otherwise explain the timeout to the user.",
                  consumesBudget: true,
                });
              }
            }

            if (getStatus() !== "executing_tools") break;
          }

          // Flush queued self-correct inputs — they go through the reducer
          // so the repair prompt becomes part of the canonical message
          // history (replay-safe) and the counter bump is observable.
          for (const sc of pendingSelfCorrects) {
            if (cancelled || getStatus() === "done") break;
            forwardEmit(feed({
              type: "self_correct",
              repairPrompt: sc.repairPrompt,
              consumesBudget: sc.consumesBudget,
            }));
          }

          // This batch's tool_call/tool_result events are all recorded now —
          // flush rather than waiting for the next model call or turn end.
          void recorder.flush();
        }

        // Post-batch: if cancelled during parallel execution, transition
        if (cancelled && getStatus() !== "cancelling" && getStatus() !== "done") {
          forwardEmit(feed({ type: "cancel", reason: "abort" }));
        }

        // Loop-ladder injection (spec 2026-10-16 D2): the tier was collected
        // at this batch's model_done; fire it only once the batch fully
        // flushed (status back to calling_model), so EVERY tool_result of the
        // batch — and every pending self-correct — lands in the canonical
        // message history before the repair user message (same delayed-
        // injection ordering rule as pendingSelfCorrects above; at most one
        // item per batch, deduped by the reducer's monotonic bookkeeping).
        // A batch still resolving HITL approvals keeps the item for its next
        // pass; a cancelled or terminated turn drops it.
        if (pendingLoopInjection !== null) {
          if (cancelled || getStatus() === "done") {
            pendingLoopInjection = null;
          } else if (getStatus() === "calling_model") {
            forwardEmit(feed(pendingLoopInjection));
            pendingLoopInjection = null;
          }
        }

        continue;
      }

      // Turn-boundary drain: a model end_turn with uncollected background
      // tasks must not close the turn yet. Feeding completions at status
      // "done" pushes state back to calling_model (Task 7 handler), so the
      // loop continues naturally; if nothing was fed (every running task
      // was already collected via task_output — registry cache only, state
      // still says "running"), the status stays "done" and the turn ends.
      // A cancelled turn skips the drain: reopening it would fight the
      // user's abort.
      if (
        status === "done" &&
        !cancelled &&
        opts.backgroundRegistry !== undefined &&
        (state.backgroundTasks ?? []).some((t) => t.status === "running")
      ) {
        await drainBackgroundTasks({
          state,
          registry: opts.backgroundRegistry,
          feed: (input) => {
            forwardEmit(feed(input));
          },
        });
        if (getStatus() !== "done") continue;
      }

      // Terminal states: done, cancelling, waiting_for_*
      if (status === "cancelling" && cancelled) {
        forwardEmit(feed({ type: "cancel" }));
        continue;
      }

      // done, waiting_for_input, waiting_for_approval — stop
      break;
    }

    // Persist checkpoint at turn boundary (imperative shell I/O).
    // The reducer only emits CheckpointEffect during HITL approval pauses;
    // this ensures every completed turn is durable for resume / audit.
    if (state.status === "done" && opts.sessionStore && opts.sessionId) {
      const now = opts.clock?.now() ?? Date.now();
      await opts.sessionStore.save({
        id: opts.sessionId,
        state,
        createdAt: now,
      });
      checkpointSeq++;
      await opts.sessionStore.save({
        id: `${opts.sessionId}#${checkpointSeq}`,
        state,
        createdAt: now,
      });
    }

    // M13: turn:end hook
    await runHookPipeline(opts.hooks ?? [], "turn:end", {
      sessionId: opts.sessionId,
    });

    if (turnSpan) {
      turnSpan.setAttribute("status", state.status);
      if (turnHadError) turnSpan.setAttribute("error", true);
      turnSpan.end();
    }
  }

  /**
   * Interpret effects that require I/O (checkpoint, request_approval).
   * Checkpoints are persisted FIRST (durable before any approval interaction),
   * so a gate that throws / defers cannot lose the snapshot needed for resume.
   */
  async function interpretEffects(effects: Effect[]): Promise<void> {
    for (const e of effects) {
      if (e.type === "checkpoint" && opts.sessionStore && opts.sessionId) {
        const now = opts.clock?.now() ?? Date.now();
        // Save canonical single-key checkpoint (for resume)
        await opts.sessionStore.save({
          id: opts.sessionId,
          state: e.state,
          createdAt: now,
        });
        // M12: Append checkpoint history (key = sessionId#seq)
        checkpointSeq++;
        await opts.sessionStore.save({
          id: `${opts.sessionId}#${checkpointSeq}`,
          state: e.state,
          createdAt: now,
        });
      }
    }
    for (const e of effects) {
      if (e.type === "request_approval" && opts.approvalGate) {
        askedToolCallIds.add(e.toolCall.id);
        recorder.record(
          "approval_asked",
          { callId: e.toolCall.id, name: e.toolCall.name, riskTier: e.riskTier },
          { step: stepCounter },
        );
        const raw = await opts.approvalGate.ask(e.toolCall, e.riskTier);
        // A gate may answer with a bare decision or with a reason attached.
        const decision = typeof raw === "string" ? raw : raw.decision;
        const reason = typeof raw === "string" ? undefined : raw.reason;
        if (decision === "allow") approvedToolCallIds.add(e.toolCall.id);
        else deniedToolCallIds.add(e.toolCall.id);
        forwardEmit(feed({
          type: "approval_decision",
          toolCallId: e.toolCall.id,
          decision,
          // Carried into the reducer too, not just the transcript: it decides
          // what the denial's tool result tells the model.
          ...(reason !== undefined ? { reason } : {}),
        }));
        recorder.record(
          "approval_decision",
          { callId: e.toolCall.id, decision, ...(reason !== undefined ? { reason } : {}) },
          { step: stepCounter },
        );
        // Audit: record approval decision
        if (opts.auditSink) {
          opts.auditSink.record({
            kind: "approval",
            toolName: e.toolCall.name,
            riskTier: e.riskTier,
            decision,
            timestamp: opts.clock?.now() ?? Date.now(),
            sessionId: opts.sessionId,
          });
        }
      }
    }
  }

  /**
   * Record the turn-closing `turn_end` transcript event, deriving the reason
   * from the same turn-scoped flags run() maintains. Shared by run()'s and
   * resume()'s exit brackets so a turn that paused and was later resumed
   * closes with exactly one correctly-attributed turn_end.
   *
   * A HITL pause is not a turn end: while the state is parked in
   * waiting_for_approval the turn is still open (the checkpoint IS the pause
   * marker), so the bracket is skipped and the log stays unclosed — exactly
   * as it would had the process died mid-turn. The resume() that actually
   * completes the turn records the closing event; a resume that pauses again
   * (a second tool needed approval) leaves it open for the next one.
   */
  function recordTurnEnd(): void {
    if (state.status === "waiting_for_approval") return;
    const reason: TurnEndReason = turnHadBudgetExceeded
      ? "budget_exceeded"
      : turnHadError
        ? "error"
        : cancelled
          ? "cancelled"
          : "done";
    lastTurnEnd = { reason, ...(turnTerminalError !== undefined ? { error: turnTerminalError } : {}) };
    recorder.record("turn_end", {
      turn: opts.turn ?? 0,
      reason,
      // Without this a turn cut off by a cap / guard / truncated stream is
      // indistinguishable from a clean completion in the transcript and on
      // the wire (the reducer's raw error emit is never persisted).
      ...(turnTerminalError !== undefined ? { error: turnTerminalError } : {}),
    });
  }

  return {
    async run(initialInput: AgentInput): Promise<ReducerState> {
      try {
        // Reset budget tracking for this turn
        turnStartTime = Date.now();
        cumulativeCost = 0;
        cumulativeTokens = 0;
        turnHadError = false;
        turnHadBudgetExceeded = false;
        turnTerminalError = undefined;
        lastTurnEnd = undefined;
        // M13: session:start hook
        await runHookPipeline(opts.hooks ?? [], "session:start", {
          sessionId: opts.sessionId,
        });

        // T10 Task 3 — userPromptSubmit hook (spec 2026-10-17, D3 / F-031):
        // runs BEFORE the user_message feed opens the turn (the idle →
        // calling_model transition). A deny rejects the prompt outright: the
        // turn never starts, no model call is made, and the rejection text —
        // the verbatim spec §4.2 template — lands in the message history as
        // the user-visible outcome. Same early-exit shape as the budget path
        // (message + done, never calling_model). The reducer's idle handler
        // only knows how to OPEN a turn, so the deny closes it here in the
        // shell: message appended with an Id-port stamp (same stamping rule
        // as the reducer's own appends) and status set to done. The finally
        // block below still closes the bracket (turn_end), flushes the
        // recorder, and runs session:end.
        if (initialInput.type === "user_message") {
          const promptText =
            typeof initialInput.content === "string"
              ? initialInput.content
              : initialInput.content
                  .filter(
                    (b): b is Extract<ContentBlock, { type: "text" | "structured" }> =>
                      b.type === "text" || b.type === "structured",
                  )
                  .map((b) => b.text)
                  .join(" ");
          const promptOutcome = await runHookPipeline(opts.hooks ?? [], "userPromptSubmit", {
            sessionId: opts.sessionId,
            prompt: promptText,
          });
          if (promptOutcome.action === "deny") {
            const rejectionText = `[prompt rejected by hook: ${promptOutcome.reason}]`;
            state = {
              ...state,
              messages: [
                ...state.messages,
                {
                  id: stepContext.id?.next() ?? "",
                  role: "user",
                  content: rejectionText,
                },
              ],
              status: "done",
            };
            recorder.record("turn_start", { turn: opts.turn ?? 0 });
            recorder.record("user_message", { content: rejectionText });
            // The turn closed without opening — buffered steering input must
            // still land (queued into the done state) instead of dying in
            // the buffer.
            turnOpened = true;
            drainPreOpenQueue();
            return state;
          }
        }

        recorder.record("turn_start", { turn: opts.turn ?? 0 });
        // Only a user_message input opens the turn with a transcript
        // user_message. A steering_flush turn must record NO user_message:
        // the queued content already rode its steering_queued records and is
        // realized by steering_delivered — recording it again here would
        // double-cover the same content.
        if (initialInput.type === "user_message") {
          recorder.record("user_message", {
            content: initialInput.content,
            ...(initialInput.source === undefined ? {} : { source: initialInput.source }),
          });
        }
        // Persist the turn opening before any model I/O: a client that
        // reconnects mid-turn rebuilds the live state from this log tail
        // (`GET /sessions/:id/events?tail=1`), and without the flush it would
        // see nothing until the first model call returns.
        void recorder.flush();

        forwardEmit(feed(initialInput));
        turnOpened = true;
        // Steering input buffered before the open queues right after the
        // opening message (D4) — never opening the turn itself, never lost.
        drainPreOpenQueue();
        runLoopActive = true;
        try {
          await runLoop();
        } finally {
          runLoopActive = false;
        }
        return state;
      } catch (err) {
        // An exception escaping the loop is not a normal error path (those
        // are normalized to isError ToolResults / model_error inputs and
        // never throw) — but if one somehow does, the turn still ended in
        // error and the transcript should say so. The message itself is
        // recorded by whichever caller owns the throw (the SDK writes an
        // `error` event); turn_end only carries `reason: "error"` here.
        turnHadError = true;
        throw err;
      } finally {
        // Every exit from this turn — normal completion, cancellation, or an
        // escaping exception — must close out the transcript: bracket the
        // turn and flush whatever the recorder has buffered. A try/finally
        // around the whole body is what guarantees that regardless of which
        // branch above returned or threw. The one exception is a HITL pause:
        // the turn is still open then (the checkpoint IS the pause marker),
        // so recordTurnEnd() skips the bracket and the resume() that
        // eventually completes the turn writes it instead. The session:end
        // hook and cleanup below still run on a pause — the turn is parked,
        // not the runner.
        recordTurnEnd();
        await recorder.flush();

        // M13: session:end hook
        await runHookPipeline(opts.hooks ?? [], "session:end", {
          sessionId: opts.sessionId,
        });
        cleanup();
      }
    },

    getState(): ReducerState {
      return state;
    },

    getLastTurnEnd() {
      return lastTurnEnd;
    },

    send(input: AgentInput): void {
      // Before the turn opens, an input the idle state would turn into a
      // turn opener (user_message / steering_flush / file_changed) is held
      // until the open — it must queue behind the real opening input, not
      // replace it. Everything else passes through immediately: a
      // steering_edit / steering_remove never opens a turn and must land
      // before the opening flush delivers its target ("delivery wins").
      const opensFromIdle =
        input.type === "user_message" ||
        input.type === "steering_flush" ||
        input.type === "file_changed";
      if (!turnOpened && opensFromIdle) {
        preOpenQueue.push(input);
        return;
      }
      forwardEmit(feed(input));
      // A steering send can land after this turn's run loop ended — the
      // settle window where the host still treats the turn as live and
      // routes steer()/updateQueue() here. The turn's own flush has already
      // run by then, so the record would sit in the buffer forever and
      // never reach the durable transcript (the queue-rebuild fold would
      // lose the entry). When no run loop is active, flush fire-and-forget;
      // during a loop the periodic and turn-end flushes already cover the
      // buffer.
      if (!runLoopActive) void recorder.flush();
    },

    async compactNow(): Promise<CompactNowResult | null> {
      // Only idle / done are safe: any other status means a turn is in
      // flight and writing back would race the model/tool loop.
      if (state.status !== "idle" && state.status !== "done") {
        throw new CompactionBusyError(state.status);
      }
      if (!opts.compaction) return null;

      const tokenizer = opts.compaction.tokenizer;
      const beforeTokens = estimateTokens(state.messages, tokenizer);

      const outcome = await runCompactionWriteBack(state.messages);

      // No write-back landed at all — under threshold, nothing compressible,
      // or summarization failed without a prune. Nothing to report.
      // A prune-only pass (didWriteBack=true, replacedCount=0) DID change
      // state.messages and must return a result, not null.
      if (!outcome.didWriteBack) return null;

      const afterTokens = estimateTokens(state.messages, tokenizer);
      return {
        replacedCount: outcome.replacedCount,
        tokensFreedEstimate: Math.max(0, beforeTokens - afterTokens),
      };
    },

    async resume(resumeSessionId: string, decision: "allow" | "deny"): Promise<ReducerState> {
      if (!opts.sessionStore) {
        throw new Error("Cannot resume: no sessionStore configured");
      }
      const snapshot = await opts.sessionStore.load(resumeSessionId);
      if (!snapshot) {
        throw new Error(`Session not found: ${resumeSessionId}`);
      }
      state = snapshot.state as ReducerState;
      if (state.status !== "waiting_for_approval") {
        throw new Error(
          `Cannot resume session ${resumeSessionId}: expected status "waiting_for_approval" but got "${state.status}"`,
        );
      }
      if (!state.pendingApprovalTool) {
        throw new Error(
          `Cannot resume session ${resumeSessionId}: checkpoint missing pendingApprovalTool (corrupted or stale)`,
        );
      }
      const approvedId = state.pendingApprovalTool.id;
      const approvedName = state.pendingApprovalTool.name;
      // Everything from here on is bracketed like run() (try/finally below):
      // the turn run() left open at the pause gets its closing turn_end here
      // on every exit path, and the recorder flushes before resume() resolves.
      // The validation throws above deliberately sit OUTSIDE the bracket — no
      // turn ran in this runner yet, so there is nothing to close.
      try {
        lastTurnEnd = undefined;
        // The paused turn is already open: anything send() buffered before
        // this resume lands in its queue (waiting_for_approval queues, D4).
        turnOpened = true;
        drainPreOpenQueue();
        // Pre-authorize (or pre-deny) the re-queued tool so runLoop's partition
        // loop does not re-classify it into a fresh approval ask — mirrors the
        // allow/deny bookkeeping in interpretEffects's own request_approval
        // handling.
        if (decision === "allow") approvedToolCallIds.add(approvedId);
        else deniedToolCallIds.add(approvedId);
        // This Runner instance is typically fresh for a resume (see the SDK's
        // cross-process resume path), so the original `approval_asked` record —
        // buffered by the runner that first asked — may never have been
        // flushed to the store (it was still sitting in that runner's buffer
        // when the process paused/restarted). Recording it again here from the
        // checkpoint data is what makes it durable in that case. But when this
        // IS the same Runner that already asked (the ordinary in-process HITL
        // flow, where the SDK's resume() succeeds via `lastRunner.resume()`),
        // askedToolCallIds already has this id — skip the rewrite so the two
        // records (this one lacks `step`; the original carries it) don't both
        // land in the store for the same callId.
        if (!askedToolCallIds.has(approvedId)) {
          const approvedRiskTier = visibleTools.find((t) => t.name === approvedName)?.riskTier ?? "WRITE_HIGH";
          recorder.record("approval_asked", { callId: approvedId, name: approvedName, riskTier: approvedRiskTier });
          askedToolCallIds.add(approvedId);
        }
        forwardEmit(feed({
          type: "approval_decision",
          toolCallId: approvedId,
          decision,
        }));
        // No `step` here: no model call has run on this Runner instance yet
        // (it is typically fresh for a resume — see the SDK's cross-process
        // resume path), so there is no step the decision belongs to. A seeded
        // `initialStep` changes nothing: it raises the counter for the NEXT
        // model call but still leaves this record step-less — 0 is not a
        // valid step anyway (ports.ts documents step as 1-based). Omitting it
        // is correct, not just a fallback.
        recorder.record("approval_decision", { callId: approvedId, decision });
        runLoopActive = true;
        try {
          await runLoop();
        } finally {
          runLoopActive = false;
        }
        return state;
      } catch (err) {
        // Same discipline as run(): an exception escaping the resumed loop
        // means the turn ended in error, so recordTurnEnd()'s reason
        // derivation below reports "error" instead of "done".
        turnHadError = true;
        throw err;
      } finally {
        // run() left this turn open at the HITL pause (no turn_end — the
        // checkpoint was the pause marker, not a close). THIS runner is what
        // completes the turn, so it writes the bracket here on every exit
        // path. recordTurnEnd() itself skips the bracket if the resumed turn
        // paused AGAIN (a second tool needed approval), leaving the turn open
        // for the next resume — same rule run() follows.
        //
        // Flush so a caller that reads chatStore right after resume()
        // resolves sees this batch's writes (assistant_message included) on
        // disk, not still sitting in the recorder's buffer.
        recordTurnEnd();
        await recorder.flush();
      }
    },
  };
}

// ──────────────────────────────────────────────
// ModelEvent → AgentInput conversion
// ──────────────────────────────────────────────

/** Most restrictive permission: deny > ask > allow */
function mostRestrictive(
  a: "allow" | "deny" | "ask",
  b: "allow" | "deny" | "ask",
): "allow" | "deny" | "ask" {
  const rank = { deny: 3, ask: 2, allow: 1 };
  return rank[a] >= rank[b] ? a : b;
}

/** Values of a tool's declared command inputs, in declaration order. */
function collectCommandValues(
  fields: readonly string[],
  input: Record<string, unknown>,
): string[] | undefined {
  const values: string[] = [];
  for (const field of fields) {
    const raw = input[field];
    if (typeof raw === "string" && raw.length > 0) values.push(raw);
  }
  return values.length > 0 ? values : undefined;
}

/** Extract the text content of the last user message for RAG query building */
function extractLastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      return typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter(
              (b): b is Extract<ContentBlock, { type: "text" | "structured" }> =>
                b.type === "text" || b.type === "structured",
            )
            .map((b) => b.text)
            .join(" ");
    }
  }
  return "";
}

/**
 * Widen a stamped transcript event to the EventSink's declared `{type, data}`
 * shape. The transcript stamp (`time`/`turn`/`step`) intentionally rides along
 * as top-level extras — the wire payload IS the persisted event (task-r6), and
 * sink consumers that care only about `type`/`data` ignore the rest. Only
 * `data` needs widening: the sink types it as an untyped Record while a
 * transcript event carries a specific vocabulary shape.
 */
function toSinkEvent(event: TranscriptEventInput): {
  type: string;
  data: Record<string, unknown>;
  time: number;
  turn?: number;
  step?: number;
} {
  return {
    type: event.type,
    data: event.data as unknown as Record<string, unknown>,
    time: event.time,
    ...(event.turn !== undefined ? { turn: event.turn } : {}),
    ...(event.step !== undefined ? { step: event.step } : {}),
  };
}

function modelEventToInputs(
  event: ModelEvent,
  pendingUsage?: TokenUsage,
): AgentInput[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "model_chunk", chunk: { type: "text_delta", text: event.text } }];
    case "reasoning_delta":
      return [{ type: "model_chunk", chunk: { type: "reasoning_delta", text: event.text } }];
    case "tool_use_start":
      return [
        {
          type: "model_chunk",
          chunk: {
            type: "tool_use_delta",
            toolCallId: event.toolCallId,
            toolCallName: event.toolName,
          },
        },
      ];
    case "tool_use_delta":
      return [
        {
          type: "model_chunk",
          chunk: {
            type: "tool_use_delta",
            toolCallId: event.toolCallId,
            argumentsDelta: event.argumentsDelta,
          },
        },
      ];
    case "usage":
      return [];
    case "done":
      return [
        {
          type: "model_done",
          stopReason: event.stopReason,
          usage: pendingUsage,
          ...(event.meta !== undefined ? { meta: event.meta } : {}),
        },
      ];
    case "error":
      return [
        {
          type: "model_error",
          error: event.error,
          retriable: event.retriable,
        },
      ];
    default:
      return [];
  }
}
