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
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { projectMessageEntries } from "@volto/core";
import { readConversation, readTrajectory } from "@volto/sdk";
import {
  createStore as createJsonlStore,
  TranscriptFormatError,
  asTranscriptReader,
  type ChatSessionMeta,
  type JsonlSessionStore,
} from "@volto/store-jsonl";
import { createWiredAgent, type WiringOptions } from "./wiring.js";
import { createSkillRegistry } from "./skills/registry.js";
import { readContextUsageFold } from "./context-usage.js";
import { createSseEventSink, createWsEventSink } from "./event-sinks.js";
import { createSessionRegistry } from "./sessions.js";
import { createProjectStore, InvalidPathError } from "./config/projects.js";
import { createProviderStore } from "./config/providers.js";
import { getConfigDir } from "./config/paths.js";
import { isUiPermissionMode } from "./permission-modes.js";
import {
  createDirectoryPicker,
  PickerBusyError,
  PickerUnsupportedError,
} from "./fs/directory-picker.js";
import { CommandTimeoutError } from "./fs/command-runner.js";

export interface ServerOptions extends Omit<WiringOptions, "chatStore"> {
  port?: number;
  /**
   * Allowed browser origin, reflected as `Access-Control-Allow-Origin` and
   * enforced against every request's `Origin` header. Defaults to the
   * `apps/web` dev server's own origin — a browser is the threat surface a
   * local gateway needs to worry about (it can enumerate providers, drive
   * the agent with `permissionMode: "auto-accept"`, and read the response
   * cross-origin if this were `"*"`). Non-browser clients (`apps/ide-extension`,
   * `apps/chat-adapter`, curl) send no `Origin` header at all and are never
   * subject to this check. Set to `"*"` to deliberately expose the gateway
   * to any origin, or to a different origin for another trusted deployment.
   * Falls back to the `VOLTO_CORS_ORIGIN` env var, then to the dev default —
   * a production `next start` build serves on a different port (3000) than
   * the `next dev` default this hardcodes, and has no other way to configure
   * around the 403 that would otherwise produce.
   */
  corsOrigin?: string;
  /** SSE heartbeat interval in ms. @default 15000 */
  heartbeatInterval?: number;
  /**
   * Interface to bind. Defaults to loopback: the client may name any absolute
   * path as a project root, so binding all interfaces would expose this
   * machine's filesystem to the local network.
   */
  host?: string;
  /** Overridable directory picker — production uses the native dialog. */
  directoryPicker?: ReturnType<typeof createDirectoryPicker>;
  /** Overridable chat transcript store — production writes to ~/.volto/sessions. */
  chatStore?: JsonlSessionStore;
}

/** Session id used when a client does not supply one. */
const DEFAULT_SESSION_ID = "default";

