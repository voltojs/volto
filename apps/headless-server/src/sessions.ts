/**
 * Session registry — one agent instance and one SSE channel per session id.
 *
 * A `createAgent` instance carries its own conversation history forward between
 * turns, so multi-turn chat requires one agent per session rather than one per
 * process. The registry also owns the live SSE connection for a session and a
 * small replay buffer so a client that reconnects with `Last-Event-ID` does not
 * lose events emitted while it was away.
 */

import type * as http from "node:http";
import * as crypto from "node:crypto";
import { sse, mergeQueuedEdit, type CreateAgentOptions } from "@volto/sdk";
import type { Message, ModelPort, TranscriptEvent, TranscriptEventInput, CompactionConfig, AgentInput, PermissionRule, ModelInputValue, UserMessage, SteeringEditInput, SteeringRemoveInput } from "@volto/core";
import { projectMessages, isPermissionReminder, tokenizeCommand, isMatchableCommandToken, pendingSteeredMessages } from "@volto/core";
import type { JsonlSessionStore, ChatSessionRecord } from "@volto/store-jsonl";
import { scopeToWorkspace } from "@volto/store-jsonl";
import { createPiAiModelPort, type ConfiguredProtocol, type PiAiProviderConfig, type ProviderAuth, type ProviderProtocol } from "@volto/provider-pi-ai";
import { t } from "@volto/i18n";
import { createWiredAgent, type WiringOptions } from "./wiring.js";
import { buildPermissionConfig, sandboxModeFor, type UiPermissionMode } from "./permission-modes.js";
import { resolveProjectPath, unknownProjectMessage, type createProjectStore } from "./config/projects.js";
import type { createProviderStore } from "./config/providers.js";
import { createApprovalRegistry, type ApprovalDecision, type ApprovalRegistry, type ApprovalRegistryHooks } from "./approval-gate.js";
import { createRoutingTierStore } from "./config/routing-tiers.js";
import { deriveHeuristicTitle, firstUserMessageText, generateTitle, messageText } from "./session-title.js";
import { activeLocale, readPreferences } from "./config/preferences.js";
import { getConfigDir, getConfigDirRealPath } from "./config/paths.js";
import { savePermissionRule } from "./config/permissions.js";
import type { StoreFor } from "./attachments/store.js";

export interface SessionRegistryOptions extends Omit<WiringOptions, "chatStore" | "attachmentStore"> {
  /**
   * Per-session attachment store factory, shared with the /attachments
   * routes. Session-scoped, so it is a factory here rather than the single
   * `attachmentStore` WiringOptions takes.
   */
  attachmentStoreFor?: StoreFor;
  /** Maximum number of live sessions before the oldest is evicted. @default 100 */
  maxSessions?: number;
  /** Events retained per session for Last-Event-ID replay. @default 200 */
  replayBufferSize?: number;
  /** SSE heartbeat interval in ms. @default 15000 */
  heartbeatInterval?: number;
  /**
   * How long a steer waits for a cold-window agent (the latch is held by a
   * turn whose agent has not materialized yet) before giving up and
   * reporting. @default STEER_AGENT_WAIT_MS
   */
  steerAgentWaitMs?: number;
  projectStore?: ReturnType<typeof createProjectStore>;
  providerStore?: ReturnType<typeof createProviderStore>;
  /**
   * Builds the ModelPort used to NAME a session (spec 2026-10-30 D2), or
   * null when no title model is configured. Defaults to resolving the
   * `titleProviderId`/`titleModelId` preferences through the provider store —
   * the same path a sub-agent tier target takes. A seam because a title write
   * happens on a background task a test cannot otherwise observe.
   */
  titleModelPortFactory?: () => Promise<{ modelPort: ModelPort; model: string } | null>;
  /** Overridable agent constructor — production uses createWiredAgent. */
  agentFactory?: typeof createWiredAgent;
  /**
   * Durable transcript of every chat session's config bindings and messages.
   * Optional: when absent, sessions still work, just without a durable
   * record — this is a recorder, not something the turn's correctness
   * depends on, so a missing store degrades silently rather than failing.
   */
  chatStore?: JsonlSessionStore;
}

export interface TurnConfig {
  projectId?: string;
  providerId?: string;
  modelId?: string;
  permissionMode?: UiPermissionMode;
  /**
   * Reasoning effort requested for this turn — forwarded verbatim to
   * createAgent()'s own `reasoningEffort` option. Validated in resolveConfig()
   * against the resolved model's declared capability before any provider I/O;
   * an unsupported value throws rather than being silently rewritten (mirrors
   * `permissionMode`'s parallel structure at every site below).
   */
  reasoningEffort?: string;
}

/** Snapshot of what an agent instance was built from. */
interface ResolvedConfig {
  projectPath: string | undefined;
  /** The bound project's id — distinct from `projectPath`, needed verbatim for chatMeta's config binding. */
  projectId: string | undefined;
  providerId: string | undefined;
  modelId: string | undefined;
  /** Wire protocol resolved for this turn; part of the rebuild identity. */
  protocol: string | undefined;
  /** Resolved from the provider record so an in-place edit is detected too. */
  baseURL: string | null | undefined;
  code: string | undefined;
  /** Per-call output cap from the model record; undefined means the provider default. */
  maxOutputTokens: number | undefined;
  /** Declared context window from the model record; undefined falls back to the adapter's catalog. */
  contextWindow: number | undefined;
  /**
   * SHA-256 hex digest of the resolved apiKey — never the plaintext. Lets a
   * rotated key be distinguished from an unchanged one without storing the
   * secret on the session.
   */
  keyFingerprint: string | undefined;
  permissionMode: UiPermissionMode | undefined;
  reasoningEffort: string | undefined;
}

/**
 * Shape returned by providerStore.resolveModel — see config/providers.ts.
 * Both kinds are consumed by `rebuild()` below: each is projected into a
 * `PiAiProviderConfig` (same discriminant) and handed to `createWiredAgent`
 * via `WiringOptions.providerConfig`, which builds the actual ModelPort.
 */
export type ResolvedCredentials =
  | {
      kind: "catalog";
      piProvider: string;
      baseURL: string | null;
      apiKey: string | null;
      code: string;
      protocol?: ConfiguredProtocol;
      modelProtocol?: ProviderProtocol;
      auth?: ProviderAuth;
      headers?: Record<string, string>;
      maxOutputTokens?: number;
      /** Declared context window; absent = follow the catalog. */
      contextWindow?: number;
      /** User override of pi-ai's catalog reasoning flag; absent = follow catalog. */
      reasoning?: boolean;
      /** User input-modalities override/declaration; absent = follow catalog / UNKNOWN. */
      input?: ModelInputValue;
    }
  | {
      kind: "custom";
      baseURL: string | null;
      apiKey: string | null;
      code: string;
      protocol?: ProviderProtocol;
      auth?: ProviderAuth;
      headers?: Record<string, string>;
      maxOutputTokens?: number;
      /** Declared context window; absent = the adapter's 128k fallback. */
      contextWindow?: number;
      reasoning?: boolean;
      /** User input-modalities override/declaration; absent = follow catalog / UNKNOWN. */
      input?: ModelInputValue;
    };

/**
 * A session with no project/model/permission selection yet — used by
 * `ensureAgent()` for the legacy `/run` route, which never builds a
 * `TurnConfig`. `permissionMode` must still be set (not `undefined`) for the
 * same reason as `resolveConfig()` above: leaving it `undefined` skips
 * rebuild()'s entire permissionConfig/sandboxMode/approvalGate branch and
 * hands this legacy path the widest possible agent (workspace-write +
 * auto-allow) instead of the narrowest working tier.
 *
 * Unlike `resolveConfig()`, this must NOT default to "ask": `/run` is a
 * blocking JSON route with no event channel at all — no SSE, no way for a
 * client to ever learn a pending approval's `callId`, and `interrupt()`
 * cannot rescue it either (it requires `session.running`, which only
 * `runTurn()` sets). An "ask" preset here would let the first WRITE_HIGH
 * tool call park on the approval gate forever with nobody able to answer
 * it. "read-only" is `approval: "never"`, so the gate is never consulted —
 * and it is the narrowest tier, the correct default for a caller that
 * supplied no preference on a route that cannot ask a human.
 */
/**
 * How long POST /messages may hold a request waiting for a first turn's
 * agent to materialize — the session's latch is already held but rebuild()
 * has not finished building the instance a steer() would deliver to. Bounded
 * so a stuck build answers with a defined retryable error instead of hanging
 * the request, and never a 202 for a message that was not delivered (D10's
 * "never silently lost" rule). Generous enough to cover a cold rebuild.
 */
export const STEER_AGENT_WAIT_MS = 2000;

const EMPTY_CONFIG: ResolvedConfig = {
  projectPath: undefined,
  projectId: undefined,
  providerId: undefined,
  modelId: undefined,
  protocol: undefined,
  baseURL: undefined,
  code: undefined,
  maxOutputTokens: undefined,
  contextWindow: undefined,
  keyFingerprint: undefined,
  permissionMode: "read-only",
  reasoningEffort: undefined,
};

/**
 * Project a resolved credential into the `PiAiProviderConfig` shape
 * `createPiAiModelPort` expects — shared by `rebuild()` (to build the real
 * agent's ModelPort) and `assertSupportedReasoningEffort()` (to look up the
 * resolved model's declared reasoning capability without making any provider
 * I/O — `describeModel` on the resulting port is a pure, synchronous
 * projection of already-known config/catalog data, never a network call).
 */
function buildProviderConfig(providerId: string | undefined, credentials: ResolvedCredentials): PiAiProviderConfig {
  return credentials.kind === "catalog"
    ? {
        kind: "catalog",
        id: providerId ?? "default",
        piProvider: credentials.piProvider,
        apiKey: credentials.apiKey ?? undefined,
        // Only when overridden: an absent baseURL leaves pi-ai's own catalog
        // address in place (collection.ts's buildCatalogProvider).
        ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}),
        ...(credentials.protocol === undefined ? {} : { protocol: credentials.protocol }),
        ...(credentials.modelProtocol === undefined
          ? {}
          : { modelProtocols: { [credentials.code]: credentials.modelProtocol } }),
        ...(credentials.auth === undefined ? {} : { auth: credentials.auth }),
        ...(credentials.headers === undefined ? {} : { headers: credentials.headers }),
        modelCodes: [credentials.code],
        // Same for reasoning: only a stored override is forwarded, so an
        // untouched model keeps tracking pi-ai's catalog flag.
        ...(credentials.reasoning !== undefined
          ? { reasoningOverrides: { [credentials.code]: credentials.reasoning } }
          : {}),
        ...(credentials.input !== undefined
          ? { inputOverrides: { [credentials.code]: credentials.input } }
          : {}),
      }
    : {
        kind: "custom",
        id: providerId ?? "default",
        // Mirrors provider-openai's own default when no baseURL is resolved.
        baseURL: credentials.baseURL ?? "https://api.openai.com",
        apiKey: credentials.apiKey ?? undefined,
        ...(credentials.protocol === undefined ? {} : { protocol: credentials.protocol }),
        ...(credentials.auth === undefined ? {} : { auth: credentials.auth }),
        ...(credentials.headers === undefined ? {} : { headers: credentials.headers }),
        models: [
          {
            code: credentials.code,
            reasoning: credentials.reasoning,
            ...(credentials.input === undefined ? {} : { input: credentials.input }),
          },
        ],
      };
}

