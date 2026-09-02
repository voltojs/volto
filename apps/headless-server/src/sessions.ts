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
import { sse } from "@volto/sdk";
import type { Message } from "@volto/core";
import { createOpenAIModelPort } from "@volto/provider-openai";
import { createWiredAgent, type WiringOptions } from "./wiring.js";
import { buildPermissionConfig, type UiPermissionMode } from "./permission-modes.js";
import type { createProjectStore } from "./config/projects.js";
import type { createProviderStore } from "./config/providers.js";

export interface SessionRegistryOptions extends WiringOptions {
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
  providerId: string | undefined;
  modelId: string | undefined;
  permissionMode: UiPermissionMode | undefined;
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

  /** Turn the ids sent by the client into concrete construction inputs. */
  async function resolveConfig(requested: TurnConfig): Promise<ResolvedConfig> {
    let projectPath: string | undefined;
    if (requested.projectId) {
      const project = await projectStore?.findById(requested.projectId);
      if (!project) throw new Error(`Unknown project: ${requested.projectId}`);
      projectPath = project.path;
    }

    if (requested.providerId && requested.modelId) {
      const resolved = await providerStore?.resolveModel(requested.providerId, requested.modelId);
      if (!resolved) {
        throw new Error(`Unknown model: ${requested.providerId}/${requested.modelId}`);
      }
    }

    return {
      projectPath,
      providerId: requested.providerId,
      modelId: requested.modelId,
      permissionMode: requested.permissionMode,
    };
  }

  function sameConfig(a: ResolvedConfig | null, b: ResolvedConfig): boolean {
    return (
      a !== null &&
      a.projectPath === b.projectPath &&
      a.providerId === b.providerId &&
      a.modelId === b.modelId &&
      a.permissionMode === b.permissionMode
    );
  }

  /** Construct an agent for the resolved config, seeding prior history. */
  async function rebuild(session: Session, config: ResolvedConfig): Promise<void> {
    const credentials =
      config.providerId && config.modelId
        ? await providerStore?.resolveModel(config.providerId, config.modelId)
        : null;

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
    });
    session.config = config;
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

    session.running = true;
    session.mapper.resetTurn();

    try {
      const config = await resolveConfig(requested);
      if (!session.agent || !sameConfig(session.config, config)) {
        await rebuild(session, config);
      }

      for await (const event of session.agent!.stream(message)) {
        const mapped = session.mapper.map(event);
        if (mapped) push(session, mapped);
      }
      push(session, session.mapper.done());
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      push(session, session.mapper.error(text));
      // Still terminate the turn so the client leaves its streaming state.
      push(session, session.mapper.done());
    } finally {
      // Capture history even on failure so a partial turn is not lost.
      if (session.agent) {
        try {
          session.history = session.agent.getState().messages;
        } catch {
          // A never-run agent has no state yet; keep the previous history.
        }
      }
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

  return { get, attach, detachById, hasConnection, runTurn, closeAll, size: () => sessions.size };
}
