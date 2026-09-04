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
import type { Message } from "@volto/core";
import { projectMessages } from "@volto/core";
import type { JsonlSessionStore } from "@volto/store-jsonl";
import { scopeToWorkspace } from "@volto/store-jsonl";
import { createOpenAIModelPort } from "@volto/provider-openai";
import { createWiredAgent, type WiringOptions } from "./wiring.js";
import { buildPermissionConfig, type UiPermissionMode } from "./permission-modes.js";
import type { createProjectStore } from "./config/projects.js";
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
  /**
   * SHA-256 hex digest of the resolved apiKey — never the plaintext. Lets a
   * rotated key be distinguished from an unchanged one without storing the
   * secret on the session.
   */
  keyFingerprint: string | undefined;
  permissionMode: UiPermissionMode | undefined;
}

/** Shape returned by providerStore.resolveModel — see config/providers.ts. */
interface ResolvedCredentials {
  baseURL: string | null;
  apiKey: string | null;
  code: string;
}

/** A session with no project/model/permission selection yet. */
const EMPTY_CONFIG: ResolvedConfig = {
  projectPath: undefined,
  projectId: undefined,
  providerId: undefined,
  modelId: undefined,
  baseURL: undefined,
  code: undefined,
  keyFingerprint: undefined,
  permissionMode: undefined,
};

/** SHA-256 hex digest of an apiKey, for change detection without storing the secret. */
function fingerprintApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
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
  lastUsed: number;
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
        lastUsed: Date.now(),
      };
      sessions.set(sessionId, session);
      evictIfNeeded();
    }
    session.lastUsed = Date.now();
    return session;
  }

  function push(session: Session, message: sse.SSEMessage): void {
    session.buffer.push(message);
    if (session.buffer.length > replayBufferSize) session.buffer.shift();
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
    const project = await projectStore.findById(requested.projectId);
    if (!project) throw new Error(`Unknown project: ${requested.projectId}`);
    const projectPath = project.path;

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
      baseURL: credentials.baseURL,
      code: credentials.code,
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
      a.keyFingerprint === b.keyFingerprint &&
      a.permissionMode === b.permissionMode
    );
  }

  /** Construct an agent for the resolved config, seeding prior history. */
  async function rebuild(
    session: Session,
    config: ResolvedConfig,
    credentials: ResolvedCredentials | null,
  ): Promise<void> {
    session.agent = buildAgent({
      ...wiring,
      ...(config.projectPath ? { cwd: config.projectPath } : {}),
      ...(credentials
        ? {
            model: credentials.code,
            modelPort: wiring.modelPort ?? createOpenAIModelPort({
              apiKey: credentials.apiKey ?? "",
              ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}),
              defaultModel: credentials.code,
            }),
          }
        : {}),
      ...(config.permissionMode
        ? { permissionConfig: buildPermissionConfig(config.permissionMode) }
        : {}),
      ...(session.history.length > 0 ? { initialMessages: session.history } : {}),
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
    session.mapper.resetTurn();

    // Captures whatever history this turn produced (success or failure)
    // before `done` is pushed. Durable persistence of messages/errors is now
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
      for await (const event of session.agent!.stream(message)) {
        const mapped = session.mapper.map(event);
        if (mapped) push(session, mapped);
      }
      await captureHistory();
      push(session, session.mapper.done());
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
        await chatStore
          ?.appendEvents(session.config?.projectPath ?? null, sessionId, [
            { time: Date.now(), type: "error", data: { message: text } },
          ])
          .catch(() => {});
      }
      // Capture whatever partial progress this failed turn made before
      // terminating it, so the client leaves its streaming state only once
      // the transcript is caught up.
      await captureHistory();
      push(session, session.mapper.done());
    } finally {
      session.running = false;
    }
  }

  /** Close every connection and drop all sessions (used on shutdown). */
  function closeAll(): void {
    for (const session of sessions.values()) {
      detach(session);
    }
    sessions.clear();
  }

  return { get, attach, detachById, hasConnection, runTurn, ensureAgent, closeAll, size: () => sessions.size };
}