/** The web app's own dev origin — see `ServerOptions.corsOrigin`. */
const DEFAULT_CORS_ORIGIN = "http://localhost:6100";

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
  const corsOrigin = opts.corsOrigin ?? process.env["VOLTO_CORS_ORIGIN"] ?? DEFAULT_CORS_ORIGIN;
  // The legacy shared agent (used by /resume, /stream, /ws when no sessionId is
  // given) has no per-session scoping, so it never gets the durable transcript
  // store — `opts.chatStore` here is the unscoped, whole-workspace store type
  // (JsonlSessionStore), not the already-scoped TranscriptStore createWiredAgent
  // expects. Only `registry` (below) wires chatStore in, per-session, via
  // scopeToWorkspace() inside sessions.ts's rebuild().
  const { chatStore: _rawChatStore, ...agentOpts } = opts;
  const agent = createWiredAgent(agentOpts);
  // Same fallback as createWiredAgent's own `cwd` resolution (wiring.ts) — kept
  // in sync here so /skills reports the same workspace the legacy (no
  // sessionId) agent above actually loads. Per-session agents (rebuild() in
  // sessions.ts) can resolve a different, per-project cwd from projectStore,
  // but /skills takes no project/session id, so it can only speak for this
  // process-wide default.
  const cwd = agentOpts.cwd ?? process.cwd();
  const projectStore = createProjectStore();
  const providerStore = createProviderStore();
  const directoryPicker = opts.directoryPicker ?? createDirectoryPicker();
  const chatStore = opts.chatStore ?? createJsonlStore({ directory: path.join(getConfigDir(), "sessions") });
  const registry = createSessionRegistry({ ...opts, projectStore, providerStore, chatStore });

  /**
   * Only a browser attaches an `Origin` header; a non-browser client (curl,
   * `apps/ide-extension`, `apps/chat-adapter`) sends none and is never
   * subject to this check — there is nothing for CORS to protect there.
   */
  function isOriginAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    return corsOrigin === "*" || origin === corsOrigin;
  }

  function corsHeadersFor(origin: string | undefined): Record<string, string> {
    return {
      // Echo the request's own origin rather than the configured value so a
      // single fixed `corsOrigin` still behaves like a normal allow-list
      // entry; "*" is sent verbatim since it authorizes every origin anyway.
      "Access-Control-Allow-Origin": origin && corsOrigin !== "*" ? origin : corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    };
  }

  /** Flattens a session's persisted chatMeta into the response's binding fields. */
  function bindingsOf(
    meta: ChatSessionMeta,
  ): Pick<ChatSessionMeta, "projectId" | "providerId" | "modelId" | "permissionMode"> {
    return {
      projectId: meta.projectId,
      providerId: meta.providerId,
      modelId: meta.modelId,
      permissionMode: meta.permissionMode,
    };
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const originHeader = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

    if (!isOriginAllowed(originHeader)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Origin not allowed: ${originHeader}` }));
      return;
    }

    const corsHeaders = corsHeadersFor(originHeader);

    function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
      res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify(body));
    }

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
          projectId?: string;
          providerId?: string;
          modelId?: string;
          permissionMode?: string;
        };
        const sessionId = body.sessionId ?? DEFAULT_SESSION_ID;

        if (!body.message) {
          jsonResponse(res, 400, { error: "message is required" });
          return;
        }
        // A malformed request must be rejected before the connection-state
        // check below, so an invalid body is never masked by a 409.
        if (body.permissionMode !== undefined && !isUiPermissionMode(body.permissionMode)) {
          jsonResponse(res, 400, { error: `Unsupported permissionMode: ${body.permissionMode}` });
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
        void registry.runTurn(sessionId, body.message, {
          ...(body.projectId ? { projectId: body.projectId } : {}),
          ...(body.providerId ? { providerId: body.providerId } : {}),
          ...(body.modelId ? { modelId: body.modelId } : {}),
          ...(isUiPermissionMode(body.permissionMode) ? { permissionMode: body.permissionMode } : {}),
        });
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
        // A session's agent is only constructed lazily. `ensureAgent` builds
        // (or reuses) a session-scoped instance so a sessionId still gets
        // isolated history instead of falling back to the single process-wide
        // `agent`, which would otherwise leak one session's context into
        // another's. Only the no-sessionId case uses the shared agent.
        const target = body.sessionId ? await registry.ensureAgent(body.sessionId) : agent;
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

    // GET /projects
    if (req.method === "GET" && url.pathname === "/projects") {
      try {
        jsonResponse(res, 200, await projectStore.list());
      } catch (err: unknown) {
        // A corrupt projects.json throws ConfigCorruptError from list() —
        // without this try/catch it escaped as an unhandled rejection: no
        // response was ever written (the client hung until timeout) and,
        // under Node's default --unhandled-rejections=throw, the whole
        // process exited. Surface it as a normal 500 instead.
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // POST /projects
    if (req.method === "POST" && url.pathname === "/projects") {
      try {
        const body = JSON.parse(await readBody(req)) as { name?: string; path?: string };
        if (!body.name || !body.path) {
          jsonResponse(res, 400, { error: "name and path are required" });
          return;
        }
        jsonResponse(res, 201, await projectStore.create({ name: body.name, path: body.path }));
      } catch (err: unknown) {
        const status = err instanceof InvalidPathError ? 400 : 500;
        jsonResponse(res, status, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // DELETE /projects/:id
    if (req.method === "DELETE" && url.pathname.startsWith("/projects/")) {
      try {
        const id = decodeURIComponent(url.pathname.slice("/projects/".length));
        const removed = await projectStore.remove(id);
        jsonResponse(res, removed ? 200 : 404, { removed });
      } catch (err: unknown) {
        jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET /providers
    if (req.method === "GET" && url.pathname === "/providers") {
      try {
        jsonResponse(res, 200, await providerStore.listPublic());
      } catch (err: unknown) {
        // Same corrupt-file failure mode as GET /projects above.
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // POST /providers
    if (req.method === "POST" && url.pathname === "/providers") {
      try {
        const body = JSON.parse(await readBody(req)) as { name?: string };
        if (!body.name) {
          jsonResponse(res, 400, { error: "name is required" });
          return;
        }
        jsonResponse(res, 201, await providerStore.create(body as Parameters<typeof providerStore.create>[0]));
      } catch (err: unknown) {
        jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // PUT /providers/:id
    if (req.method === "PUT" && url.pathname.startsWith("/providers/")) {
      try {
        const id = decodeURIComponent(url.pathname.slice("/providers/".length));
        const body = JSON.parse(await readBody(req)) as Parameters<typeof providerStore.update>[1];
        const updated = await providerStore.update(id, body);
        jsonResponse(res, updated ? 200 : 404, updated ?? { error: "Not found" });
      } catch (err: unknown) {
        jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // DELETE /providers/:id
    if (req.method === "DELETE" && url.pathname.startsWith("/providers/")) {
      try {
        const id = decodeURIComponent(url.pathname.slice("/providers/".length));
        const removed = await providerStore.remove(id);
        jsonResponse(res, removed ? 200 : 404, { removed });
      } catch (err: unknown) {
        jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET /skills — the discovery catalog, including skills the model may not
    // invoke. The web app's /name autocomplete consumes userInvocable; the
    // model-facing catalog is assembled separately inside the SDK.
    if (req.method === "GET" && url.pathname === "/skills") {
      try {
        const summaries = await createSkillRegistry(cwd).list();
        jsonResponse(res, 200, {
          skills: summaries.map((s) => ({
            name: s.name,
            description: s.description,
            modelInvocable: s.invocation.modelInvocable,
            userInvocable: s.invocation.userInvocable,
          })),
        });
      } catch (err: unknown) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET /sessions — lightweight list for the web app's session recovery
    if (req.method === "GET" && url.pathname === "/sessions") {
      try {
        const { records, skipped } = await chatStore.listSessions();
        // Sub-agent sessions are an implementation detail of the task tool —
        // surfacing them here would flood the user's session list with rows
        // they never started.
        const visible = records.filter((r) => r.meta.origin !== "subagent");
        jsonResponse(res, 200, {
          sessions: visible.map((record) => ({
            id: record.sessionId,
            projectId: record.meta.projectId,
            providerId: record.meta.providerId,
            modelId: record.meta.modelId,
            permissionMode: record.meta.permissionMode,
            messageCount: projectMessageEntries(record.events).length,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          })),
          unreadableSessions: skipped.length,
        });
      } catch (err: unknown) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET /sessions/:id/trajectory — the projected audit ledger for one session
    if (req.method === "GET") {
      const trajectoryMatch = url.pathname.match(/^\/sessions\/([^/]+)\/trajectory$/);
      if (trajectoryMatch) {
        const id = decodeURIComponent(trajectoryMatch[1]!);
        try {
          const view = await readTrajectory(asTranscriptReader(chatStore), id);
          jsonResponse(res, 200, view);
        } catch (err: unknown) {
          if (err instanceof TranscriptFormatError) {
            jsonResponse(res, 410, {
              error: "This session was written by an older version and cannot be read by this build.",
            });
            return;
          }
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    }

    // GET /sessions/:id — full transcript, projected to the web app's chat feed
    if (req.method === "GET" && url.pathname.startsWith("/sessions/")) {
      try {
        const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
        const record = await chatStore.readSession(id);
        if (!record) {
          jsonResponse(res, 404, { error: `Unknown session: ${id}` });
          return;
        }
        // The store hands over raw events; projecting them is the SDK facade's
        // job (apps/* may value-import core, stores-* may not).
        const view = await readConversation(asTranscriptReader(chatStore), id);
        // The usage meter is best-effort: a fold-read failure hides the ring
        // client-side rather than failing the whole session fetch.
        const contextUsage = await readContextUsageFold(chatStore, id).catch(() => null);
        jsonResponse(res, 200, {
          id,
          ...bindingsOf(record.meta),
          messages: view.messages,
          contextUsage,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      } catch (err: unknown) {
        if (err instanceof TranscriptFormatError) {
          jsonResponse(res, 410, {
            error: "This session was written by an older version and cannot be read by this build.",
          });
          return;
        }
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // POST /fs/pick-directory — open the OS directory dialog on this machine
    if (req.method === "POST" && url.pathname === "/fs/pick-directory") {
      try {
        // No request body is read: the dialog prompt is a server-side constant
        // and the caller has nothing to contribute.
        const path = await directoryPicker.pick();
        jsonResponse(res, 200, { path });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof PickerBusyError) {
          jsonResponse(res, 409, { error: message });
        } else if (err instanceof PickerUnsupportedError) {
          jsonResponse(res, 501, { error: message });
        } else if (err instanceof CommandTimeoutError) {
          jsonResponse(res, 504, { error: message });
        } else {
          jsonResponse(res, 500, { error: message });
        }
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

  const host = opts.host ?? "127.0.0.1";

  httpServer.listen(port, host, () => {
    console.log(`Headless server listening on http://${host}:${port}`);
  });

  return httpServer;
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer();
}