/**
 * Credential resolution for one tier target — the same
 * resolveModel→credentials projection `rebuild()` applies to the turn's own
 * model. A parameter rather than a hard-wired `providerStore.resolveModel`
 * so tests can inject fake credentials without faking the whole store.
 */
export type SubagentCredentialsResolver = (target: {
  providerId: string;
  modelId: string;
}) => Promise<ResolvedCredentials | null>;

/**
 * The SDK's per-dispatch subagent ModelPort factory contract (spec
 * 2026-10-29 D6) — pinned to `CreateAgentOptions.resolveSubagentModelPort`
 * so the two can never drift apart.
 */
export type SubagentModelPortResolver = NonNullable<
  CreateAgentOptions["resolveSubagentModelPort"]
>;

/**
 * Per-dispatch subagent ModelPort factory (spec 2026-10-29 D6) — the host
 * side of `CreateAgentOptions.resolveSubagentModelPort`. For one tier target
 * it:
 *
 * 1. resolves the target through the credentials resolver (by default the
 *    provider store's `resolveModel` — the exact path `rebuild()` uses for
 *    the turn's own model); an unresolvable target answers `null`, which the
 *    SDK turns into a visible degrade-to-parent for definition references;
 * 2. projects the credentials through `buildProviderConfig` and builds a
 *    single-model port routed on the TARGET provider's config id (same
 *    construction path as `assertSupportedReasoningEffort`);
 * 3. attaches the tier model's capability facts so the child dispatch gates
 *    images and sizes compaction against the tier model, not the parent's.
 *    A stored declaration wins over the adapter's `describeModel` answer —
 *    the precedence the main agent already applies (rebuild forwards the
 *    declared window; createWiredAgent falls back to describeModel, see
 *    wiring.ts) — and anything still unknown is left OUT of the resolution
 *    so the SDK inherits the parent's value.
 *
 * Every call builds a fresh port (same as `assertSupportedReasoningEffort`;
 * no caching — YAGNI).
 */
export function buildSubagentModelPortFactory(
  providerStore: Pick<ReturnType<typeof createProviderStore>, "resolveModel">,
  credentialsResolver: SubagentCredentialsResolver = (target) =>
    providerStore.resolveModel(target.providerId, target.modelId),
): SubagentModelPortResolver {
  return async (target) => {
    const credentials = await credentialsResolver(target);
    if (!credentials) return null;
    const providerConfig = buildProviderConfig(target.providerId, credentials);
    const modelPort = createPiAiModelPort({
      providers: [providerConfig],
      defaultProviderId: providerConfig.id,
    });
    let describedInput: ModelInputValue | undefined;
    let describedWindow: number | undefined;
    if (modelPort.describeModel) {
      try {
        const info = await modelPort.describeModel(credentials.code);
        describedInput = info.input;
        describedWindow = info.contextWindow;
      } catch {
        // A model the adapter cannot describe: only the stored declarations
        // remain as facts. Never fail the resolution over metadata.
      }
    }
    const input = credentials.input ?? describedInput;
    // Tri-state, matching core's `input` semantics: absent = UNKNOWN, which
    // leaves the field out (the SDK inherits the parent's gate); only an
    // explicit list decides, and a text-only list is what refuses images.
    const visionSupported = input?.includes("image");
    const contextWindow = credentials.contextWindow ?? describedWindow;
    return {
      modelPort,
      model: credentials.code,
      ...(visionSupported !== undefined ? { visionSupported } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  };
}

/**
 * Validates a requested `reasoningEffort` against the resolved model's
 * declared capability, throwing when unsupported. This is the first line of
 * defense named in the phase-one contract: the pi-ai ModelPort adapter
 * itself repeats an equivalent check immediately before its own provider
 * request as a last line of defense, but a turn must never reach that point
 * — an unsupported effort must fail here, before rebuild()/createAgent() are
 * ever invoked, not be silently rewritten to something the model accepts.
 */
async function assertSupportedReasoningEffort(
  providerId: string | undefined,
  credentials: ResolvedCredentials,
  reasoningEffort: string,
): Promise<void> {
  const providerConfig = buildProviderConfig(providerId, credentials);
  const port = createPiAiModelPort({ providers: [providerConfig], defaultProviderId: providerConfig.id });
  const info = await port.describeModel!(credentials.code);
  const supported = info.reasoning?.efforts.map((effort) => effort.id as string) ?? [];
  if (!supported.includes(reasoningEffort)) {
    throw new Error(
      `Unsupported reasoningEffort "${reasoningEffort}" for model "${credentials.code}"; ` +
        `supported: ${supported.length > 0 ? supported.join(", ") : "(none)"}`,
    );
  }
}

/**
 * Validates that a turn carrying images runs against a model that can read
 * them, throwing when the model declares a text-only input list.
 *
 * The composer already hides its attachment entry for such a model, but UI
 * gating is not a boundary — a direct API call must be refused too. Only an
 * explicit `["text"]` gates: UNKNOWN (an absent list, e.g. a gateway that
 * cannot describe its models) goes through and degrades to whatever the
 * provider answers, per spec §7.
 */
async function assertImageInputSupported(
  providerId: string | undefined,
  credentials: ResolvedCredentials,
): Promise<void> {
  const providerConfig = buildProviderConfig(providerId, credentials);
  const port = createPiAiModelPort({ providers: [providerConfig], defaultProviderId: providerConfig.id });
  const info = await port.describeModel!(credentials.code);
  if (info.input !== undefined && !info.input.includes("image")) {
    throw new Error(
      `Model "${credentials.code}" does not support image input; remove the attachments or switch models`,
    );
  }
}

/** SHA-256 hex digest of an apiKey, for change detection without storing the secret. */
function fingerprintApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Constant-time comparison of two tokens. A plain `===` leaks timing
 * information proportional to the length of the matching prefix, which
 * matters here: the token's only job is to be an unguessable secret, so
 * comparing it must not itself become a side channel.
 */
function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a same-length comparison so a length mismatch takes the same
    // code path as a same-length mismatch instead of short-circuiting
    // immediately (timingSafeEqual itself throws on unequal lengths).
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Plan 2 default-on: when the host does not configure compaction at all,
 * sessions get these host-chosen defaults rather than "never compact".
 * Explicit `compaction: false` still disables (see resolveHostCompaction).
 *
 * Deliberately no `maxTokens`: the threshold is derived per model from its
 * context window by createAgent (0.8 × window, minus the output cap and a
 * headroom of min(65,536, 10% of the window)) so a
 * 1M-token model is not compacted at 60k. The fixed 60k remains only as the
 * fallback for adapters that cannot report a window.
 */
const DEFAULT_COMPACTION: Omit<CompactionConfig, "tokenizer" | "maxTokens"> = {
  recentKeepCount: 4,
  toolResultMaxChars: 8192,
  summaryMaxTokens: 4096,
};

/**
 * Plan 2: absent config → DEFAULT_COMPACTION (compaction ON by default);
 * explicit `false` disables; an object is used as-is. Never silently
 * invents values beyond the documented defaults above.
 */
function resolveHostCompaction(
  configured:
    | (Omit<CompactionConfig, "tokenizer" | "maxTokens"> & { maxTokens?: number })
    | false
    | undefined,
):
  | (Omit<CompactionConfig, "tokenizer" | "maxTokens"> & { maxTokens?: number })
  | undefined {
  if (configured === false) return undefined;
  return configured ?? DEFAULT_COMPACTION;
}

/**
 * What the user decided to remember about a command approval.
 */
export interface RememberedRule {
  rule: PermissionRule;
  outcome: "saved" | "duplicate" | "covered";
  /** The saved rule is applied by the session rebuild at the start of the next turn. */
  effectiveFrom: "next_turn";
}

/**
 * Outcome of `decideApproval` — see its doc comment for the full contract.
 *
 * When the caller included `rememberCount` and the approval settled as allow,
 * the outcome carries a `RememberedRule` receipt so the route can build the
 * response.  A `rememberError` is a *semantic* failure (untokenizable command,
 * out-of-range prefix, non-matchable token) — the approval itself succeeded;
 * only the "remember" sidecar failed.
 */
export type ApprovalDecisionOutcome =
  | { status: "forbidden" }
  | { status: "unknown" }
  | { status: "ok"; remembered?: RememberedRule; rememberError?: string };

/**
 * One action on a queued (not yet delivered) message — `POST /messages/queue`'s
 * `action` field: edit keeps the id and replaces the content (D14), remove is
 * a hard delete (D15).
 */
export type QueuedMessageAction =
  | { kind: "edit"; content: string }
  | { kind: "remove" };

/**
 * Highest `turn` ordinal among a session's `turn_start` events, or
 * `undefined` for an empty or turn-less log. Passed to createAgent() as
 * `initialTurn` (via WiringOptions) so a rebuilt agent instance continues
 * turn numbering instead of restarting at 1 — see CreateAgentOptions.initialTurn
 * in @volto/sdk. `undefined` means "omit the option entirely", not "0":
 * createAgent() treats an explicit 0 as a real seed (next turn = 1), which
 * happens to be indistinguishable from the default here, but omission is the
 * more honest signal for "no prior transcript".
 */
function highestTurnStart(events: readonly TranscriptEvent[]): number | undefined {
  let max: number | undefined;
  for (const event of events) {
    if (event.type !== "turn_start" || event.turn === undefined) continue;
    if (max === undefined || event.turn > max) max = event.turn;
  }
  return max;
}

/**
 * Highest `step` number stamped on a given turn's events, or `undefined`
 * when that turn has no step-stamped events. Passed to createAgent() as
 * `initialStep` (via WiringOptions) so a rebuilt agent instance's
 * cross-process resume Runner continues the paused turn's step sequence
 * instead of restarting at 1 — see CreateAgentOptions.initialStep in
 * @volto/sdk. `undefined` means "omit the option entirely", not "0",
 * mirroring highestTurnStart's convention above.
 */
function highestStepInTurn(events: readonly TranscriptEvent[], turn: number): number | undefined {
  let max: number | undefined;
  for (const event of events) {
    if (event.turn !== turn || event.step === undefined) continue;
    if (max === undefined || event.step > max) max = event.step;
  }
  return max;
}

/**
 * The conversation's workspace instruction layers, recovered from the most
 * recent `request_header` (which mirrors them as `systemLayers` for audit).
 * Passed to createAgent() as `initialContextLayers` so a rebuilt instance
 * keeps the once-resolved set instead of re-reading instruction files.
 * `undefined` when the transcript has no header yet (fresh conversation, or
 * a rebuild before the first model call).
 */
function contextLayersFromHeader(
  events: readonly TranscriptEvent[],
): Array<{ id: string; text: string }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "request_header") continue;
    const data = event.data as { systemLayers?: Array<{ id: string; text: string }> };
    const layers = (data.systemLayers ?? []).filter((l) => l.id !== "system-prompt");
    return layers;
  }
  return undefined;
}

