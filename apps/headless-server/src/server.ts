/**
 * Headless server — HTTP + SSE + WebSocket gateway for volto.
 *
 * Protocol routes (consumed by apps/web via `@volto/sdk/sse`):
 *   GET  /events?sessionId=   — long-lived SSE channel for one chat session
 *   POST /messages            — { sessionId, message } triggers a turn on that channel
 *
 * Legacy routes (consumed by apps/ide-extension and apps/chat-adapter):
 *   POST /run                 — one-shot run, returns final state
 *   POST /resume              — HITL resume with decision
 *   GET  /stream?message=     — one-shot SSE of raw internal events
 *   GET  /ws                  — WebSocket streaming of raw internal events
 */

import * as http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createWiredAgent, type WiringOptions } from "./wiring.js";
import { createSseEventSink, createWsEventSink } from "./event-sinks.js";
import { createSessionRegistry } from "./sessions.js";

export interface ServerOptions extends WiringOptions {
  port?: number;
  /**
   * Value for `Access-Control-Allow-Origin`. Defaults to `*` so a local
   * `apps/web` dev server (a different port, therefore a different origin) can
   * talk to this gateway without a proxy.
   */
  corsOrigin?: string;
  /** SSE heartbeat interval in ms. @default 15000 */
  heartbeatInterval?: number;
}

/** Session id used when a client does not supply one. */
const DEFAULT_SESSION_ID = "default";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function createServer(opts: ServerOptions = {}): http.Server {
  const port = opts.port ?? 3100;
  const corsOrigin = opts.corsOrigin ?? "*";
  const agent = createWiredAgent(opts);
  const registry = createSessionRegistry(opts);

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
  };

  function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify(body));
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // GET /events — protocol SSE channel bound to a chat session
    if (req.method === "GET" && url.pathname === "/events") {
      const sessionId = url.searchParams.get("sessionId") ?? DEFAULT_SESSION_ID;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // Defeats proxy buffering, which would otherwise stall the stream.
        "X-Accel-Buffering": "no",
        ...corsHeaders,
      });
      // Node buffers headers until the first write. Without an explicit flush
      // the client never sees the 200 and its `open` event never fires, so the
      // channel looks permanently "connecting".
      res.flushHeaders();

      const lastEventId =
        (req.headers["last-event-id"] as string | undefined) ??
        url.searchParams.get("last-event-id") ??
        undefined;

      registry.attach(sessionId, res, lastEventId);
      req.on("close", () => registry.detachById(sessionId, res));
      return;
    }

    // POST /messages — trigger a turn, streamed over the session's /events channel
    if (req.method === "POST" && url.pathname === "/messages") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          message?: string;
          sessionId?: string;
        };
        const sessionId = body.sessionId ?? DEFAULT_SESSION_ID;

        if (!body.message) {
          jsonResponse(res, 400, { error: "message is required" });
          return;
        }
        if (!registry.hasConnection(sessionId)) {
          jsonResponse(res, 409, {
            error: `No active /events stream for session ${sessionId}`,
          });
          return;
        }

        // Ack immediately; the turn streams over SSE. runTurn never rejects —
        // failures are delivered to the client as protocol `error` events.
        jsonResponse(res, 202, { sessionId, accepted: true });
        void registry.runTurn(sessionId, body.message);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        jsonResponse(res, 400, { error: message });
      }
      return;
    }

    // POST /run — one-shot (legacy); honours sessionId for multi-turn history
    if (req.method === "POST" && url.pathname === "/run") {
      try {
        const body = JSON.parse(await readBody(req)) as { message: string; sessionId?: string };
        const target = body.sessionId ? registry.get(body.sessionId).agent : agent;
        const state = await target.run(body.message);
        jsonResponse(res, 200, { state });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        jsonResponse(res, 500, { error: message });
      }
      return;
    }

    // POST /resume — HITL
    if (req.method === "POST" && url.pathname === "/resume") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          sessionId: string;
          decision: "allow" | "deny";
        };
        const state = await agent.resume(body.sessionId, body.decision);
        jsonResponse(res, 200, { state });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        jsonResponse(res, 500, { error: message });
      }
      return;
    }

    // GET /stream — one-shot SSE of raw internal events (legacy)
    if (req.method === "GET" && url.pathname === "/stream") {
      const message = url.searchParams.get("message") ?? "";
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders,
      });

      const sink = createSseEventSink(res);
      const abortController = new AbortController();
      req.on("close", () => abortController.abort());

      try {
        const stream = agent.stream(message);
        for await (const event of stream) {
          sink.emit(event);
          if (abortController.signal.aborted) break;
        }
        res.write("data: [DONE]\n\n");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ type: "error", data: { message } })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    // GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { status: "ok" });
      return;
    }

    jsonResponse(res, 404, { error: "Not found" });
  });

  // WebSocket server on the same HTTP server
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname !== "/ws") {
      socket.close(1008, "Invalid path");
      return;
    }

    const message = url.searchParams.get("message") ?? "";
    const sink = createWsEventSink(socket);
    const abortController = new AbortController();

    socket.on("close", () => abortController.abort());

    (async () => {
      try {
        const stream = agent.stream(message);
        for await (const event of stream) {
          sink.emit(event);
          if (abortController.signal.aborted || socket.readyState !== socket.OPEN) break;
        }
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "done", data: {} }));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "error", data: { message: msg } }));
        }
      }
    })();
  });

  httpServer.on("close", () => registry.closeAll());

  httpServer.listen(port, () => {
    console.log(`Headless server listening on http://localhost:${port}`);
  });

  return httpServer;
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer();
}
