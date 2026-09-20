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
import { sse } from "@volto/sdk";
import type { Message, TranscriptEvent, TranscriptEventInput, CompactionConfig, AgentInput, PermissionRule } from "@volto/core";
import { projectMessages, isPermissionReminder, tokenizeCommand, isMatchableCommandToken } from "@volto/core";
import type { JsonlSessionStore } from "@volto/store-jsonl";
import { scopeToWorkspace } from "@volto/store-jsonl";
import { createPiAiModelPort, type PiAiProviderConfig } from "@volto/provider-pi-ai";
import { createWiredAgent, type WiringOptions } from "./wiring.js";
import { buildPermissionConfig, sandboxModeFor, type UiPermissionMode } from "./permission-modes.js";
import { resolveProjectPath, unknownProjectMessage, type createProjectStore } from "./config/projects.js";
import type { createProviderStore } from "./config/providers.js";
import { createApprovalRegistry, type ApprovalDecision, type ApprovalRegistry, type ApprovalRegistryHooks } from "./approval-gate.js";
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
  projectStore?: ReturnType<typeof createProjectStore>;
  providerStore?: ReturnType<typeof createProviderStore>;
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
  /** Resolved from the provider record so an in-place edit is detected too. */
  baseURL: string | null | undefined;
  code: string | undefined;
  /** Per-call output cap from the model record; undefined means the provider default. */
  maxOutputTokens: number | undefined;
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
type ResolvedCredentials =
  | {
      kind: "catalog";
      piProvider: string;
      baseURL: string | null;
      apiKey: string | null;
      code: string;
      maxOutputTokens?: number;
      /** User override of pi-ai's catalog reasoning flag; absent = follow catalog. */
      reasoning?: boolean;
    }
  | {
      kind: "custom";
      baseURL: string | null;
      apiKey: string | null;
      code: string;
      maxOutputTokens?: number;
      reasoning?: boolean;
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
const EMPTY_CONFIG: ResolvedConfig = {
  projectPath: undefined,
  projectId: undefined,
  providerId: undefined,
  modelId: undefined,
  baseURL: undefined,
  code: undefined,
  maxOutputTokens: undefined,
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
        modelCodes: [credentials.code],
        // Same for reasoning: only a stored override is forwarded, so an
        // untouched model keeps tracking pi-ai's catalog flag.
        ...(credentials.reasoning !== undefined
          ? { reasoningOverrides: { [credentials.code]: credentials.reasoning } }
          : {}),
      }
    : {
        kind: "custom",
        id: providerId ?? "default",
        // Mirrors provider-openai's own default when no baseURL is resolved.
        baseURL: credentials.baseURL ?? "https://api.openai.com",
        apiKey: credentials.apiKey ?? undefined,
        models: [{ code: credentials.code, reasoning: credentials.reasoning }],
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
 * them, throwing when the model declares `vision: false`.
 *
 * The composer already hides its attachment entry for such a model, but UI
 * gating is not a boundary — a direct API call must be refused too. Only an
 * explicit `false` gates: UNKNOWN (an absent flag, e.g. a gateway that
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
  if (info.vision === false) {
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
 */
const DEFAULT_COMPACTION: Omit<CompactionConfig, "tokenizer"> = {
  maxTokens: 60_000,
  recentKeepCount: 4,
  toolResultMaxChars: 8000,
  summaryMaxTokens: 4096,
};

/**
 * Plan 2: absent config → DEFAULT_COMPACTION (compaction ON by default);
 * explicit `false` disables; an object is used as-is. Never silently
 * invents values beyond the documented defaults above.
 */
function resolveHostCompaction(
  configured: Omit<CompactionConfig, "tokenizer"> | false | undefined,
): Omit<CompactionConfig, "tokenizer"> | undefined {
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

interface Session {
  id: string;
  agent: Awaited<ReturnType<typeof createWiredAgent>> | null;
  config: ResolvedConfig | null;
  history: Message[];
  mapper: ReturnType<typeof sse.createEventMapper>;
  connection: Connection | null;
  buffer: sse.SSEMessage[];
  running: boolean;
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

export function createSessionRegistry(opts: SessionRegistryOptions = {}) {
  const {
    maxSessions = 100,
    replayBufferSize = 200,
    heartbeatInterval = 15_000,
    projectStore,
    providerStore,
    agentFactory,
    chatStore,
    attachmentStoreFor,
    // Destructured out so `wiring` never carries a raw `false` that the
    // spread below would leak into createAgent.
    compaction: configuredCompaction,
    ...wiring
  } = opts;

  const buildAgent = agentFactory ?? createWiredAgent;

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
      // Both kinds can carry one now, and it is part of a turn's identity:
      // sameConfig() compares it to decide whether to rebuild the agent.
      baseURL: credentials.baseURL,
      code: credentials.code,
      // Both kinds carry an optional per-model cap now that catalog models
      // are configurable records rather than bare codes.
      maxOutputTokens: credentials.maxOutputTokens,
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
      a.baseURL === b.baseURL &&
      a.code === b.code &&
      a.maxOutputTokens === b.maxOutputTokens &&
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
  ): Promise<void> {
    const initialTurn = await resolveInitialTurn(session.id);
    // The paused turn a cross-process resume continues is the last turn —
    // exactly the one initialTurn names — so its step seed is looked up
    // against that ordinal. Only consumed by the SDK's cross-process resume
    // fallback Runner; ordinary new turns ignore it entirely.
    const initialStep = initialTurn !== undefined ? await resolveInitialStep(session.id, initialTurn) : undefined;
    // Real path of the credential dir, denied to the sandbox on both the
    // shell and fs sides. Resolved here (async context) rather than inside
    // buildSandboxConfigs, which stays synchronous.
    const configDirRealPath = await getConfigDirRealPath();
    const seeded = seedHistory(session.history);
    // Plan 2: default-on. Absent config uses DEFAULT_COMPACTION; false disables.
    const compaction = resolveHostCompaction(configuredCompaction);
    // A rebuild replaces the instance, so the outgoing one's persistent bash
    // session and background processes have to be reclaimed here — nothing
    // else holds a reference to them afterwards.
    const outgoing = session.agent;
    session.agent = await buildAgent({
      ...wiring,
      // Explicit override of the spread so the default-on decision is visible here.
      ...(compaction !== undefined ? { compaction } : {}),
      // Same store the /attachments routes wrote to, scoped to this session:
      // the Runner resolves image refs against it when it assembles the
      // ModelRequest.
      ...(attachmentStoreFor ? { attachmentStore: attachmentStoreFor(session.id) } : {}),
      ...(config.projectPath ? { cwd: config.projectPath } : {}),
      configDirRealPath,
      ...(credentials
        ? {
            model: credentials.code,
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
      ...(initialTurn !== undefined ? { initialTurn } : {}),
      ...(initialStep !== undefined ? { initialStep } : {}),
      ...(chatStore
        ? {
            chatStore: scopeToWorkspace(chatStore, config.projectPath ?? null),
            chatSessionId: session.id,
            chatMeta: {
              projectId: config.projectId ?? null,
              providerId: config.providerId ?? null,
              modelId: config.modelId ?? null,
              permissionMode: config.permissionMode ?? null,
              ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
            },
          }
        : {}),
    });
    session.config = config;
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
    if (session.running) {
      push(session, session.mapper.error("A turn is already running for this session", "BUSY", true));
      return;
    }

    // Cold start (server restart, or first turn after this Session object was
    // just created by get()): the in-memory history is empty, but a durable
    // transcript from a prior process may still exist. Without this, a
    // restart silently truncates multi-turn context back to zero even though
    // it was recorded on disk.
    if (chatStore && session.history.length === 0) {
      const persisted = await chatStore.readSession(sessionId).catch(() => undefined);
      if (persisted) session.history = projectMessages(persisted.events);
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
    try {
      const { config, credentials } = await resolveConfig(requested);
      if (!session.agent || !sameConfig(session.config, config) || session.permissionsDirty) {
        session.permissionsDirty = false;
        await rebuild(session, config, credentials);
      }

      turnReachedStream = true;
      const abort = new AbortController();
      session.abort = abort;
      for await (const event of session.agent!.stream(message, { signal: abort.signal })) {
        push(session, frame(session, event));
      }
      await captureHistory();
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
    runTurn,
    interrupt,
    decideApproval,
    ensureAgent,
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
     * Resolves and validates a `TurnConfig` without building/rebuilding an
     * agent — throws exactly as `runTurn()`'s internal call would. Exposed so
     * `POST /messages` can validate a request's `reasoningEffort` against the
     * resolved model's declared capability and answer with a genuine HTTP 400
     * *before* ever acking the turn, rather than only surfacing the failure
     * as a mid-stream `error` event after the agent factory has already run.
     */
    resolveConfig,
    /**
     * Throws when the turn's bound model declares `vision: false`. Exposed
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
