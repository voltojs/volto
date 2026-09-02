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
import { createWiredAgent, type WiringOptions } from "./wiring.js";

export interface SessionRegistryOptions extends WiringOptions {
  /** Maximum number of live sessions before the oldest is evicted. @default 100 */
  maxSessions?: number;
  /** Events retained per session for Last-Event-ID replay. @default 200 */
  replayBufferSize?: number;
  /** SSE heartbeat interval in ms. @default 15000 */
  heartbeatInterval?: number;
}

interface Connection {
  res: http.ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}

interface Session {
  id: string;
  agent: ReturnType<typeof createWiredAgent>;
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
    ...wiring
  } = opts;

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
        agent: createWiredAgent(wiring),
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
   * Run one turn for a session, streaming every event onto its SSE channel.
   *
   * Errors are delivered as protocol `error` events rather than thrown, so a
   * failed turn never kills the connection or the process.
   */
  async function runTurn(sessionId: string, message: string): Promise<void> {
    const session = get(sessionId);
    if (session.running) {
      push(session, session.mapper.error("A turn is already running for this session", "BUSY", true));
      return;
    }

    session.running = true;
    session.mapper.resetTurn();

    try {
      for await (const event of session.agent.stream(message)) {
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
