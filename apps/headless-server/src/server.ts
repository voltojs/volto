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
import { readContextUsageSnapshot } from "./context-usage.js";
import { createSseEventSink, createWsEventSink } from "./event-sinks.js";
import { createSessionRegistry } from "./sessions.js";
import {
  createProjectStore,
  InvalidPathError,
  resolveProjectPath,
  unknownProjectMessage,
} from "./config/projects.js";
import { createProviderStore, type PublicProvider } from "./config/providers.js";
import { createPiAiModelPort, listCatalogProviders, type PiAiProviderConfig } from "@volto/provider-pi-ai";
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

/**
 * Inline each configured model's resolved reasoning capability into a
 * `GET /providers` response.
 *
 * `ModelPort.describeModel` (from `createPiAiModelPort`) is used to derive
 * this rather than duplicating pi-ai's capability logic: it re-projects
 * pi-ai's statically generated catalog metadata (catalog-kind models) or the
 * stored `reasoning` flag (custom-kind models) into `{ efforts, defaultEffort? }`
 * — no apiKey is read and no network request is made, since building a
 * `Models` collection and looking up a model's declared thinking levels are
 * both pure, synchronous operations (see collection.ts's `describeModelInfo`).
 * A model with no reasoning capability gets no `reasoning` key at all —
 * never an empty/`off`-only list — matching the contract `describeModelInfo`
 * already enforces; this function must not undo that while projecting.
 *
 * Never touches `apiKeyMasked` — every field from the input `PublicProvider`
 * survives untouched except `models`, which is rebuilt from scratch without
 * ever reading `apiKeyEnc`/the plaintext key.
 */