/**
 * True when the agent has no state source at all: `getState()` throws iff
 * `lastRunner` and `lastFinalState` are both null — precisely the
 * precondition of `updateQueue`'s seed branch (create-agent.ts), and
 * `steerTarget` is only ever set alongside `lastRunner` (cleared first at a
 * turn claim), so a throwing instance can never take the runner branch
 * either. Purely synchronous (no awaits) — safe to pair with a same-span
 * seed-membership check for persist-first ordering.
 */
function isSeedPhase(agent: { getState(): unknown }): boolean {
  try {
    agent.getState();
    return false;
  } catch {
    // "No active session. Run a turn first." — the documented never-ran throw.
    return true;
  }
}

interface Connection {
  res: http.ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
  /**
   * Fresh random token generated in `attach()` and delivered to the client
   * exactly once, over this exact connection, as the CONNECTED frame's
   * payload — see the module comment on `decideApproval` for why this is
   * what makes `POST /approvals` safe against a sandboxed process that can
   * reach the gateway's own port but never saw this channel.
   */
  token: string;
}

/** Who produced a session title; decides what may overwrite it. */
export type TitleSource = "user" | "model" | "heuristic";

/**
 * Higher wins. `user` is what a human typed, `model` a generated title, and
 * `heuristic` the first message truncated — the fallback that is only ever
 * improved on, never allowed to land last.
 */
const TITLE_SOURCE_RANK: Record<TitleSource, number> = {
  user: 3,
  model: 2,
  heuristic: 1,
};

/**
 * Outcome of a title write: `missing` also covers a transcript that could not
 * be read or appended to, which is the same "nothing changed" answer for
 * every caller.
 */
export type TitleWriteResult = "written" | "outranked" | "missing";

interface Session {
  id: string;
  agent: Awaited<ReturnType<typeof createWiredAgent>> | null;
  /**
   * The seed queue array handed to the current agent as `initialQueuedInputs`
   * — createAgent holds THIS reference as its `seedQueuedInputs` and mutates
   * it in place on the seed path. Set by rebuild() alongside `agent`, so
   * `agent !== null` implies a stash; updateQueuedMessage reads it for the
   * synchronous seed-membership check BEFORE persisting (persist-first
   * ordering, fix round 1).
   */
  queueSeed: UserMessage[] | null;
  config: ResolvedConfig | null;
  history: Message[];
  mapper: ReturnType<typeof sse.createEventMapper>;
  connection: Connection | null;
  buffer: sse.SSEMessage[];
  running: boolean;
  /** Workflow-mode fingerprint captured from the outgoing agent at rebuild
   *  time and seeded into the next instance (spec 2026-09-25 §3.1-0). */
  announcedWorkflowMode?: string;
  /**
   * Cancels the turn currently streaming on this session, if any. Set for the
   * lifetime of `runTurn`'s `for await` and cleared when the turn settles, so
   * a late `interrupt()` for a turn that already finished is a no-op rather
   * than poisoning the next one.
   */
  abort: AbortController | null;
  /**
   * Pending human approvals for this session.
   */
  approvals: ApprovalRegistry;
  lastUsed: number;
  /**
   * Map from callId to the parked bash command string. Recorded by the
   * approval gate's `onPending` hook so `decideApproval` can read the
   * command when the user clicks "remember". Entries are deleted by the
   * `onSettled` hook — the command is only available for the lifetime
   * of the pending approval.
   */
  pendingCommands: Map<string, string>;
  /**
   * Set when a permission rule was successfully written (or already covered)
   * during `decideApproval`. Checked at the next `runTurn` rebuild gate so
   * the fresh rule takes effect immediately instead of waiting for the next
   * config change.
   */
  permissionsDirty: boolean;
  /**
   * Whether this process already looked for a title to derive. Set before the
   * first attempt so a session is asked exactly once — the answer cannot
   * change later (a title that exists stays), and re-reading the transcript
   * on every turn would be pure waste.
   */
  titlePrepared?: boolean;
}

/** An event as an agent's stream() yields it.
 *
 * Since task-r6 the Runner double-writes every transcript event it persists,
 * so the non-delta vocabulary on the stream is the transcript's own: each
 * event carries the exact stamp ({time, turn?, step?}) that was recorded, on
 * top of `{type, data}`. A few raw events with no transcript counterpart —
 * observability residuals (error / cancelled), plus tool
 * effect-channel events from displayMetadata.pendingEvents — still ride
 * without a stamp.
 */
interface ChannelEvent {
  type: string;
  data: Record<string, unknown>;
  /** Transcript stamp — present only on events the runner also recorded. */
  time?: number;
  turn?: number;
  step?: number;
}

/** A delta payload field that is optional on the wire reads as "" when absent. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Sub-agent routing tags, present only on events the tagged sink emitted. */
function routingTags(data: Record<string, unknown>): { agentDepth?: number; childSessionId?: string } {
  const tags: { agentDepth?: number; childSessionId?: string } = {};
  if (typeof data["agentDepth"] === "number") tags.agentDepth = data["agentDepth"];
  if (typeof data["childSessionId"] === "string") tags.childSessionId = data["childSessionId"];
  return tags;
}

/**
 * Narrow a channel event to the transcript contract. The runtime
 * discriminator is the `time` stamp: since task-r6 the Runner's recorder
 * stamps — and therefore streams — every event it persists, so only raw
 * residuals / effect-channel events lack one. The narrowed value is a
 * genuine TranscriptEventInput: the same shape that was appended to the
 * chatStore, framed verbatim by mapper.event().
 */
function asTranscriptEvent(event: ChannelEvent): TranscriptEventInput | null {
  if (typeof event.time !== "number") return null;
  return event as TranscriptEventInput;
}

/**
 * Hard cap on the settle-time auto-flush loop in `runTurn`'s finally (spec
 * D2/D3). Each round delivers the whole queue as one `steering_flush` turn's
 * opening input, so reaching this cap means messages kept arriving faster
 * than turns could drain them — stop and report (`server.steer.autoTurnLimit`)
 * rather than hold the session latch forever.
 */
const AUTO_FLUSH_MAX_ROUNDS = 50;

