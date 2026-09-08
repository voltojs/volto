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
import type { Message, TranscriptEvent, TranscriptEventInput } from "@volto/core";
import { projectMessages } from "@volto/core";
import type { JsonlSessionStore } from "@volto/store-jsonl";
import { scopeToWorkspace } from "@volto/store-jsonl";
import type { PiAiProviderConfig } from "@volto/provider-pi-ai";
import { createWiredAgent, type WiringOptions } from "./wiring.js";
import { buildPermissionConfig, type UiPermissionMode } from "./permission-modes.js";
import { resolveProjectPath, unknownProjectMessage, type createProjectStore } from "./config/projects.js";
import type { createProviderStore } from "./config/providers.js";

export interface SessionRegistryOptions extends Omit<WiringOptions, "chatStore"> {
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
}

/**
 * Shape returned by providerStore.resolveModel — see config/providers.ts.
 * Both kinds are consumed by `rebuild()` below: each is projected into a
 * `PiAiProviderConfig` (same discriminant) and handed to `createWiredAgent`
 * via `WiringOptions.providerConfig`, which builds the actual ModelPort.
 */
type ResolvedCredentials =
  | { kind: "catalog"; piProvider: string; apiKey: string | null; code: string }
  | {
      kind: "custom";
      baseURL: string | null;
      apiKey: string | null;
      code: string;
      maxOutputTokens?: number;
      reasoning?: boolean;
    };

/** A session with no project/model/permission selection yet. */
const EMPTY_CONFIG: ResolvedConfig = {
  projectPath: undefined,
  projectId: undefined,
  providerId: undefined,
  modelId: undefined,
  baseURL: undefined,
  code: undefined,
  maxOutputTokens: undefined,
  keyFingerprint: undefined,
  permissionMode: undefined,
};

/** SHA-256 hex digest of an apiKey, for change detection without storing the secret. */
function fingerprintApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

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
}

interface Session {
  id: string;
  agent: ReturnType<typeof createWiredAgent> | null;
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
  lastUsed: number;
}

/** An event as an agent's stream() yields it.
 *
 * Since task-r6 the Runner double-writes every transcript event it persists,
 * so the non-delta vocabulary on the stream is the transcript's own: each
 * event carries the exact stamp ({time, turn?, step?}) that was recorded, on
 * top of `{type, data}`. A few raw events with no transcript counterpart
 * (reducer residuals like error/cancelled/self_correct, plus tool
 * effect-channel events from displayMetadata.pendingEvents) still ride
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
    ...wiring
  } = opts;

  const buildAgent = agentFactory ?? createWiredAgent;

  const sessions = new Map<string, Session>();

  function evictIfNeeded(): void {
    if (sessions.size <= maxSessions) return;
    // Evict the least recently used session that has no live connection.
    const candidates = [...sessions.values()]
      .filter((s) => !s.connection && !s.running)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    const victim = candidates[0];
    if (victim) sessions.delete(victim.id);
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
        lastUsed: Date.now(),
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
   * observability residuals (error/cancelled/self_correct) and tool
   * effect-channel events — are not part of the transcript vocabulary and
   * are dropped here (the raw `/stream` and `/ws` endpoints still expose
   * them). Turn boundaries need no mapper-side bookkeeping: they are
   * expressed by `turn_end` events, so `done()` and `resetTurn()` no longer
   * exist on the mapper.
   */
  function frame(session: Session, event: ChannelEvent): sse.SSEMessage | null {
    switch (event.type) {
      case "text_delta":
        return session.mapper.delta({ kind: "text", text: asString(event.data["text"]) });
      case "reasoning_delta":
        return session.mapper.delta({ kind: "reasoning", text: asString(event.data["text"]) });
      case "tool_use_delta":
        return session.mapper.delta({
          kind: "tool_use",
          callId: asString(event.data["toolCallId"]),
          // The "args" phase of a call omits the name; TranscriptDelta keeps
          // it optional so applyPartial folds in what is present.
          ...(typeof event.data["toolName"] === "string" ? { name: event.data["toolName"] as string } : {}),
          argumentsDelta: asString(event.data["argumentsDelta"]),
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

    const heartbeat = setInterval(() => {
      res.write(sse.formatSSEFrame(session.mapper.heartbeat()));
    }, heartbeatInterval);
    session.connection = { res, heartbeat };

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

    const config: ResolvedConfig = {
      projectPath,
      projectId: requested.projectId,
      providerId: requested.providerId,
      modelId: requested.modelId,
      baseURL: credentials.kind === "custom" ? credentials.baseURL : null,
      code: credentials.code,
      maxOutputTokens: credentials.kind === "custom" ? credentials.maxOutputTokens : undefined,
      keyFingerprint: credentials.apiKey ? fingerprintApiKey(credentials.apiKey) : undefined,
      permissionMode: requested.permissionMode,
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
      a.permissionMode === b.permissionMode
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
    session.agent = buildAgent({
      ...wiring,
      ...(config.projectPath ? { cwd: config.projectPath } : {}),
      ...(credentials
        ? {
            model: credentials.code,
            // `wiring.modelPort`, if the caller supplied one (e.g. tests via
            // `agentFactory`), still wins: `createWiredAgent` only falls back
            // to building a port from `providerConfig` when no explicit
            // `modelPort` is given (see wiring.ts). This targets the exact
            // provider this turn resolved to — not a default — since both
            // branches read `config.providerId`/`credentials` verbatim.
            providerConfig: (credentials.kind === "catalog"
              ? {
                  kind: "catalog",
                  id: config.providerId ?? "default",
                  piProvider: credentials.piProvider,
                  apiKey: credentials.apiKey ?? undefined,
                  modelCodes: [credentials.code],
                }
              : {
                  kind: "custom",
                  id: config.providerId ?? "default",
                  // Mirrors provider-openai's own default when no baseURL is resolved.
                  baseURL: credentials.baseURL ?? "https://api.openai.com",
                  apiKey: credentials.apiKey ?? undefined,
                  models: [{ code: credentials.code, reasoning: credentials.reasoning }],
                }) satisfies PiAiProviderConfig,
          }
        : {}),
      ...(config.maxOutputTokens !== undefined ? { maxTokens: config.maxOutputTokens } : {}),
      ...(config.permissionMode
        ? { permissionConfig: buildPermissionConfig(config.permissionMode) }
        : {}),
      ...(session.history.length > 0 ? { initialMessages: session.history } : {}),
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
            },
          }
        : {}),
    });
    session.config = config;
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
   * Errors are delivered as protocol `error` events rather than thrown, so a
   * failed turn never kills the connection or the process. The session's
   * agent is only rebuilt when its resolved config (project path, model,
   * permission tier) differs from the one it was last built with — a
   * rebuild re-seeds conversation history since a fresh `createAgent`
   * instance starts with none.
   */
  async function runTurn(
    sessionId: string,
    message: string,
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
      if (!session.agent || !sameConfig(session.config, config)) {
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
    session.abort.abort();
    return true;
  }

  /** Close every connection and drop all sessions (used on shutdown). */
  function closeAll(): void {
    for (const session of sessions.values()) {
      detach(session);
    }
    sessions.clear();
  }

  return {
    get,
    attach,
    detachById,
    hasConnection,
    runTurn,
    interrupt,
    ensureAgent,
    closeAll,
    size: () => sessions.size,
  };
}