async function withReasoningCapability(providers: PublicProvider[]): Promise<unknown[]> {
  return Promise.all(
    providers.map(async (provider) => {
      if (provider.kind === "catalog") {
        const config: PiAiProviderConfig = {
          kind: "catalog",
          id: provider.id,
          piProvider: provider.piProvider,
          modelCodes: provider.modelCodes,
        };
        const port = createPiAiModelPort({ providers: [config], defaultProviderId: provider.id });
        const models = await Promise.all(
          provider.modelCodes.map(async (code) => {
            const info = await port.describeModel!(code);
            return { code, ...(info.reasoning ? { reasoning: info.reasoning } : {}) };
          }),
        );
        return { ...provider, models };
      }

      const config: PiAiProviderConfig = {
        kind: "custom",
        id: provider.id,
        baseURL: provider.baseURL ?? "",
        models: provider.models.map((m) => ({
          code: m.code,
          name: m.name,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          reasoning: m.reasoning,
        })),
      };
      const port = createPiAiModelPort({ providers: [config], defaultProviderId: provider.id });
      const models = await Promise.all(
        provider.models.map(async (m) => {
          const info = await port.describeModel!(m.code);
          // The stored boolean `reasoning` config flag is replaced by the
          // resolved capability object on the wire — never both.
          const { reasoning: _reasoningFlag, ...rest } = m;
          return { ...rest, ...(info.reasoning ? { reasoning: info.reasoning } : {}) };
        }),
      );
      return { ...provider, models };
    }),
  );
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
  // sessionId) agent above actually loads. This is only /skills' default: a
  // caller that supplies ?projectId= gets that project's own cwd instead (see
  // the /skills route below), resolved through projectStore exactly like
  // sessions.ts's resolveConfig() resolves a turn's cwd.
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
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    };
  }

  /**
   * Flattens a session's persisted chatMeta into the response's binding fields.
   *
   * `reasoningEffort` is headless-server's own extra config-binding field (see
   * wiring.ts's `chatMeta` option) — it is not part of core's `ChatSessionMeta`
   * and is persisted as untyped JSON at rest, so it is read back here via the
   * same local widening wiring.ts uses to write it, rather than by touching
   * `@volto/core`.
   */
  function bindingsOf(
    meta: ChatSessionMeta & { reasoningEffort?: string },
  ): Pick<ChatSessionMeta, "projectId" | "providerId" | "modelId" | "permissionMode"> & {
    reasoningEffort?: string;
  } {
    return {
      projectId: meta.projectId,
      providerId: meta.providerId,
      modelId: meta.modelId,
      permissionMode: meta.permissionMode,
      ...(meta.reasoningEffort !== undefined ? { reasoningEffort: meta.reasoningEffort } : {}),
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
          reasoningEffort?: string;
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

        const turnConfig = {
          ...(body.projectId ? { projectId: body.projectId } : {}),
          ...(body.providerId ? { providerId: body.providerId } : {}),
          ...(body.modelId ? { modelId: body.modelId } : {}),
          ...(isUiPermissionMode(body.permissionMode) ? { permissionMode: body.permissionMode } : {}),
          ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
        };

        // A requested reasoningEffort is validated against the resolved
        // model's declared capability BEFORE any provider I/O and BEFORE the
        // turn is ever acked — an unsupported value must answer with a real
        // HTTP 400 and never reach the agent factory, not merely surface as a
        // mid-stream `error` event after an agent has already been built.
        // Only reached when the caller actually asked for an effort: an
        // omitted `reasoningEffort` keeps the exact prior behavior (whatever
        // resolveConfig()/runTurn() already did for project/provider/model
        // resolution failures — a 202 ack followed by an SSE `error` frame).
        if (body.reasoningEffort !== undefined) {
          try {
            await registry.resolveConfig(turnConfig);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            jsonResponse(res, 400, { error: message });
            return;
          }
        }

        // Ack immediately; the turn streams over SSE. runTurn never rejects —
        // failures are delivered to the client as protocol `error` events.
        jsonResponse(res, 202, { sessionId, accepted: true });
        void registry.runTurn(sessionId, body.message, turnConfig);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        jsonResponse(res, 400, { error: message });
      }
      return;
    }

    // POST /interrupt — cancel the turn currently streaming on a session
    if (req.method === "POST" && url.pathname === "/interrupt") {
      try {
        const body = JSON.parse(await readBody(req)) as { sessionId?: string };
        const sessionId = body.sessionId ?? DEFAULT_SESSION_ID;
        // 409 rather than a silent 200: "nothing was running" is a real
        // answer the client can act on, not an interrupt that succeeded.
        if (!registry.interrupt(sessionId)) {
          jsonResponse(res, 409, { error: `No running turn for session ${sessionId}` });
          return;
        }
        jsonResponse(res, 202, { sessionId, interrupted: true });
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

    // GET /catalog/providers — pi-ai's built-in provider catalog. A static
    // projection (see listCatalogProviders): no user input, no credentials,
    // no network request.
    if (req.method === "GET" && url.pathname === "/catalog/providers") {
      jsonResponse(res, 200, listCatalogProviders());
      return;
    }

    // GET /providers
    if (req.method === "GET" && url.pathname === "/providers") {
      try {
        jsonResponse(res, 200, await withReasoningCapability(await providerStore.listPublic()));
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
    //
    // Optional ?projectId= scopes the scan to that project's own directory
    // instead of this process's default cwd — resolved the exact same way
    // `resolveConfig` in sessions.ts resolves a turn's cwd (`projectStore
    // .findById(id).path`), so the two never disagree on what a given
    // project's directory is. An unknown projectId must 404 rather than
    // silently falling back to the process cwd, which would report the
    // wrong workspace's skills while looking successful.
    if (req.method === "GET" && url.pathname === "/skills") {
      try {
        const projectId = url.searchParams.get("projectId");
        let skillsCwd = cwd;
        if (projectId !== null) {
          const projectPath = await resolveProjectPath(projectStore, projectId);
          if (projectPath === undefined) {
            jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
            return;
          }
          skillsCwd = projectPath;
        }
        const summaries = await createSkillRegistry(skillsCwd).list();
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
            // Titles live in session_meta (last-wins). Empty string when the
            // session has never been titled — the client shows a placeholder
            // rather than inventing a title the server does not know about.
            title: record.meta.title ?? "",
            ...bindingsOf(record.meta),
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

    // PATCH /sessions/:id — rename. Titles are session_meta (last-wins), so a
    // rename is an appended meta event, not an in-place edit of the log.
    if (req.method === "PATCH" && url.pathname.startsWith("/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
      try {
        const record = await chatStore.readSession(id);
        if (!record) {
          jsonResponse(res, 404, { error: `Unknown session: ${id}` });
          return;
        }
        const body = JSON.parse(await readBody(req)) as { title?: unknown };
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (title.length === 0 || title.length > 200) {
          jsonResponse(res, 400, { error: "title must be 1-200 characters" });
          return;
        }
        // workspacePath is only consulted to place a *new* file; this session
        // already has one (readSession above found it), so resolveWritePath
        // reuses that existing path regardless of what is passed here. This is
        // safe only because there is no concurrent delete between readSession and
        // this appendEvents call — if a delete occurred between them, resolveWritePath
        // would write to a fresh top-level file for a session that was just removed.
        await chatStore.appendEvents(null, id, [
          {
            time: Date.now(),
            type: "session_meta",
            data: { ...record.meta, title },
          },
        ]);
        res.writeHead(204, corsHeaders);
        res.end();
      } catch (err: unknown) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // DELETE /sessions/:id — drop the durable transcript. Without this the web
    // app cannot really delete a session: with client state held in memory
    // only, a locally-removed session reappears on the next list fetch.
    if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
      try {
        const record = await chatStore.readSession(id);
        if (!record) {
          jsonResponse(res, 404, { error: `Unknown session: ${id}` });
          return;
        }
        await chatStore.deleteSession(id);
        res.writeHead(204, corsHeaders);
        res.end();
      } catch (err: unknown) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
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
        // The usage meter is best-effort: a snapshot-read failure hides the ring
        // client-side rather than failing the whole session fetch.
        const contextUsage = await readContextUsageSnapshot(chatStore, id).catch(() => null);
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