export function createSessionRegistry(opts: SessionRegistryOptions = {}) {
  const {
    maxSessions = 100,
    replayBufferSize = 200,
    heartbeatInterval = 15_000,
    steerAgentWaitMs = STEER_AGENT_WAIT_MS,
    projectStore,
    providerStore,
    agentFactory,
    chatStore,
    attachmentStoreFor,
    // Destructured out so `wiring` never carries a raw `false` that the
    // spread below would leak into createAgent.
    compaction: configuredCompaction,
    // Tier wiring is owned by the registry itself (rebuild() reads the
    // routing-tier config store on every build — the store is the single
    // source of truth). Destructured out so `wiring` can never leak a tier
    // table — especially an empty `[]`, which the SDK would read as tier
    // mode — past the "both keys together or neither" rule in rebuild().
    routingTiers: _wiringRoutingTiers,
    resolveSubagentModelPort: _wiringResolveSubagentModelPort,
    ...wiring
  } = opts;

  const buildAgent = agentFactory ?? createWiredAgent;

  /**
   * The user's configured title model, or null when they have not picked one
   * (spec 2026-10-30 D2) — in which case the heuristic title stands and no
   * model is called at all.
   */
  const titleModelPortFactory =
    opts.titleModelPortFactory ??
    (async (): Promise<{ modelPort: ModelPort; model: string } | null> => {
      if (!providerStore) return null;
      let preferences;
      try {
        preferences = await readPreferences();
      } catch {
        return null;
      }
      const providerId = preferences.titleProviderId;
      const modelId = preferences.titleModelId;
      if (providerId === undefined || modelId === undefined) return null;
      const resolved = await buildSubagentModelPortFactory(providerStore)({
        providerId,
        modelId,
      });
      if (resolved === null) return null;
      return { modelPort: resolved.modelPort, model: resolved.model };
    });

  const sessions = new Map<string, Session>();

  /**
   * Release the child processes an agent instance owns — the persistent bash
   * session and every background process. Dropping the reference is not
   * enough: those processes outlive GC and only die with the server.
   * Best-effort, and never allowed to reject into an eviction/shutdown path.
   */
  function disposeAgent(agent: Session["agent"]): Promise<void> {
    // `agentFactory` lets a caller (tests) supply a stub without dispose.
    if (!agent?.dispose) return Promise.resolve();
    try {
      return Promise.resolve(agent.dispose()).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  function evictIfNeeded(): void {
    if (sessions.size <= maxSessions) return;
    // Evict the least recently used session that has no live connection.
    const candidates = [...sessions.values()]
      .filter((s) => !s.connection && !s.running)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    const victim = candidates[0];
    if (victim) {
      sessions.delete(victim.id);
      void disposeAgent(victim.agent);
    }
  }

  function get(sessionId: string): Session {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        agent: null,
        queueSeed: null,
        config: null,
        history: [],
        mapper: sse.createEventMapper(),
        connection: null,
        buffer: [],
        running: false,
        abort: null,
        approvals: createApprovalRegistry(approvalHooks(sessionId)),
        lastUsed: Date.now(),
        pendingCommands: new Map(),
        permissionsDirty: false,
      };
      sessions.set(sessionId, session);
      evictIfNeeded();
    }
    session.lastUsed = Date.now();
    return session;
  }

  /**
   * Frame one channel event for the wire. The EventSink's streaming
   * increments — text / reasoning / tool-use deltas — ride `delta` frames
   * carrying a `TranscriptDelta`, so a client can render a typewriter effect
   * between authoritative events. Everything else is a transcript event:
   * since task-r6 the Runner streams the very `{time, type, data, turn?,
   * step?}` it persists, so these ride verbatim `event` frames whose payload
   * the client projects exactly like a stored event (spec §6.1 isomorphism).
   * Channel events without a transcript stamp — the reducer's unmapped
   * observability residuals (error / cancelled) and tool
   * effect-channel events — are not part of the transcript vocabulary and
   * are dropped here (the raw `/stream` and `/ws` endpoints still expose
   * them). Turn boundaries need no mapper-side bookkeeping: they are
   * expressed by `turn_end` events, so `done()` and `resetTurn()` no longer
   * exist on the mapper.
   */
  function frame(session: Session, event: ChannelEvent): sse.SSEMessage | null {
    switch (event.type) {
      case "text_delta":
        return session.mapper.delta({ kind: "text", text: asString(event.data["text"]), ...routingTags(event.data) });
      case "reasoning_delta":
        return session.mapper.delta({ kind: "reasoning", text: asString(event.data["text"]), ...routingTags(event.data) });
      case "tool_use_delta":
        return session.mapper.delta({
          kind: "tool_use",
          callId: asString(event.data["toolCallId"]),
          // The "args" phase of a call omits the name; TranscriptDelta keeps
          // it optional so applyPartial folds in what is present.
          ...(typeof event.data["toolName"] === "string" ? { name: event.data["toolName"] as string } : {}),
          argumentsDelta: asString(event.data["argumentsDelta"]),
          ...routingTags(event.data),
        });
      default: {
        const transcript = asTranscriptEvent(event);
        // Unstamped raw events are dropped — see the frame() doc comment.
        if (!transcript) return null;
        return session.mapper.event(transcript);
      }
    }
  }

  function push(session: Session, message: sse.SSEMessage | null): void {
    if (!message) return;
    // Deltas are not replayable: they carry no seq, and a client that missed
    // one is corrected by the next authoritative event. Keeping them out of
    // the buffer also stops a long reply from evicting real events from it.
    if (message.event !== sse.SSEFrameType.DELTA) {
      session.buffer.push(message);
      if (session.buffer.length > replayBufferSize) session.buffer.shift();
    }
    session.connection?.res.write(sse.formatSSEFrame(message));
  }

  /**
   * Deliver one out-of-band event to a session's live /events connection —
   * the escape hatch for events that do NOT ride the turn's stream channel:
   *
   * - the ask_user tool's own prompt event (callId / question / options /
   *   multiSelect), which the SDK emits to the construction-time eventSink,
   *   not the per-turn channel (create-agent.ts wires createAskUserTool with
   *   `opts.eventSink`, resolved once at agent construction);
   * - the synthetic approval_asked / approval_decision brackets below, which
   *   ask_user needs because it parks the gate directly, bypassing the
   *   Runner that emits those transcript events for every other approval.
   *
   * These events are deliberately NOT persisted to the chat store — ask_user's
   * event is not part of core's transcript vocabulary, and making it one (or
   * persisting the synthetic brackets) would mean a core event-type change,
   * which is ruled out. They ride `event:` frames with a real emission
   * timestamp so the shared client (which only routes the five protocol frame
   * names) delivers them like any transcript event, and they are buffered for
   * Last-Event-ID replay exactly like one — so a quick reconnect re-derives a
   * still-pending ask card. Nothing re-materialises them on a cold reload:
   * GET /sessions/:id/events serves only persisted events, and a pending ask
   * whose page was reloaded degrades to no card until the next turn (v1).
   *
   * Returns whether a live connection received it. False for an unknown or
   * connection-less session — a gate promise parked with nobody watching
   * still resolves when `POST /approvals` (or the fail-closed paths) settle
   * it, so a dropped card never wedges the turn.
   */
  function emitToSession(
    sessionId: string,
    event: { type: string; data: Record<string, unknown> },
  ): boolean {
    // Lookup without materialising: an emit for a session this process never
    // created must not conjure one into the eviction pool.
    const session = sessions.get(sessionId);
    if (!session) return false;
    push(
      session,
      session.mapper.event({ ...event, time: Date.now() } as TranscriptEventInput),
    );
    return session.connection != null;
  }

  /**
   * Serializes title writes per session.
   *
   * Read-rank-append is not atomic on its own, and every entry point funnels
   * through `writeSessionTitle`: without this, a model title and a manual
   * rename that overlap both pass the rank check on the same snapshot, and
   * whichever append lands last wins regardless of rank. Queueing makes the
   * later write re-read the earlier one's result, so the rank is decided
   * against the truth.
   */
  const titleWriteQueues = new Map<string, Promise<unknown>>();

  function withTitleLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = titleWriteQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    titleWriteQueues.set(sessionId, tail);
    void tail.then(() => {
      // Drop the entry once it is the tail again, so a long-lived process does
      // not accumulate one promise per titled session.
      if (titleWriteQueues.get(sessionId) === tail) titleWriteQueues.delete(sessionId);
    });
    return next;
  }

  /**
   * Writes a session title when `source` outranks the one already stored, then
   * mirrors the record onto the session's live channel so the header and the
   * sidebar follow without a reload.
   *
   * The ranking is the server-side half of "a manual rename is never
   * overwritten": `user` beats `model` beats `heuristic`, so a late model
   * title cannot bury a name the human typed, and a retried heuristic patch
   * cannot undo either. Same-source writes are allowed (the user renaming
   * twice, a model regenerating), and a session with no title accepts any
   * source. Logs written before titles had provenance are read as
   * `heuristic`, which is what every pre-existing title actually was.
   *
   * Never throws: a title rides the turn's critical path, so every failure —
   * unreadable log, unwritable log, a live-channel write that blows up — is
   * reported as a result and leaves the caller's turn intact.
   *
   * `createIfMissing` is for the derived title of a session whose first turn
   * has not written its header yet: the appended event carries only the title
   * fields, and the store folds metas field-by-field, so the later header
   * cannot erase them and they cannot erase it. The rename route keeps the
   * default and answers 404 for a session that does not exist.
   */
  function writeSessionTitle(
    sessionId: string,
    title: string,
    source: TitleSource,
    createIfMissing = false,
  ): Promise<TitleWriteResult> {
    return withTitleLock(sessionId, async (): Promise<TitleWriteResult> => {
      try {
        let record: ChatSessionRecord | undefined;
        try {
          record = await chatStore?.readSession(sessionId);
        } catch {
          // An unreadable transcript cannot be safely overwritten — the next
          // successful turn re-derives the title instead.
          return "missing";
        }
        if (!record && !createIfMissing) return "missing";

        const current: TitleSource | undefined =
          record?.meta.titleSource ?? (record?.meta.title ? "heuristic" : undefined);
        if (current !== undefined && TITLE_SOURCE_RANK[source] < TITLE_SOURCE_RANK[current]) {
          return "outranked";
        }

        // ONLY the fields this write owns. The store folds each `session_meta`
        // into the last one field by field, so replaying a snapshot would
        // rewrite values that moved after the read — and, with no transcript
        // yet, stamp `projectId: null` onto a session whose header lands a
        // moment later.
        const own = { title, titleSource: source };
        try {
          await chatStore?.appendEvents(null, sessionId, [
            { time: Date.now(), type: "session_meta", data: own } as TranscriptEventInput,
          ]);
        } catch {
          // Best-effort, like every other transcript write on a turn's path.
          return "missing";
        }

        // The live frame carries the merged meta (what a listener would read
        // back from the store) — a throw here is a dead socket, not a reason
        // to fail the write the caller already persisted.
        try {
          emitToSession(sessionId, {
            type: "session_meta",
            data: { ...(record?.meta ?? {}), ...own } as unknown as Record<string, unknown>,
          });
        } catch {
          // No listener reached; the durable write above is the truth.
        }
        return "written";
      } catch {
        return "missing";
      }
    });
  }

  /**
   * Derives and stores a title for a session that has none, from its first
   * user message.
   *
   * The transcript is the preferred source: it holds the real first message
   * whenever this session has run before (a session created before titles
   * existed, or one whose title write failed). On the very first turn that
   * message is not on disk yet — the agent writes it as the turn starts — so
   * the message this turn was called with stands in for it.
   *
   * A session that already carries a title is left untouched: this only ever
   * runs once per process per session, and a title that exists is either
   * newer than the derivation (the user, or a model) or identical to it.
   */
  async function prepareHeuristicTitle(
    session: Session,
    message: string | AgentInput,
  ): Promise<void> {
    if (!chatStore) return;
    let record: ChatSessionRecord | undefined;
    try {
      record = await chatStore.readSession(session.id);
    } catch {
      return;
    }
    if (record?.meta.title) return;

    const text = (record ? firstUserMessageText(record.events) : null) ?? messageText(message);
    if (text === null) return;
    const title = deriveHeuristicTitle(text);
    if (title === null) return;

    if (await writeSessionTitle(session.id, title, "heuristic", true) === "written") {
      // Name the session with the model now, alongside the turn it belongs
      // to: the request does not depend on the answer, and waiting for the
      // turn to settle would leave the header generic for its whole duration.
      void generateModelTitle(session, text);
    }
  }

  /**
   * Replaces a freshly derived title with one written by the configured title
   * model.
   *
   * Started as soon as the first message has a heuristic name, so it runs
   * alongside the turn instead of after it. The write goes through the ranked
   * writer: a rename that lands while the model is thinking outranks this
   * title, and the late answer is dropped. Every failure is the same: the
   * heuristic title stays, and nothing reaches the conversation.
   */
  async function generateModelTitle(session: Session, text: string): Promise<void> {
    try {
      if (!chatStore) return;
      const target = await titleModelPortFactory();
      if (target === null) return;
      const title = await generateTitle(target.modelPort, target.model, text);
      if (title === null) return;

      const record = await chatStore.readSession(session.id);
      if (!record || record.meta.title === title) return;
      await writeSessionTitle(session.id, title, "model");
    } catch {
      // A title is decoration: it never surfaces an error or fails a turn.
    }
  }

  /**
   * The approval lifecycle hooks the per-session registry is built with. Only
   * `ask_user` needs synthesis: it is the one tool that calls the gate
   * directly (bypassing the Runner and therefore the native approval_asked /
   * approval_decision transcript events), and the web card derivation never
   * creates a pending entry from the bare ask_user event — it only enriches
   * an `approval_asked` entry by callId (apps/web/lib/approvals.ts). Normal
   * tool approvals are untouched: the Runner already brackets them, and a
   * synthetic duplicate would just be noise on the wire.
   */
  function approvalHooks(sessionId: string): ApprovalRegistryHooks {
    return {
      onPending: (call, riskTier) => {
        // Record the parked bash command so `decideApproval` can read it
        // back when the user clicks "remember". Only bash tool calls carry
        // a command; other tools record nothing.
        if (call.name === "bash") {
          const session = sessions.get(sessionId);
          const command = (call.input as Record<string, unknown>)["command"];
          if (typeof command === "string") {
            session?.pendingCommands.set(call.id, command);
          }
        }
        if (call.name !== "ask_user") return;
        emitToSession(sessionId, {
          type: "approval_asked",
          data: { callId: call.id, name: call.name, riskTier },
        });
      },
      onSettled: (callId, toolName, decision) => {
        // Clean up the parked command recording — it is only valid for the
        // lifetime of the pending approval. Runs BEFORE `decideApproval`
        // reads it, so the read must happen before `settle()` (see that
        // function's doc comment).
        const session = sessions.get(sessionId);
        session?.pendingCommands.delete(callId);
        if (toolName !== "ask_user") return;
        emitToSession(sessionId, {
          type: "approval_decision",
          data: { callId, decision },
        });
      },
    };
  }

  /**
   * Attach an SSE response to a session. Replays any events newer than
   * `lastEventId`, then keeps the connection alive with heartbeats.
   */
  function attach(
    sessionId: string,
    res: http.ServerResponse,
    lastEventId?: string,
  ): void {
    const session = get(sessionId);

    // A session serves one client at a time; a new connection supersedes the old.
    detach(session);

    // A comment frame right away: proves the stream is live and defeats any
    // intermediary that would otherwise wait for a full buffer before flushing.
    res.write(": connected\n\n");

    // A fresh token for this exact connection — see decideApproval's own
    // comment for the threat this defeats. Generated with real randomness
    // (crypto.randomBytes, not core's deterministic Random port): this is
    // app-layer gateway code, not packages/core, so genuine unpredictability
    // is the correct call here. Sent once, over this channel only, as a
    // named CONNECTED frame (not folded into the anonymous ": connected"
    // comment above — a comment line is invisible to the EventSource API,
    // so it could never actually reach the client's JS).
    const token = crypto.randomBytes(32).toString("hex");
    res.write(sse.formatSSEFrame(session.mapper.connected(token)));

    const heartbeat = setInterval(() => {
      res.write(sse.formatSSEFrame(session.mapper.heartbeat()));
    }, heartbeatInterval);
    session.connection = { res, heartbeat, token };

    const since = lastEventId ? Number.parseInt(lastEventId, 10) : NaN;
    if (!Number.isNaN(since)) {
      for (const message of session.buffer) {
        if (Number.parseInt(message.id, 10) > since) {
          res.write(sse.formatSSEFrame(message));
        }
      }
    }
  }

  function detach(session: Session): void {
    // A dropped channel means nobody can answer — deny rather than leave a
    // tool call parked forever, and never allow by default. Tagged
    // `connection-lost` so the user can tell this from their own deny click.
    session.approvals.settleAll("deny", "connection-lost");
    if (!session.connection) return;
    clearInterval(session.connection.heartbeat);
    session.connection = null;
  }

  function detachById(sessionId: string, res: http.ServerResponse): void {
    const session = sessions.get(sessionId);
    // Only detach if this exact response is still the active one — a superseded
    // connection closing later must not tear down its replacement.
    if (session?.connection?.res === res) detach(session);
  }

  function hasConnection(sessionId: string): boolean {
    return sessions.get(sessionId)?.connection != null;
  }

  /**
   * Whether a session is "known" for lookup-style routes (compact, etc.):
   * either live in this process's map, or persisted in the chat store from
   * a prior turn. Distinct from `hasConnection` — a known session need not
   * have an open SSE channel.
   */
  async function hasSession(sessionId: string): Promise<boolean> {
    if (sessions.has(sessionId)) return true;
    if (!chatStore) return false;
    const record = await chatStore.readSession(sessionId).catch(() => undefined);
    return record != null;
  }

  /**
   * The project path this session's agent was last built with, or null when
   * the session is unknown to this process or has not completed a rebuild
   * yet (`config` is only fixed by runTurn's resolveConfig → rebuild). Read
   * only — unlike get(), this never materialises a session entry. Consumed
   * by the route handlers that must reach a session's plan document (GET /
   * DELETE /sessions/:id/plan), which need the same projectPath the agent's
   * save_plan writes resolved, not a re-derived one.
   */
  function getSessionProjectPath(sessionId: string): string | null {
    return sessions.get(sessionId)?.config?.projectPath ?? null;
  }

  /** Whether this process has a turn in flight for the session. Read-only. */
  function isRunning(sessionId: string): boolean {
    return sessions.get(sessionId)?.running === true;
  }

  /**
   * Turn the ids sent by the client into concrete construction inputs.
   *
   * This is reached exclusively through `runTurn()`, i.e. `POST /messages` —
   * the legacy `/run`, `/stream` and `/ws` routes never build a `TurnConfig`
   * and keep using the gateway's own `cwd`/env model config in `wiring.ts`.
   * `POST /messages` is the project-scoped web app's only entry point, so a
   * turn requested through it must resolve to a real project and a real
   * model; silently falling back here (e.g. a session with a null
   * `projectId` from `session-store`'s pre-project-binding migration) would
   * run the agent against this process's own cwd instead of the directory
   * the user believes they are working in.
   *
   * Also returns the raw credentials (if any) so `rebuild()` doesn't have to
   * call `resolveModel` a second time.
   */
  /**
   * Resolve the concrete wire protocol before the agent is built. Explicit
   * config wins; an untouched catalog model asks the adapter's pure
   * describeModel projection, never the network.
   */
  async function resolveProtocolForCredentials(
    providerId: string,
    credentials: ResolvedCredentials,
  ): Promise<string | undefined> {
    if (credentials.kind === "catalog") {
      if (credentials.modelProtocol !== undefined) return credentials.modelProtocol;
      if (credentials.protocol !== undefined && credentials.protocol !== "auto") {
        return credentials.protocol;
      }
    } else if (credentials.protocol !== undefined) {
      return credentials.protocol;
    }
    try {
      const providerConfig = buildProviderConfig(providerId, credentials);
      const port = createPiAiModelPort({
        providers: [providerConfig],
        defaultProviderId: providerConfig.id,
      });
      return (await port.describeModel!(credentials.code)).api;
    } catch {
      return undefined;
    }
  }

  async function resolveConfig(
    requested: TurnConfig,
  ): Promise<{ config: ResolvedConfig; credentials: ResolvedCredentials | null }> {
    if (!requested.projectId) {
      throw new Error("projectId is required: a turn must run inside a bound project");
    }
    if (!projectStore) {
      throw new Error("Project store is not configured on this session registry");
    }
    const projectPath = await resolveProjectPath(projectStore, requested.projectId);
    if (projectPath === undefined) throw new Error(unknownProjectMessage(requested.projectId));

    // A lone providerId or modelId is a broken reference, not "no
    // selection" — previously this was silently ignored and fell back to
    // the env-configured model just like the projectId case above.
    if (!requested.providerId || !requested.modelId) {
      throw new Error("providerId and modelId are required together: a turn must run against a bound model");
    }
    if (!providerStore) {
      throw new Error("Provider store is not configured on this session registry");
    }
    const resolved = await providerStore.resolveModel(requested.providerId, requested.modelId);
    if (!resolved) {
      throw new Error(`Unknown model: ${requested.providerId}/${requested.modelId}`);
    }
    const credentials: ResolvedCredentials = resolved;

    // Validate BEFORE any provider I/O — this must throw (never silently
    // rewrite) when the resolved model does not declare support for the
    // requested effort. See assertSupportedReasoningEffort's own doc comment.
    if (requested.reasoningEffort !== undefined) {
      await assertSupportedReasoningEffort(requested.providerId, credentials, requested.reasoningEffort);
    }

    const config: ResolvedConfig = {
      projectPath,
      projectId: requested.projectId,
      providerId: requested.providerId,
      modelId: requested.modelId,
      protocol: await resolveProtocolForCredentials(requested.providerId, credentials),
      // Both kinds can carry one now, and it is part of a turn's identity:
      // sameConfig() compares it to decide whether to rebuild the agent.
      baseURL: credentials.baseURL,
      code: credentials.code,
      // Both kinds carry an optional per-model cap now that catalog models
      // are configurable records rather than bare codes.
      maxOutputTokens: credentials.maxOutputTokens,
      contextWindow: credentials.contextWindow,
      keyFingerprint: credentials.apiKey ? fingerprintApiKey(credentials.apiKey) : undefined,
      // I3: an omitted permissionMode must resolve to the narrowest tier
      // that can still do work ("ask"), never to "no mode at all" — the
      // latter makes rebuild() skip the whole permissionConfig/sandboxMode/
      // approvalGate branch below and createAgent() falls back to
      // workspace-write + auto-allow, the widest possible agent. Defaulting
      // here (rather than requiring the field on the HTTP route) closes the
      // hole for every caller, including legacy paths that never send it.
      permissionMode: requested.permissionMode ?? "ask",
      reasoningEffort: requested.reasoningEffort,
    };

    return { config, credentials };
  }

  function sameConfig(a: ResolvedConfig | null, b: ResolvedConfig): boolean {
    return (
      a !== null &&
      a.projectPath === b.projectPath &&
      a.projectId === b.projectId &&
      a.providerId === b.providerId &&
      a.modelId === b.modelId &&
      a.protocol === b.protocol &&
      a.baseURL === b.baseURL &&
      a.code === b.code &&
      a.maxOutputTokens === b.maxOutputTokens &&
      a.contextWindow === b.contextWindow &&
      a.keyFingerprint === b.keyFingerprint &&
      a.permissionMode === b.permissionMode &&
      a.reasoningEffort === b.reasoningEffort
    );
  }

  /**
   * Reads a session's persisted transcript fresh and returns the highest
   * `turn_start` seen, or `undefined` when there is no chatStore, no
   * persisted session, or no `turn_start` events at all.
   *
   * Deliberately NOT cached on `Session` — a rebuild can happen mid-
   * conversation (any config change, not just a process restart), and by
   * then turns may already have completed since the last time this was
   * computed. A value cached at cold-start hydration and never refreshed
   * goes stale the moment a turn completes, so every subsequent rebuild
   * would forward a number lower than what is actually on disk and collide
   * with a turn that already exists in the transcript. Re-reading here
   * instead of trusting in-memory bookkeeping keeps it always derived from
   * the transcript itself. Rebuilds only happen on a config change (not
   * every turn), so the extra read stays off the hot path.
   */
  async function resolveInitialTurn(sessionId: string): Promise<number | undefined> {
    if (!chatStore) return undefined;
    const persisted = await chatStore.readSession(sessionId).catch(() => undefined);
    if (!persisted) return undefined;
    return highestTurnStart(persisted.events);
  }

  /**
   * Reads a session's persisted transcript fresh and returns the highest
   * `step` stamped on `turn`'s events, or `undefined` when there is no
   * chatStore, no persisted session, or the turn carries no step-stamped
   * events (a turn paused before its first model call completed, most
   * commonly a pause on the very first approval).
   *
   * Companion to resolveInitialTurn(): the paused turn a cross-process
   * resume continues is the LAST turn — exactly the one resolveInitialTurn()
   * returns — so the caller passes that ordinal here. Feeds
   * CreateAgentOptions.initialStep so the resume Runner's first model call
   * is recorded after the paused turn's existing steps rather than
   * colliding with them. Same freshness discipline as resolveInitialTurn:
   * re-read from the transcript on every rebuild, never cached.
   */
  async function resolveInitialStep(sessionId: string, turn: number): Promise<number | undefined> {
    if (!chatStore) return undefined;
    const persisted = await chatStore.readSession(sessionId).catch(() => undefined);
    if (!persisted) return undefined;
    return highestStepInTurn(persisted.events, turn);
  }

  /**
   * History to seed a rebuilt agent with, minus any permission reminder the
   * previous agent injected.
   *
   * A rebuild is how a tier switch takes effect, and the captured history
   * still describes the OLD boundary. The fresh agent starts with no
   * `_announcedPermission`, so it announces the new boundary as a first
   * announcement — leaving the model with two contradictory descriptions and
   * nothing marking the older one as superseded, one more per switch. A
   * superseded boundary description is worse than none, and dropping the
   * stale ones also makes that first-announcement framing correct again.
   */
  function seedHistory(history: Message[]): Message[] {
    return history.filter((msg) => !isPermissionReminder(msg));
  }

  /** Construct an agent for the resolved config, seeding prior history. */
  async function rebuild(
    session: Session,
    config: ResolvedConfig,
    credentials: ResolvedCredentials | null,
    /**
     * The D13 queue fold a cold start's own hydration read produced (same
     * persisted-event source as its history seed). Passed in so that read
     * serves double duty; every other rebuild folds from its own read below.
     */
    coldStartQueue?: UserMessage[],
  ): Promise<void> {
    const initialTurn = await resolveInitialTurn(session.id);
    // Same freshness discipline as resolveInitialTurn: recover the once-
    // resolved workspace layers from the transcript so a rebuild never
    // re-reads instruction files mid-conversation. One read serves this AND
    // the D13 queue fold below — the log is append-only, so a single fresh
    // snapshot is all either seed needs (no second store read).
    const persistedEvents = await (async (): Promise<TranscriptEvent[] | undefined> => {
      if (!chatStore) return undefined;
      const persisted = await chatStore.readSession(session.id).catch(() => undefined);
      return persisted?.events;
    })();
    const initialContextLayers =
      persistedEvents !== undefined ? contextLayersFromHeader(persistedEvents) : undefined;
    // The paused turn a cross-process resume continues is the last turn —
    // exactly the one initialTurn names — so its step seed is looked up
    // against that ordinal. Only consumed by the SDK's cross-process resume
    // fallback Runner; ordinary new turns ignore it entirely.
    const initialStep = initialTurn !== undefined ? await resolveInitialStep(session.id, initialTurn) : undefined;
    // D13: the undelivered steering queue, folded from the transcript read
    // above (a cold start hands in the fold its hydration read produced —
    // same source, same result). Held BY REFERENCE as the new instance's
    // seed: createAgent keeps `initialQueuedInputs` as the live queue until
    // its first Runner materializes, which is also what lets the
    // post-construction reconcile below push into it.
    const queueSeed = coldStartQueue ?? pendingSteeredMessages(persistedEvents ?? []);
    // Real path of the credential dir, denied to the sandbox on both the
    // shell and fs sides. Resolved here (async context) rather than inside
    // buildSandboxConfigs, which stays synchronous.
    const configDirRealPath = await getConfigDirRealPath();
    const seeded = seedHistory(session.history);
    // Plan 2: default-on. Absent config uses DEFAULT_COMPACTION; false disables.
    const compaction = resolveHostCompaction(configuredCompaction);
    // Model routing tier table (spec 2026-10-29 D3-D6), read fresh on every
    // rebuild — same reload discipline as egress/permissions/hooks in
    // wiring.ts: an edit to routing-tiers.json reaches the next build without
    // a restart. A missing file reads as the factory template (spec v2
    // D7/D8: tier mode on, every tier unassigned); `[]` reads as "no tiers
    // configured".
    const tierRecords = await createRoutingTierStore().list();
    // A rebuild replaces the instance, so the outgoing one's persistent bash
    // session and background processes have to be reclaimed here — nothing
    // else holds a reference to them afterwards.
    const outgoing = session.agent;
    // Carry the workflow-mode fingerprint across the rebuild (spec §3.1-0):
    // the mode switch that triggered this rebuild is exactly the transition
    // whose exit note dies if the flag resets to undefined. Best-effort — a
    // never-run agent has no state to read, leaving the seed absent (cold
    // re-announce, state-descriptive: safe).
    if (outgoing) {
      try {
        session.announcedWorkflowMode = outgoing.getState()._announcedWorkflowMode;
      } catch {
        // Never-run agent — keep whatever we had (usually undefined).
      }
    }
    session.agent = await buildAgent({
      ...wiring,
      // Explicit override of the spread so the default-on decision is visible here.
      ...(compaction !== undefined ? { compaction } : {}),
      // Model routing tiers (spec 2026-10-29 D3-D6): the tier table plus the
      // per-dispatch ModelPort factory that materializes a tier's target. The
      // two keys travel together or not at all — the SDK switches to tier
      // mode on `routingTiers !== undefined`, so an EMPTY table must arrive
      // as NO key, never `[]`, or every legacy raw model code would be
      // hijacked into tier resolution (and per-dispatch raw codes would
      // throw). An absent file is not empty: it arrives as the factory
      // template (spec v2 D7/D8), so tier ids are real from the first run.
      ...(tierRecords.length > 0
        ? {
            routingTiers: tierRecords,
            // No provider store on a legacy registry (the /run path): no
            // target can ever resolve, so a null factory degrades every tier
            // dispatch to the parent model with the visible unresolved event
            // — still better than passing tier ids through as raw codes.
            resolveSubagentModelPort: providerStore
              ? buildSubagentModelPortFactory(providerStore)
              : async () => null,
          }
        : {}),
      // Same store the /attachments routes wrote to, scoped to this session:
      // the Runner resolves image refs against it when it assembles the
      // ModelRequest.
      ...(attachmentStoreFor ? { attachmentStore: attachmentStoreFor(session.id) } : {}),
      ...(config.projectPath ? { cwd: config.projectPath } : {}),
      configDirRealPath,
      ...(credentials
        ? {
            model: credentials.code,
            // Route provenance for the turn-usage card (spec 2026-09-26): the
            // session's own provider config id, not a default — the same value
            // `buildProviderConfig` below routes the port with.
            ...(config.providerId !== undefined ? { providerId: config.providerId } : {}),
            // `wiring.modelPort`, if the caller supplied one (e.g. tests via
            // `agentFactory`), still wins: `createWiredAgent` only falls back
            // to building a port from `providerConfig` when no explicit
            // `modelPort` is given (see wiring.ts). This targets the exact
            // provider this turn resolved to — not a default — since both
            // branches read `config.providerId`/`credentials` verbatim.
            providerConfig: buildProviderConfig(config.providerId, credentials),
          }
        : {}),
      ...(config.maxOutputTokens !== undefined ? { maxTokens: config.maxOutputTokens } : {}),
      ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
      ...(config.permissionMode
        ? {
            permissionConfig: buildPermissionConfig(config.permissionMode),
            sandboxMode: sandboxModeFor(config.permissionMode),
            permissionMode: config.permissionMode,
            approvalGate: session.approvals.gate,
            // ask_user reuses the same gate (the desktop host's precedent):
            // the tool parks it directly, POST /approvals settles it, and the
            // registry's hooks above bracket the card on the SSE channel.
            // SDK default is auto-allow, which would answer every question
            // with "yes" and no human involved — must be overridden.
            askUserGate: session.approvals.gate,
          }
        : {}),
      // ask_user's prompt event rides the construction-time sink, not the
      // turn's stream channel — forward it (and any other out-of-band agent
      // event) to this session's live connection. Deliberately an explicit
      // override of the `...wiring` spread above: the sink must target THIS
      // session's channel, and it resolves the connection at emit time, so a
      // reconnect mid-turn delivers to the new connection and a dropped one
      // simply drops events (the parked gate still settles — see
      // emitToSession). No sink objects are registered here, so there is
      // nothing to clean up on detach.
      eventSink: {
        emit: (event) => {
          emitToSession(session.id, event);
        },
      },
      ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(seeded.length > 0 ? { initialMessages: seeded } : {}),
      // D13: always passed, even when empty — createAgent holds this array
      // by reference as its seed (Task 7), so the post-construction
      // reconcile below can push late-landing entries into it.
      initialQueuedInputs: queueSeed,
      ...(initialTurn !== undefined ? { initialTurn } : {}),
      ...(initialContextLayers !== undefined ? { initialContextLayers } : {}),
      ...(session.announcedWorkflowMode !== undefined
        ? { initialAnnouncedWorkflowMode: session.announcedWorkflowMode }
        : {}),
      ...(initialStep !== undefined ? { initialStep } : {}),
      ...(chatStore
        ? {
            chatStore: scopeToWorkspace(chatStore, config.projectPath ?? null),
            chatSessionId: session.id,
            chatMeta: {
              projectId: config.projectId ?? null,
              providerId: config.providerId ?? null,
              modelId: config.modelId ?? null,
              ...(config.protocol !== undefined ? { protocol: config.protocol } : {}),
              permissionMode: config.permissionMode ?? null,
              ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
            },
          }
        : {}),
    });
    // Stash the seed array beside the instance that holds it (fix round 1):
    // same reference as createAgent's seedQueuedInputs, set in the same
    // synchronous block as the agent assignment so a queue edit can check
    // seed membership without reaching into the SDK.
    session.queueSeed = queueSeed;
    // D13 rebuild-window race: a steer that landed on the OUTGOING instance
    // while buildAgent was awaiting records its steering_queued through that
    // instance's recorder, whose flush is fire-and-forget — the fold above
    // may have read the transcript before that write landed. Re-read now
    // that the new instance exists and push anything missed into the SAME
    // array the new instance holds by reference (Task 7's in-place seed
    // contract), before this turn claims the queue. Residual: a steer whose
    // flush lands after this re-read is still missed — closing that would
    // need the outgoing runner's outstanding flush to be awaitable across
    // instances, which no API exposes.
    if (chatStore) {
      const fresh = await chatStore.readSession(session.id).catch(() => undefined);
      if (fresh) {
        for (const message of pendingSteeredMessages(fresh.events)) {
          if (!queueSeed.some((queued) => queued.id === message.id)) queueSeed.push(message);
        }
      }
    }
    session.config = config;
    session.permissionsDirty = false;
    await disposeAgent(outgoing);
  }

  /**
   * Build (or reuse) a session-scoped agent without a `TurnConfig` — used by
   * the legacy `/run` route so a session id still gets its own isolated
   * agent instance instead of falling back to the process-wide shared agent
   * and leaking one session's history into another's.
   */
  async function ensureAgent(sessionId: string): Promise<NonNullable<Session["agent"]>> {
    const session = get(sessionId);
    if (!session.agent) {
      await rebuild(session, EMPTY_CONFIG, null);
    }
    return session.agent!;
  }

  /**
   * Bounded wait for the cold-window agent (D10): a first turn owns the
   * latch but its rebuild has not produced an instance yet. Waits, polling,
   * until the agent materializes, the latch releases, or `steerAgentWaitMs`
   * expires — then returns whatever `session.agent` is at that moment.
   *
   * Every steering site shares this one loop (runTurn's pre-claim check,
   * POST /messages and updateQueuedMessage) so the bound and the exit
   * conditions cannot drift between them. The return value is a plain
   * reference: after it comes back there must be NO await before the caller
   * steers into it (spec D10's single-threaded atomicity rule — a rebuild in
   * flight must not slip a stale instance in between).
   */
  async function awaitAgent(session: Session): Promise<Session["agent"]> {
    const deadline = Date.now() + steerAgentWaitMs;
    while (session.running && !session.agent && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return session.agent;
  }

  /**
   * Edit or withdraw a queued (not yet delivered) message by id (D14/D15).
   *
   * Delegates membership and mutation to `AgentInstance.updateQueue` (the
   * synchronous check+deliver span) and owns the outcome-to-persistence split
   * of the task-7 contract (task-7 report §十, authoritative):
   * - `"live"` — delivered through the Runner; its recorder persists
   *   `steering_edited` / `steering_removed` exactly once. The gateway must
   *   persist NOTHING here (double-writing would fork the event log).
   * - `"seed"` — first-construction seed hit: no Runner exists, so no
   *   recorder will ever fire — the gateway appends the event to the
   *   chatStore itself. Persist-FIRST (fix round 1): the append lands
   *   BEFORE updateQueue touches the seed array, so a refused write leaves
   *   memory exactly as it was and retrying after storage recovers is
   *   completely safe — memory and the durable log never diverge.
   * - `"missing"` — unknown or already delivered (delivery wins); state
   *   untouched, nothing persisted — the route answers 409.
   * - `"persist-failed"` — the seed append was refused by storage; the seed
   *   array was NOT mutated (persist-first order), so the route answers an
   *   honest 500 (`server.queue.persistFailed`) and the client may simply
   *   retry — never a validation-shaped 400 with a raw store message.
   *
   * A session with no agent instance is rebuilt first (Task 10's event fold
   * hands the new instance the pending queue), which is what makes the
   * `"seed"` path reachable for a cold start.
   */
  async function updateQueuedMessage(
    sessionId: string,
    id: string,
    action: QueuedMessageAction,
  ): Promise<"live" | "seed" | "missing" | "persist-failed"> {
    const session = get(sessionId);
    // D10 cold window: a first turn owns the latch but its agent has not
    // materialized yet — wait bounded for THAT turn's rebuild instead of
    // racing a second rebuild into the same Session (the exact rule POST
    // /messages applies before steer()). Idle-without-an-agent falls
    // straight through to the rebuild below.
    await awaitAgent(session);
    // Rebuild-first for a genuinely cold session (no instance ever built):
    // rebuild()'s event fold seeds the queue, which is what makes the
    // "seed" outcome reachable below. rebuild() stashes that same array on
    // the Session (agent and queueSeed are assigned in one synchronous
    // block), so `agent exists` implies the stash matches the instance's
    // own seedQueuedInputs — the membership check below is exact.
    const agent = session.agent ?? (await ensureAgent(sessionId));
    const input: SteeringEditInput | SteeringRemoveInput =
      action.kind === "edit"
        ? { type: "steering_edit", id, content: action.content }
        : { type: "steering_remove", id };

    // Persist-first on the seed path (fix round 1). The prediction is
    // synchronous and exact, not a guess:
    //   - isSeedPhase(agent) ⟺ getState() throws ⟺ lastRunner and
    //     lastFinalState are both null ⟺ updateQueue's seed-branch
    //     precondition (steerTarget is always paired with lastRunner, so a
    //     throwing instance cannot reach the runner branch either), and
    //   - session.queueSeed IS the instance's seedQueuedInputs (same
    //     reference, passed as initialQueuedInputs), so this find IS the
    //     instance's own membership check.
    // Prediction false ⟹ updateQueue cannot answer "seed" (its branch needs
    // the same two conditions), so live/missing paths are untouched: their
    // persistence stays with the Runner's recorder or nothing at all.
    const seedOriginal = isSeedPhase(agent)
      ? session.queueSeed?.find((queued) => queued.id === id)
      : undefined;
    if (seedOriginal !== undefined && chatStore) {
      const event: TranscriptEventInput =
        action.kind === "edit"
          ? {
              time: Date.now(),
              type: "steering_edited",
              // Persist the MERGED content: mergeQueuedEdit (spec D16) is
              // the same merge updateQueue applies before delivery —
              // persisting the raw edit string would let a later fold
              // replace the entry with text-only content and silently drop
              // its attachments.
              data: {
                id,
                content: mergeQueuedEdit(
                  { type: "steering_edit", id, content: action.content },
                  seedOriginal.content,
                ).content,
              },
            }
          : { time: Date.now(), type: "steering_removed", data: { id } };
      try {
        // Append BEFORE the mutation: only a durable event licenses touching
        // the seed array (same write shape/workspace resolution as runTurn's
        // pre-stream error record below).
        await chatStore.appendEvents(session.config?.projectPath ?? null, sessionId, [event]);
      } catch {
        // updateQueue has not run — the seed array is untouched, so memory
        // and log agree. Report the storage failure as its own outcome; the
        // route renders 500 + i18n instead of this catch-all's 400.
        return "persist-failed";
      }
    }
    // Store-less server degrades as before (no durable record, session works).
    // A concurrent same-session mutation during the append above can flip the
    // answer to "live"/"missing"; the already-written event is fold-idempotent
    // (repeated edits replace with the same content, repeated removes are
    // no-ops), so the fold never diverges — updateQueue's outcome stays
    // authoritative for the response.
    return agent.updateQueue(input);
  }

  /**
   * Run one turn for a session, streaming every event onto its SSE channel.
   *
   * `message` is a plain string for a text-only turn, or a `user_message`
   * AgentInput when the caller (POST /messages) resolved attachment ids into
   * image blocks — `createAgent().stream()` accepts either.
   *
   * Errors are delivered as protocol `error` events rather than thrown, so a
   * failed turn never kills the connection or the process. The session's
   * agent is only rebuilt when its resolved config (project path, model,
   * permission tier) differs from the one it was last built with — a
   * rebuild re-seeds conversation history since a fresh `createAgent`
   * instance starts with none.
   */
  async function runTurn(
    sessionId: string,
    message: string | AgentInput,
    requested: TurnConfig = {},
  ): Promise<void> {
    const session = get(sessionId);

    // D10 latch re-check — the final latch check and the claim below form
    // one synchronous span (no await in between), so two callers can never
    // both start a turn. POST /messages routes mid-turn messages to steering
    // itself and only calls runTurn while the latch is free; this pre-claim
    // re-check is what keeps that claim race-proof for direct callers too
    // (spec D10's pre-latch re-check). A message delivered here is queued by
    // the agent, never rejected and never dropped — but when the latch is
    // held and no agent has materialized yet (the cold window), a bounded
    // wait decides between two outcomes: steer into the owning turn only if
    // the latch is STILL HELD once an agent appears (delivered now), or
    // report `server.error.agentStarting` when the wait expires with the
    // latch still held (the message is refused in the open, not swallowed).
    // If the latch was released while we waited, the message falls through
    // and claims it as a normal new turn (D10/D11's normal path) — it is
    // deliberately NOT steered into the surviving agent, matching what
    // POST /messages does for the same state.
    if (session.running) {
      const target = await awaitAgent(session);
      if (target && session.running) {
        // Atomicity: the latch read and steer() share one synchronous span —
        // no await in between, so no rebuild can slip a stale instance in.
        target.steer(message);
        return;
      }
      if (session.running) {
        // Still latched but the agent never appeared: report the refusal on
        // the session's channel instead of silently dropping the message.
        push(
          session,
          session.mapper.error(t(await activeLocale(getConfigDir()), "server.error.agentStarting")),
        );
        return;
      }
      // The latch was released while we waited: fall through and claim it as
      // a normal new turn (D10/D11's normal path), even if the old agent
      // survived — the route does the same, and a fresh turn delivers
      // immediately instead of parking the message in a settled queue.
    }
    session.running = true;

    // Captures whatever history this turn produced (success or failure)
    // before the turn closes. Durable persistence of messages/errors is now
    // handled inside createAgent() itself (via chatStore/chatSessionId), so
    // this only keeps the in-memory carry-forward history up to date.
    async function captureHistory(): Promise<void> {
      if (session.agent) {
        try {
          const captured = session.agent.getState().messages;
          if (captured.length >= session.history.length) {
            session.history = captured;
          }
        } catch {
          // A never-run agent has no state yet; keep the previous history.
        }
      }
    }

    // Durable recording of a turn's outcome is createAgent()'s own
    // responsibility once stream() is entered (via chatStore/chatSessionId).
    // But resolveConfig()/rebuild() can throw BEFORE stream() is ever
    // reached — on a cold session with no agent yet, or on a later turn
    // whose requested config is invalid even though an agent from an
    // earlier turn is still alive — and createAgent() never sees a failure
    // that happens before its own runner exists. `turnReachedStream` marks
    // the boundary so this catch block records exactly that gap, without
    // ever double-recording a failure createAgent() already saw.
    let turnReachedStream = false;

    /**
     * Stream one turn onto the session's SSE channel, then capture its
     * history. Shared verbatim by the user's own turn and by every
     * settle-time auto-flush round below, so both get identical framing
     * (turn_start/turn_end) and history capture — a flush round is a normal
     * turn whose opening input is `{ type: "steering_flush" }` (Task 5).
     */
    async function streamTurn(input: string | AgentInput): Promise<void> {
      const abort = new AbortController();
      session.abort = abort;
      for await (const event of session.agent!.stream(input, { signal: abort.signal })) {
        push(session, frame(session, event));
      }
      await captureHistory();
    }

    try {
      // Cold start (server restart, or first turn after this Session object
      // was just created by get()): the in-memory history is empty, but a
      // durable transcript from a prior process may still exist. Without
      // this, a restart silently truncates multi-turn context back to zero
      // even though it was recorded on disk. Idempotent and harmless to run
      // while another turn is in flight. It awaits, so it runs AFTER the
      // latch claim above — the claim itself must stay synchronous.
      let coldStartQueue: UserMessage[] | undefined;
      if (chatStore && session.history.length === 0) {
        const persisted = await chatStore.readSession(sessionId).catch(() => undefined);
        if (persisted) {
          session.history = projectMessages(persisted.events);
          // D13: the SAME read feeds the queue fold — an undelivered
          // steering message from a prior process rides into this turn's
          // rebuilt instance instead of waiting for a second store read.
          coldStartQueue = pendingSteeredMessages(persisted.events);
        }
      }

      // Title first, model second: this runs before the turn's first token so
      // the client never shows an untitled conversation, and the model request
      // it starts runs alongside the turn rather than waiting for it. The
      // heuristic it writes is what the model title improves on. Best-effort —
      // every failure inside is swallowed, and a title never fails a turn.
      if (!session.titlePrepared) {
        session.titlePrepared = true;
        await prepareHeuristicTitle(session, message);
      }

      const { config, credentials } = await resolveConfig(requested);
      if (!session.agent || !sameConfig(session.config, config) || session.permissionsDirty) {
        await rebuild(session, config, credentials, coldStartQueue);
      }

      turnReachedStream = true;
      await streamTurn(message);
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      push(session, session.mapper.error(text));
      // resolveConfig()/rebuild() throw before stream() is ever entered, so
      // createAgent()'s own internal recordTurnEndError (which only fires
      // once a runner exists) never sees them. This is the only place left
      // that can record that failure mode — as a bare `error` event, not a
      // `turn_end` (no turn number exists here, and the last one would be
      // wrong: it belongs to whatever turn already completed successfully).
      // Uses the raw, unscoped chatStore with the last-known projectPath —
      // rebuild() never ran for this turn, so no freshly scoped store
      // exists — but the jsonl store resolves an existing session to its
      // real file regardless of workspacePath, so an established session
      // still appends to the same file it already had.
      if (!turnReachedStream) {
        // Awaited inside its own try/catch rather than chained via `.catch()`
        // on the call's return value: a store whose `appendEvents` throws
        // synchronously (a plain, non-async implementation) never produces a
        // promise for `.catch()` to attach to — the throw would instead
        // escape this catch block and reject runTurn(), turning a best-effort
        // transcript write into a failed turn. Same class of bug fixed in
        // the recorder itself by commit 21bd938.
        try {
          await chatStore?.appendEvents(session.config?.projectPath ?? null, sessionId, [
            { time: Date.now(), type: "error", data: { message: text } },
          ]);
        } catch {
          // Best-effort — see the module comment: a transcript write must
          // never disturb the turn it is recording.
        }
      }
      // Capture whatever partial progress this failed turn made before
      // terminating it, so the client leaves its streaming state only once
      // the transcript is caught up.
      await captureHistory();
    } finally {
      // D2/D3 — settle-time auto-flush: a turn that settles with messages
      // still queued must deliver them before the latch releases, as a
      // follow-up `steering_flush` turn, rather than leaving them for the
      // user's next message. The loop runs while `session.running` is still
      // true, so a POST /messages landing here is steered into the queue and
      // picked up by the next condition check; the last condition evaluation
      // and the release below form one synchronous span — no await in
      // between — so a steer arriving after the release routes as a normal
      // new turn instead (the same atomicity rule as the pre-latch re-check
      // at the top of this function).
      const currentQueue = (): UserMessage[] => {
        try {
          // A state that omits the queue field (a host test stub) reads as
          // empty, and a rebuilt-but-never-run agent has no state at all
          // (getState throws) — same "keep what we had" stance as
          // captureHistory above: nothing provably queued, nothing to flush.
          return session.agent?.getState().queuedUserInputs ?? [];
        } catch {
          return [];
        }
      };
      const queuedCount = (): number => currentQueue().length;
      if (queuedCount() > 0) {
        try {
          // Resolved BEFORE the loop: the cap report below must render
          // without an await between the loop's exit and the latch release.
          const locale = await activeLocale(getConfigDir());
          let rounds = 0;
          while (queuedCount() > 0 && rounds < AUTO_FLUSH_MAX_ROUNDS) {
            rounds += 1;
            // Same config/permission rebuild gate as the main path above, on
            // every round: a permission remembered during the previous turn
            // must reach a flush-delivered turn too (permissionsDirty), and a
            // config change must swap the agent before the round streams.
            const { config, credentials } = await resolveConfig(requested);
            if (!session.agent || !sameConfig(session.config, config) || session.permissionsDirty) {
              // Seed the replacement with the CURRENT live queue rather than
              // the transcript fold alone — delivery must not depend on the
              // recorder's fire-and-forget flush landing first.
              const pending = currentQueue();
              await rebuild(
                session,
                config,
                credentials,
                pending.length > 0 ? pending : undefined,
              );
            }
            await streamTurn({ type: "steering_flush" });
          }
          if (rounds >= AUTO_FLUSH_MAX_ROUNDS && queuedCount() > 0) {
            push(session, session.mapper.error(t(locale, "server.steer.autoTurnLimit")));
          }
        } catch (err: unknown) {
          // A drain that fails must never reject runTurn — the latch still
          // releases below, and the client learns of it as a protocol error
          // event, exactly like the main turn's own failure above.
          push(session, session.mapper.error(err instanceof Error ? err.message : String(err)));
        }
      }
      session.running = false;
      session.abort = null;
    }
  }

  /**
   * Cancel the turn currently streaming on a session. Returns false when
   * there is nothing to cancel (no live turn), which the route surfaces as a
   * 409 rather than pretending to have stopped something.
   *
   * The abort travels into the SDK's `stream()` and from there into the
   * Runner, so the turn unwinds exactly as an early `break` would: the model
   * call is aborted, no further tools run, and the turn closes with a
   * `turn_end` carrying `reason: "cancelled"` — the same terminal frame the
   * client already uses to leave its streaming state.
   */
  function interrupt(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session?.running || !session.abort) return false;
    // Tagged `interrupted` — distinct from a user denying a single call.
    session.approvals.settleAll("deny", "interrupted");
    session.abort.abort();
    return true;
  }

  /**
   * Settle one pending approval, bound to the SSE connection it was shown
   * on.
   *
   * `POST /approvals` is a stateless HTTP route: any local process that can
   * reach the gateway's port could otherwise settle a pending approval just
   * by guessing its `callId` — including a sandboxed `bash` the model
   * itself controls, which knows its own callId (see the R2 sandbox rule
   * that used to (mis)guard this, now reverted — packages/runtimes/node's
   * sandbox.ts). Binding the decision to the per-connection token minted in
   * `attach()` closes that: only whoever is subscribed to this session's
   * `/events` channel ever learns the token.
   *
   * A session can only ever have a pending approval while it also has a
   * live connection — `POST /messages` refuses to start a turn without one
   * (see server.ts's `hasConnection` check) — so the token is checked only
   * when a connection exists; a session with no connection at all (never
   * attached, or already detached) falls straight through to the ordinary
   * unknown-callId case, which needs no token to answer safely since it can
   * have no pending approval to leak.
   *
   * The token check runs BEFORE looking at whether `callId` is known, and
   * by itself does not distinguish "wrong token, `callId` happens to be
   * pending" from "wrong token, `callId` is unknown" — both answer
   * `"forbidden"` — so an unauthenticated caller learns nothing about
   * whether a given `callId` is actually pending.
   */
  /**
   * Settle one pending approval and, when the user included `rememberCount`,
   * attempt to save a permission rule.  Semantic errors (untokenizable
   * command, out-of-range prefix, non-matchable token) are reported as
   * `rememberError` — the approval itself succeeded; only the sidecar failed.
   *
   * Order matters: the parked command is read BEFORE `settle()` because
   * `settle()` triggers `onSettled`, which deletes the recording.  The save
   * happens AFTER settle — a save failure rides on top of a settled allow,
   * never instead of one.  A failed save does NOT set `permissionsDirty`
   * (no pointless rebuild).
   */
  async function decideApproval(
    sessionId: string,
    callId: string,
    decision: ApprovalDecision,
    token: string | undefined,
    answer?: string[],
    rememberCount?: number,
  ): Promise<ApprovalDecisionOutcome> {
    const session = sessions.get(sessionId);
    const connection = session?.connection;
    if (connection && (!token || !tokensMatch(token, connection.token))) {
      return { status: "forbidden" };
    }

    // Read the command BEFORE settling: settle() runs onSettled, which drops
    // the recording.
    const command = rememberCount !== undefined ? session?.pendingCommands.get(callId) : undefined;

    // Settle first: the user's "allow" must not depend on the bookkeeping that
    // follows. A save failure rides on top of a settled approval, never
    // instead of one (spec D6).
    if (!session?.approvals.settle(callId, decision, answer)) {
      return { status: "unknown" };
    }

    // --- "remember" sidecar ---
    if (decision !== "allow" || rememberCount === undefined) {
      return { status: "ok" };
    }

    const outcome = await rememberRule(session, command, rememberCount);
    return "error" in outcome
      ? { status: "ok", rememberError: outcome.error }
      : { status: "ok", remembered: outcome.remembered };
  }

  /** Returns the receipt, or the reason the rule could not be written. */
  async function rememberRule(
    session: Session,
    command: string | undefined,
    prefixTokens: number,
  ): Promise<{ remembered: RememberedRule } | { error: string }> {
    if (command === undefined) {
      return { error: "this approval has no command to remember" };
    }
    const tokens = tokenizeCommand(command);
    if (tokens === null) {
      return { error: "this command cannot be expressed as a prefix rule" };
    }
    if (!Number.isInteger(prefixTokens) || prefixTokens < 1 || prefixTokens > tokens.length) {
      return { error: `prefixTokens must be between 1 and ${tokens.length}` };
    }
    const prefix = tokens.slice(0, prefixTokens);
    if (!prefix.every(isMatchableCommandToken)) {
      return { error: "this prefix contains a token that cannot be matched" };
    }
    try {
      const result = await savePermissionRule(getConfigDir(), {
        toolName: "bash",
        commandPrefix: prefix,
        decision: "allow",
      });
      // Only a written (or already-covered) rule earns the dirty flag: a
      // failed save must not rebuild the session for nothing.
      if (result.status === "saved" || result.status === "covered") {
        session.permissionsDirty = true;
      }
      return {
        remembered: {
          rule: result.status === "covered" ? result.by : result.rule,
          outcome: result.status,
          effectiveFrom: "next_turn",
        },
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Close every connection and drop all sessions (used on shutdown).
   * Awaits agent disposal so the persistent bash sessions and background
   * processes are reaped instead of being orphaned by the exiting server.
   */
  async function closeAll(): Promise<void> {
    const agents = [...sessions.values()].map((s) => s.agent);
    for (const session of sessions.values()) {
      detach(session);
    }
    sessions.clear();
    await Promise.all(agents.map(disposeAgent));
  }

  return {
    get,
    attach,
    detachById,
    hasConnection,
    hasSession,
    getSessionProjectPath,
    isRunning,
    runTurn,
    interrupt,
    decideApproval,
    ensureAgent,
    /**
     * The shared bounded cold-window wait (D10). Exposed so POST /messages
     * can wait for the same delivery target `runTurn`'s pre-claim and
     * `updateQueuedMessage` wait for, instead of keeping a second copy of
     * the loop. See the implementation note on atomicity: no await between
     * its return and the caller's steer().
     */
    awaitAgent,
    /**
     * Edit or withdraw a queued (not yet delivered) message by id — the
     * `POST /messages/queue` backend. Returns where `updateQueue` found the
     * id; the persistence split ("live" → nothing, "seed" → gateway appends)
     * is documented on the function itself.
     */
    updateQueuedMessage,
    closeAll,
    size: () => sessions.size,
    /**
     * Deliver one out-of-band event to a session's live /events connection.
     * Used internally by the wiring's eventSink adapter and the approval
     * hooks; exposed for hosts/tests that must push a session-scoped event
     * without riding a turn's stream. Returns whether anyone received it.
     */
    emitToSession,
    /**
     * Writes a session title when `source` outranks the stored one — the
     * ranking `PATCH /sessions/:id` answers 409 from, and the same path the
     * derived/model titles take. Exposed so the route and the turn loop share
     * one implementation of "who may rename this session".
     */
    writeTitle: writeSessionTitle,
    /**
     * Resolves and validates a `TurnConfig` without building/rebuilding an
     * agent — throws exactly as `runTurn()`'s internal call would. Exposed so
     * `POST /messages` can validate a request's `reasoningEffort` against the
     * resolved model's declared capability and answer with a genuine HTTP 400
     * *before* ever acking the turn, rather than only surfacing the failure
     * as a mid-stream `error` event after the agent factory has already run.
     */
    resolveConfig,
    /**
     * Throws when the turn's bound model declares text-only input. Exposed
     * so `POST /messages` can refuse attachments with a real HTTP 400 before
     * acking the turn.
     *
     * A missing or unresolvable binding is NOT this check's business — it
     * returns quietly and leaves that failure to the existing
     * resolveConfig()/runTurn() path, which reports it the way every other
     * binding error is reported.
     */
    async assertImageInput(requested: TurnConfig): Promise<void> {
      if (!providerStore || !requested.providerId || !requested.modelId) return;
      const resolved = await providerStore.resolveModel(requested.providerId, requested.modelId);
      if (!resolved) return;
      await assertImageInputSupported(requested.providerId, resolved);
    },
  };
}
