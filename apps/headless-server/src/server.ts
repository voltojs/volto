/**
 * Headless server — HTTP + SSE + WebSocket gateway for volto.
 *
 * Protocol routes (consumed by apps/web via `@volto/sdk/sse`):
 *   GET  /events?sessionId=   — long-lived SSE channel for one chat session
 *   POST /messages            — { sessionId, message } triggers a turn on that channel
 *   POST /messages/queue      — { sessionId, id, action } edits/withdraws a queued message
 *   POST /approvals           — { sessionId, callId, decision, answer? } settles one approval
 *
 * Input-command & workspace routes (consumed by apps/web input bar / panes):
 *   GET  /commands            — slash command templates for the `/` panel
 *   GET  /skills?projectId=   — user-invocable skills for the `/` panel
 *   GET  /tools?projectId=    — tool catalogue for the sub-agent form
 *   GET|POST /agents, PUT|DELETE /agents/:id — sub-agent definition CRUD
 *   GET|PUT /config/routing-tiers — model routing tier table; PUT replaces
 *                               it and 409s on deleting a referenced tier id
 *   GET  /fs/tree|search|file, POST /fs/pick-directory|reveal — @ file mention data
 *   GET  /git/summary|branches|graph, POST /git/checkout|branches,
 *   GET  /git/commits/:hash   — workspace git pane data
   *   GET  /sessions            — list sessions; /sessions/:id (+ /trajectory,
   *                               /events, /plan) read, PATCH rename, DELETE
   *                               remove, POST /sessions/:id/compact
   *                               on-demand compaction
 *   GET|POST /projects, DELETE /projects/:id — project registry
 *   GET|POST /providers, PUT|DELETE /providers/:id — model provider config
 *   GET  /catalog/providers   — provider catalog for the add-provider flow
 *
 * Legacy routes (no in-repo consumer; kept for out-of-tree clients):
 *   POST /run                 — one-shot run, returns final state
 *   POST /resume              — HITL resume with decision
 *   GET  /stream?message=     — one-shot SSE of raw internal events
 *   GET  /ws                  — WebSocket streaming of raw internal events
 */

import * as http from "node:http";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { projectMessageEntries, foldStandingTodos, pendingSteeringEntries } from "@volto/core";
import type { ContentBlock, ModelInputLimits, ModelInputValue } from "@volto/core";
import {
  readConversation,
  readTrajectory,
  CompactionBusyError,
} from "@volto/sdk";
import {
  createStore as createJsonlStore,
  encodeWorkspaceName,
  TranscriptFormatError,
  asTranscriptReader,
  type ChatSessionMeta,
  type JsonlSessionStore,
} from "@volto/store-jsonl";
import { t } from "@volto/i18n";
import { createWiredAgent, createAttachmentParsePdf, type WiringOptions } from "./wiring.js";
import { builtInCommands } from "./commands.js";
import { createSkillRegistry, listSkillDefinitions } from "./skills/registry.js";
import { readContextUsageSnapshot } from "./context-usage.js";
import { createSseEventSink, createWsEventSink } from "./event-sinks.js";
import {
  createFileRefsService,
  UnknownProjectError,
  UnknownSessionError,
} from "./file-refs.js";
import {
  createSessionRegistry,
  STEER_AGENT_WAIT_MS,
  type ApprovalDecisionOutcome,
  type QueuedMessageAction,
} from "./sessions.js";
import { forkSession, ForkError } from "./session-fork.js";
import { renderSessionJsonl, renderSessionMarkdown } from "@volto/core";
import {
  createProjectStore,
  InvalidPathError,
  resolveProjectPath,
  unknownProjectMessage,
} from "./config/projects.js";
import { createProviderStore, type PublicProvider } from "./config/providers.js";
import { createPiAiModelPort, listCatalogProviders, type PiAiProviderConfig } from "@volto/provider-pi-ai";
import { getConfigDir } from "./config/paths.js";
import { ensureConfigMigrated } from "./config/store.js";
import { activeLocale, patchPreferences, readPreferences } from "./config/preferences.js";
import { createPlanStore } from "./config/plan-store.js";
import {
  collectTierReferences,
  createRoutingTierStore,
  RoutingTierValidationError,
  validateTierRecords,
  type TierReferenceScan,
} from "./config/routing-tiers.js";
import { isUiPermissionMode, buildPermissionConfig, sandboxModeFor } from "./permission-modes.js";
import {
  createDirectoryPicker,
  PickerBusyError,
  PickerUnsupportedError,
} from "./fs/directory-picker.js";
import {
  createPathRevealer,
  RevealInvalidPathError,
  RevealUnsupportedError,
} from "./fs/path-revealer.js";
import { CommandTimeoutError } from "./fs/command-runner.js";
import {
  listDirectory,
  searchFiles,
  readFilePayload,
  fsErrorStatus,
} from "./fs/files.js";
import {
  getRepository,
  listBranches,
  checkoutBranch,
  createAndCheckoutBranch,
  getGraph,
  getCommitDetail,
  gitErrorStatus,
} from "./git/git.js";
import { createBrowserAuth } from "./auth/browser-auth.js";
import { createAuthGuard, isAuthorized } from "./auth/middleware.js";
import { createAttachmentRoutes } from "./attachments/routes.js";
import { createAttachmentStoreCache } from "./attachments/store.js";
import { cleanupOrphanAttachments } from "./attachments/cleanup.js";
import {
  convertAttachments,
  type AttachmentParsePdf,
  type FoundAttachment,
} from "./attachments/convert.js";
import {
  AgentsHttpError,
  createAgentDefinition,
  deleteAgentDefinition,
  listAgents,
  updateAgentDefinition,
  type AgentsContext,
} from "./agents/routes.js";

export interface ServerOptions extends Omit<WiringOptions, "chatStore"> {
  port?: number;
  /**
   * Allowed browser origin, reflected as `Access-Control-Allow-Origin` and
   * enforced against every request's `Origin` header. Defaults to the
   * `apps/web` dev server's own origin — a browser is the threat surface a
   * local gateway needs to worry about (it can enumerate providers, drive
   * the agent at the `full` permission preset, and read the response
   * cross-origin if this were `"*"`). Non-browser clients (curl, any
   * out-of-tree host) send no `Origin` header at all and are never
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
  /** Overridable path revealer — production opens Finder/Explorer. */
  pathRevealer?: ReturnType<typeof createPathRevealer>;
  /** Overridable chat transcript store — production writes to ~/.volto/sessions. */
  chatStore?: JsonlSessionStore;
  /**
   * Overridable agent constructor for the legacy shared (no-sessionId) agent
   * below — production uses createWiredAgent. Mirrors the same seam
   * sessions.ts exposes for per-session agents, so tests can observe how
   * this construction site was invoked.
   */
  agentFactory?: typeof createWiredAgent;
}

/** Session id used when a client does not supply one. */
const DEFAULT_SESSION_ID = "default";

/** The web app's own dev origin — see `ServerOptions.corsOrigin`. */
const DEFAULT_CORS_ORIGIN = "http://localhost:6100";

/** Hard cap on request bodies. Any larger POST is refused with 413. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Hosts the gateway is allowed to bind. Anything else is refused at startup. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Raised when a request body exceeds MAX_BODY_BYTES. Call sites map this to
 * 413; other body errors stay 400.
 */
export class BodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds the ${MAX_BODY_BYTES} byte limit`);
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

/**
 * Project `ResolvedModelInfo.input` onto the wire, preserving its
 * three-state: absent = UNKNOWN and must stay absent on the wire so the
 * composer can tell "text-only" from "the gateway never said".
 */
function inputKey(input: ModelInputValue | undefined): { input?: ModelInputValue } {
  return input === undefined ? {} : { input };
}

/** Same three-state projection for the read-only directory facts. */
function inputLimitsKey(limits: ModelInputLimits | undefined): { inputLimits?: ModelInputLimits } {
  return limits === undefined ? {} : { inputLimits: limits };
}

/**
 * Inline each configured model's resolved capabilities — reasoning effort
 * levels and image input — into a `GET /providers` response.
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
          ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
          modelCodes: provider.models.map((m) => m.code),
          // Stored per-model overrides feed the ModelPort so describeModel
          // (and later turns) see the user's declared intent, not just pi-ai.
          reasoningOverrides: Object.fromEntries(
            provider.models.flatMap((m) =>
              m.reasoning === undefined ? [] : [[m.code, m.reasoning] as const],
            ),
          ),
          inputOverrides: Object.fromEntries(
            provider.models.flatMap((m) =>
              m.input === undefined ? [] : [[m.code, m.input] as const],
            ),
          ),
        };
        // Building the ModelPort can itself throw (e.g. an unknown
        // piProvider — collection.ts's buildCatalogProvider). Isolate that
        // per-provider so one stale/misconfigured provider can't 500 the
        // whole /providers response for every other healthy provider; fall
        // back to reporting this provider's models with no capability info.
        let port;
        try {
          port = createPiAiModelPort({ providers: [config], defaultProviderId: provider.id });
        } catch {
          return provider;
        }
        // ModelPort is built once per provider (above), not once per model:
        // describeModel below is a pure lookup against the already-built
        // `models` collection, no need to rebuild the port per code.
        const models = await Promise.all(
          provider.models.map(async (model) => {
            // Per-model isolation: an unknown model code (describeModelInfo
            // in collection.ts) throws; degrade to the stored record with no
            // `reasoning` key rather than failing the whole provider.
            try {
              const info = await port.describeModel!(model.code);
              // Only `reasoning` is inlined. The two token caps are
              // deliberately NOT merged in from the catalog: this response is
              // what the settings form edits, and a catalog value shown in an
              // override box would be saved back as an explicit override,
              // silently freezing a number that should keep tracking pi-ai.
              // Consumers that want the effective value merge it themselves
              // from GET /catalog/providers (see web's providerModels).
              //
              // The stored boolean override is stripped here and replaced by
              // the resolved capability object — never both on the wire.
              // Same single-source rule for `input`: the wire key must
              // originate only from inputKey(info.input), never the stored
              // record riding along in `rest`.
              const { reasoning: _storedFlag, input: _storedInput, ...rest } = model;
              return {
                ...rest,
                ...(info.reasoning ? { reasoning: info.reasoning } : {}),
                ...inputKey(info.input),
                ...inputLimitsKey(info.inputLimits),
              };
            } catch {
              // describeModel failed, so `info` never existed: keep the
              // stored `input` here — a declaration is never lost on the
              // fallback (it is the only source left).
              const { reasoning: _storedFlag, ...rest } = model;
              return rest;
            }
          }),
        );
        return { ...provider, models };
      }

      // A custom provider with no configured baseURL yet (`null` is a
      // legitimate "not configured" state — see providers.ts's `create()`
      // writing `input.baseURL ?? null`) has nothing to build a ModelPort
      // against. Coercing null to "" would let normalizeBaseUrl (collection.ts)
      // turn it into the nonsense URL "/v1"; skip capability resolution for
      // this provider entirely instead, same as the "can't build a ModelPort"
      // case below.
      if (provider.baseURL === null) {
        return {
          ...provider,
          models: provider.models.map((m) => {
            const { reasoning: _reasoningFlag, ...rest } = m;
            return rest;
          }),
        };
      }

      const config: PiAiProviderConfig = {
        kind: "custom",
        id: provider.id,
        baseURL: provider.baseURL,
        models: provider.models.map((m) => ({
          code: m.code,
          name: m.name,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          reasoning: m.reasoning,
          // Forward the stored declaration (mirrors sessions.buildProviderConfig
          // custom branch) so `info` and `rest` below derive input from one
          // source instead of the wire key surviving only via `...rest`.
          ...(m.input === undefined ? {} : { input: m.input }),
        })),
      };
      let port;
      try {
        port = createPiAiModelPort({ providers: [config], defaultProviderId: provider.id });
      } catch {
        return {
          ...provider,
          models: provider.models.map((m) => {
            const { reasoning: _reasoningFlag, ...rest } = m;
            return rest;
          }),
        };
      }
      const models = await Promise.all(
        provider.models.map(async (m) => {
          // The stored boolean `reasoning` config flag is replaced by the
          // resolved capability object on the wire — never both.
          const { reasoning: _reasoningFlag, ...rest } = m;
          try {
            const info = await port.describeModel!(m.code);
            // Single source for `input` too: on this path `info` reliably
            // carries the stored declaration (buildModel registers it in
            // inputDeclarations), so the wire key comes only from
            // inputKey(info.input), not from `rest` as well.
            const { input: _storedInput, ...withoutInput } = rest;
            return {
              ...withoutInput,
              ...(info.reasoning ? { reasoning: info.reasoning } : {}),
              ...inputKey(info.input),
              ...inputLimitsKey(info.inputLimits),
            };
          } catch {
            // describeModel failed: keep the stored `input` on the fallback
            // so a declaration is never lost (it is the only source left).
            return rest;
          }
        }),
      );
      return { ...provider, models };
    }),
  );
}

/**
 * The http.Server returned by createServer, plus the per-process auth
 * material tests and the startup log need.
 */
export interface HeadlessServer extends http.Server {
  /** Per-process launch token. Not persisted; dies with the process. */
  readonly launchToken: string;
  /** Root URL carrying the launch token as its only auth input. */
  readonly authenticatedUrl: string;
}

export async function createServer(opts: ServerOptions = {}): Promise<HeadlessServer> {
  // One-shot migration of the per-domain config files into config.json.
  // A failure here must not stop the gateway: reads still fall back to the
  // legacy files, and the next write retries the migration.
  try {
    await ensureConfigMigrated(getConfigDir());
  } catch (err) {
    console.warn(
      "config migration skipped:",
      err instanceof Error ? err.message : err,
    );
  }

  const port = opts.port ?? 3100;
  const host = opts.host ?? "127.0.0.1";

  // The client may name any absolute path as a project root and the agent
  // runs arbitrary commands, so a non-loopback bind would expose this
  // machine to the network. Refuse at startup rather than warn.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to bind to non-loopback host "${host}": the gateway exposes this machine's filesystem and an arbitrary-command agent. Bind to 127.0.0.1, localhost, or ::1.`,
    );
  }

  const auth = await createBrowserAuth();
  const guard = createAuthGuard(auth, { publicPaths: ["/health"] });

  const corsOrigin = opts.corsOrigin ?? process.env["VOLTO_CORS_ORIGIN"] ?? DEFAULT_CORS_ORIGIN;
  // The legacy shared agent (used by /resume, /stream, /ws when no sessionId is
  // given) has no per-session scoping, so it never gets the durable transcript
  // store — `opts.chatStore` here is the unscoped, whole-workspace store type
  // (JsonlSessionStore), not the already-scoped TranscriptStore createWiredAgent
  // expects. Only `registry` (below) wires chatStore in, per-session, via
  // scopeToWorkspace() inside sessions.ts's rebuild().
  const { chatStore: _rawChatStore, agentFactory, pluginAgents = [], ...agentOpts } = opts;
  const buildAgent = agentFactory ?? createWiredAgent;
  // This construction site has no sessionId, so it can never reach a
  // permissionMode default resolved per-session (sessions.ts's EMPTY_CONFIG)
  // and no route through it (/run without sessionId, /stream, /resume) has
  // any way to present an approval to a human or accept a decision back.
  // Falling back to createAgent's own defaults here would silently resolve
  // to workspace-write + auto-allow-gate — the widest tier, by omission.
  // Default to the "read-only" preset instead: same reasoning as
  // EMPTY_CONFIG in sessions.ts. Its approval policy is "never", so the
  // approval gate is never consulted and can safely stay absent.
  const agent = await buildAgent({
    ...agentOpts,
    // Destructured out of agentOpts above (the /agents routes read it from
    // the same binding); pass it back so this agent's scan lists the same
    // plugin entries the UI shows.
    pluginAgents,
    permissionConfig: agentOpts.permissionConfig ?? buildPermissionConfig("read-only"),
    sandboxMode: agentOpts.sandboxMode ?? sandboxModeFor("read-only"),
  });
  // Same fallback as createWiredAgent's own `cwd` resolution (wiring.ts) — kept
  // in sync here so /skills reports the same workspace the legacy (no
  // sessionId) agent above actually loads. This is only /skills' default: a
  // caller that supplies ?projectId= gets that project's own cwd instead (see
  // the /skills route below), resolved through projectStore exactly like
  // sessions.ts's resolveConfig() resolves a turn's cwd.
  const cwd = agentOpts.cwd ?? process.cwd();
  const projectStore = createProjectStore();
  const providerStore = createProviderStore();
  const directoryPicker =
    opts.directoryPicker ?? createDirectoryPicker({ locale: await activeLocale() });
  const pathRevealer = opts.pathRevealer ?? createPathRevealer();
  const chatStore = opts.chatStore ?? createJsonlStore({ directory: path.join(getConfigDir(), "sessions") });
  // Attachment root lives under the config dir (~/.volto/attachments by
  // default) — outside the workspace so the agent cannot read its own store
  // back through read_file / glob / bash. One cache serves the /attachments
  // routes, POST /messages' pre-ack id validation, AND the agent itself:
  // the Runner resolves image refs against the same store, so an id that
  // validated here is one it can actually read back.
  const attachmentRoot = path.join(getConfigDir(), "attachments");
  const attachmentStoreFor = createAttachmentStoreCache(attachmentRoot);
  const attachmentRoutes = createAttachmentRoutes({ storeFor: attachmentStoreFor });
  // parsePdf for the attachment converter, constructed LAZILY (memoized on
  // first use) and only awaited when a message actually carries a non-image
  // attachment. The factory resolves to undefined when the document parser
  // or its optional pdf-parse dependency is unavailable — PDF attachments
  // then degrade to explanatory blocks instead of failing the request.
  let attachmentParsePdfCache: Promise<AttachmentParsePdf | undefined> | undefined;
  function attachmentParsePdf(): Promise<AttachmentParsePdf | undefined> {
    attachmentParsePdfCache ??= createAttachmentParsePdf();
    return attachmentParsePdfCache;
  }
  // The plan-mode artifact store the /sessions/:id/plan routes read and
  // reclaim on. Rooted at the config dir via createPlanStore's own default —
  // the very root wiring.ts hands every agent instance, so a plan the
  // save_plan tool wrote is the plan these routes serve.
  const planStore = createPlanStore();
  // Settle-time file reference annotations (GET /file-refs): session memory,
  // recomputed from the durable log whenever it grows — nothing persisted.
  const fileRefs = createFileRefsService({
    projectRootFor: (projectId) => resolveProjectPath(projectStore, projectId),
    sessionFor: async (sessionId) => {
      const record = await chatStore.readSession(sessionId);
      if (!record) return undefined;
      const view = await readConversation(asTranscriptReader(chatStore), sessionId);
      return { events: record.events, messages: view.messages, projectId: record.meta.projectId ?? null };
    },
  });
  const registry = createSessionRegistry({
    ...opts,
    projectStore,
    providerStore,
    chatStore,
    attachmentStoreFor,
  });

  /**
   * Only a browser attaches an `Origin` header; a non-browser client (curl,
   * any out-of-tree host) sends none and is never subject to this check —
   * there is nothing for CORS to protect there.
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
      // Auth is cookie-based, so a cross-origin caller must be told its
      // credentials may ride along — without this the browser discards the
      // response even on a 200. Omitted under "*": the pair is illegal and
      // makes the browser reject every response.
      ...(corsOrigin === "*" ? {} : { "Access-Control-Allow-Credentials": "true" }),
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

  // The whole route handler runs through a single async function so the
  // createServer callback below can install a top-level guard. Any exception
  // a route lets escape (e.g. decodeURIComponent throwing URIError on a
  // malformed percent-encoded path segment) would otherwise surface as an
  // unhandled rejection and crash the process.
  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
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

    // CORS preflight — answered before the auth guard so a browser can
    // discover the allowed headers without already holding credentials.
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Auth guard. AFTER preflight, BEFORE any route matching: an
    // unauthenticated caller must get 401 — never a route-dependent 404
    // that would leak which paths exist. Covers /events (SSE) as well;
    // the WebSocket upgrade path is wired separately below.
    if (!guard(req, res, corsHeaders)) {
      return;
    }

    /** Map a BodyTooLargeError to 413. Returns true when handled. */
    function respondBodyError(err: unknown): boolean {
      if (err instanceof BodyTooLargeError) {
        jsonResponse(res, 413, { error: "Request body too large" });
        // Destroy only after the 413 has been flushed to the socket —
        // tearing the connection down first makes the client see a socket
        // error instead of the status code.
        res.once("finish", () => req.destroy());
        return true;
      }
      return false;
    }

    // GET /events — protocol SSE channel bound to a chat session
    if (req.method === "GET" && url.pathname === "/events") {
      const sessionId = url.searchParams.get("sessionId") ?? DEFAULT_SESSION_ID;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        // `no-transform` is the one that matters in front of Next.js: its
        // rewrite proxy gzips the response when the client advertises
        // Accept-Encoding, and a gzip encoder buffers input until it has a
        // block to emit. On a never-ending stream of small frames that means
        // the browser receives the gzip header and then nothing — EventSource
        // fires `open` and no data ever arrives. curl does not send
        // Accept-Encoding by default, which is why every curl check of this
        // endpoint passed while the app was dead.
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Defeats proxy buffering, which would otherwise stall the stream.
        // nginx-specific; Next.js ignores it, hence `no-transform` above.
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
          attachments?: string[];
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

        // Resolve attachments to content blocks BEFORE the 202 ack. This
        // endpoint acks first and streams later, so a missing id discovered
        // after the ack would surface as an unexplained SSE error instead of
        // a rejected request. Every id must exist in THIS session's store —
        // the same store the /attachments routes write to.
        //
        // Kind split (spec 2026-10-15 non-image attachments §4.4): image/*
        // keeps the ref-block path below untouched — bytes stay in the store
        // and the Runner resolves them later. Every other attachment is
        // converted INLINE into a text block by convertAttachments. Blocks
        // land in the message in the order the caller listed the ids,
        // image and inline blocks interleaved.
        const imageBlocks: Array<{
          type: "image";
          source: { type: "ref"; id: string; mediaType: string };
          width?: number;
          height?: number;
        }> = [];
        /** One slot per attachment id, in caller order; inline slots are filled after conversion. */
        const orderedBlocks: Array<ContentBlock | undefined> = [];
        const inlineEntries: FoundAttachment[] = [];
        const inlineSlots: number[] = [];
        if (body.attachments !== undefined) {
          if (!Array.isArray(body.attachments) || body.attachments.some((a) => typeof a !== "string")) {
            jsonResponse(res, 400, { error: "attachments must be an array of attachment ids" });
            return;
          }
          if (body.attachments.length > 0) {
            const store = attachmentStoreFor(sessionId);
            for (const id of body.attachments) {
              const found = await store.get(id);
              if (!found) {
                jsonResponse(res, 400, { error: `Unknown attachment id: ${id}` });
                return;
              }
              if (!found.mimeType.startsWith("image/")) {
                inlineSlots.push(orderedBlocks.length);
                inlineEntries.push(found);
                orderedBlocks.push(undefined);
                continue;
              }
              // Ref-only: the bytes stay in the store, the Runner resolves
              // them later. Dimensions come from the store's ingest-time
              // metadata — absent only when the bytes were not recognized
              // as an image, never invented.
              imageBlocks.push({
                type: "image",
                source: { type: "ref", id, mediaType: found.mimeType },
                ...(found.width === undefined ? {} : { width: found.width }),
                ...(found.height === undefined ? {} : { height: found.height }),
              });
              orderedBlocks.push(imageBlocks[imageBlocks.length - 1]!);
            }
          }
        }

        // Inline conversion happens BEFORE the 202 ack for the same reason
        // the id resolution does: it must never surface as a mid-stream
        // error. convertAttachments itself never throws — a failed
        // attachment degrades to its own explanatory block (spec §6).
        if (inlineEntries.length > 0) {
          const parsePdf = await attachmentParsePdf();
          const inlineBlocks = await convertAttachments(inlineEntries, { parsePdf });
          for (const [index, slot] of inlineSlots.entries()) {
            orderedBlocks[slot] = inlineBlocks[index];
          }
        }
        const attachmentBlocks = orderedBlocks.filter(
          (block): block is ContentBlock => block !== undefined,
        );

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

        // Server-side backstop for the composer's input-modality gate: a model that
        // declares no image input must refuse the images here, before the
        // ack, rather than let them travel to a provider that cannot read
        // them. UI gating alone is not a boundary. Same reasoning-effort
        // shape above: only an explicit text-only input refuses; UNKNOWN
        // goes through (spec §7).
        if (imageBlocks.length > 0) {
          try {
            await registry.assertImageInput(turnConfig);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            jsonResponse(res, 400, { error: message });
            return;
          }
        }

        // No attachment blocks → keep the plain string. Wrapping every
        // message in a one-element block array would needlessly shift
        // snapshot and projection shapes for the common case.
        const turnInput =
          attachmentBlocks.length > 0
            ? {
                type: "user_message" as const,
                content: [{ type: "text" as const, text: body.message }, ...attachmentBlocks],
              }
            : body.message;

        // D10 — a message landing while this session's turn latch is held is
        // STEERED into the owning turn and acked as queued: never a mid-turn
        // rejection, never a second concurrent run. The latch read, the agent
        // reference and the steer() delivery form one synchronous span — no
        // await may sit between them, so a rebuild in flight in another
        // task's await span cannot slip a stale instance in between (spec
        // D10's single-threaded atomicity rule). Attachment blocks were
        // already resolved above, so `turnInput` is final here.
        const session = registry.get(sessionId);
        const steerDeadline = Date.now() + STEER_AGENT_WAIT_MS;
        for (;;) {
          if (session.running && session.agent) {
            session.agent.steer(turnInput);
            jsonResponse(res, 202, { queued: true });
            return;
          }
          if (!session.running) break; // idle — start a normal turn below
          // Cold window: the first turn owns the latch but its agent has not
          // been built yet. Wait, bounded, for the delivery target to exist —
          // a 202 here would ack a message the gateway could not deliver.
          if (Date.now() >= steerDeadline) {
            jsonResponse(res, 503, {
              error: t(
                await activeLocale(getConfigDir(), req.headers["accept-language"]),
                "server.error.agentStarting",
              ),
            });
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }

        // Ack immediately; the turn streams over SSE. runTurn never rejects —
        // failures are delivered to the client as protocol `error` events.
        // The idle check above and this claim share one synchronous span, so
        // a concurrent POST cannot slip between them; runTurn re-checks the
        // latch itself before claiming it.
        jsonResponse(res, 202, { sessionId, accepted: true });
        void registry.runTurn(sessionId, turnInput, turnConfig);
      } catch (err: unknown) {
        if (respondBodyError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        jsonResponse(res, 400, { error: message });
      }
      return;
    }

    // POST /messages/queue — edit or withdraw a QUEUED (not yet delivered)
    // message by id (spec D14/D15). Same wrapping as POST /approvals: the
    // global auth guard above already covers the route, and every body-shape
    // check runs BEFORE the queue is touched — a malformed body must never
    // mutate state. `id` is the queue item's id stamped by `steering_queued`.
    if (req.method === "POST" && url.pathname === "/messages/queue") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          sessionId?: string;
          id?: string;
          action?: { kind?: string; content?: unknown };
        };
        const sessionId = body.sessionId ?? DEFAULT_SESSION_ID;

        if (!body.id) {
          jsonResponse(res, 400, { error: "id is required" });
          return;
        }
        const rawAction = body.action;
        if (!rawAction || (rawAction.kind !== "edit" && rawAction.kind !== "remove")) {
          jsonResponse(res, 400, { error: `Unsupported action: ${String(rawAction?.kind)}` });
          return;
        }

        let action: QueuedMessageAction;
        if (rawAction.kind === "edit") {
          const content = rawAction.content;
          if (typeof content !== "string") {
            jsonResponse(res, 400, { error: "content must be a string" });
            return;
          }
          // D14: plain text only, never blank — a whitespace-only edit would
          // wipe the message, so it is refused before anything is touched.
          if (content.trim() === "") {
            jsonResponse(res, 400, {
              error: t(
                await activeLocale(getConfigDir(), req.headers["accept-language"]),
                "server.queue.emptyContent",
              ),
            });
            return;
          }
          action = { kind: "edit", content };
        } else {
          action = { kind: "remove" };
        }

        // "live"/"seed" mutated the queue (their persistence split — the
        // Runner's recorder vs. this gateway's own append — lives in
        // updateQueuedMessage); "missing" means unknown or already
        // delivered, where delivery wins and state was left untouched;
        // "persist-failed" means storage refused the seed append BEFORE
        // anything mutated (persist-first order), so a retry is safe.
        const outcome = await registry.updateQueuedMessage(sessionId, body.id, action);
        if (outcome === "persist-failed") {
          // Honest 500 with the decided copy — never the catch-all's 400
          // with a raw store message: nothing was modified, so the client
          // may simply retry once storage recovers.
          jsonResponse(res, 500, {
            error: t(
              await activeLocale(getConfigDir(), req.headers["accept-language"]),
              "server.queue.persistFailed",
            ),
          });
          return;
        }
        if (outcome === "missing") {
          // 409 rather than a silent 200: the id is gone — the client's
          // queued bubble is stale and can be surfaced instead of pretending
          // the edit landed. `code` is the machine-readable half.
          jsonResponse(res, 409, {
            error: t(
              await activeLocale(getConfigDir(), req.headers["accept-language"]),
              "server.queue.gone",
            ),
            code: "QUEUE_ITEM_GONE",
          });
          return;
        }
        jsonResponse(res, 200, { ok: true });
      } catch (err: unknown) {
        if (respondBodyError(err)) return;
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
        if (respondBodyError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        jsonResponse(res, 400, { error: message });
      }
      return;
    }

    // POST /approvals — settle one pending human approval on a session.
    //
    // Two independent gates protect this route — do not delete either:
    //
    // 1. The global auth guard (createAuthGuard, above) rejects any request
    //    without a valid cookie/bearer/query token. It keeps external
    //    processes (another user's curl, a malicious local script) from
    //    reaching this endpoint at all.
    //
    // 2. The per-connection approval token (body.token, checked by
    //    registry.decideApproval below) is bound to the SSE connection the
    //    approval card was shown on. It keeps a *different tab of the same
    //    user* — or any client that shares the origin cookie — from
    //    settling an approval that was never presented to it.
    //
    // Both are required. Deleting either one reopens a distinct hole.
    if (req.method === "POST" && url.pathname === "/approvals") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          sessionId?: string;
          callId?: string;
          decision?: string;
          token?: string;
          answer?: unknown;
          remember?: unknown;
        };
        const sessionId = body.sessionId ?? DEFAULT_SESSION_ID;

        if (!body.callId) {
          jsonResponse(res, 400, { error: "callId is required" });
          return;
        }
        if (
          body.decision !== "allow" &&
          body.decision !== "deny"
        ) {
          jsonResponse(res, 400, {
            error: `Unsupported decision: ${String(body.decision)}`,
          });
          return;
        }

        // The user's answer to an ask_user prompt rides on the decision.
        // Body-shape validation, like the checks above, runs BEFORE the token
        // check — and before anything settles: a malformed body must never be
        // mistaken for a settled approval. Absent means "no answer", which is
        // every non-ask_user decision's legitimate shape.
        if (
          body.answer !== undefined &&
          !(Array.isArray(body.answer) && body.answer.every((a) => typeof a === "string"))
        ) {
          jsonResponse(res, 400, { error: "answer must be an array of strings" });
          return;
        }

        // Validate the `remember` field BEFORE the token check — a malformed
        // body must never settle anything. `{prefixTokens: number}` is the
        // only accepted shape; unknown keys are rejected to prevent rule
        // smuggling. Only a COUNT crosses the wire: a client that could send
        // a rule object could grant itself permissions.
        let rememberCount: number | undefined;
        if (body.remember !== undefined) {
          if (body.decision !== "allow") {
            jsonResponse(res, 400, { error: "remember is only valid with decision: allow" });
            return;
          }
          if (typeof body.remember !== "object" || body.remember === null || Array.isArray(body.remember)) {
            jsonResponse(res, 400, { error: "remember must be an object" });
            return;
          }
          const remObj = body.remember as Record<string, unknown>;
          const remKeys = Object.keys(remObj);
          const allowedKeys = ["prefixTokens"];
          const unknownRem = remKeys.filter((k) => !allowedKeys.includes(k));
          if (unknownRem.length > 0) {
            jsonResponse(res, 400, { error: `remember has unknown key(s): ${unknownRem.join(", ")} — expected prefixTokens` });
            return;
          }
          if (!("prefixTokens" in remObj)) {
            jsonResponse(res, 400, { error: "remember.prefixTokens is required" });
            return;
          }
          const pt = remObj["prefixTokens"];
          if (typeof pt !== "number" || !Number.isInteger(pt) || pt < 1) {
            jsonResponse(res, 400, { error: "remember.prefixTokens must be a positive integer" });
            return;
          }
          rememberCount = pt;
        }

        // Bound to the SSE connection the approval was shown on — see
        // sessions.ts's decideApproval for the full threat model. A missing
        // or wrong token answers 403 with the exact same message an unknown
        // callId gets below, and is checked first, so a caller without the
        // connection token can never learn whether a given callId is
        // actually pending.
        const result: ApprovalDecisionOutcome = await registry.decideApproval(
          sessionId,
          body.callId,
          body.decision,
          body.token,
          body.answer as string[] | undefined,
          rememberCount,
        );
        if (result.status === "forbidden") {
          jsonResponse(res, 403, {
            error: `No pending approval ${body.callId} for session ${sessionId}`,
          });
          return;
        }
        // 409 rather than a silent 200: an unknown callId means the client's
        // card is stale (the approval already settled, or the session went
        // away), which it can surface instead of pretending it landed.
        if (result.status === "unknown") {
          jsonResponse(res, 409, {
            error: `No pending approval ${body.callId} for session ${sessionId}`,
          });
          return;
        }

        // Build the receipt. A save error or semantic error is reported as
        // `rememberError` — the approval itself succeeded (202).  The brief
        // uses status: "ok" in the body; 202 already conveys the HTTP status.
        jsonResponse(res, 202, {
          status: "ok",
          ...(result.remembered !== undefined ? { remembered: result.remembered } : {}),
          ...(result.rememberError !== undefined ? { rememberError: result.rememberError } : {}),
        });
      } catch (err: unknown) {
        if (respondBodyError(err)) return;
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
        if (respondBodyError(err)) return;
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
        if (respondBodyError(err)) return;
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
        if (respondBodyError(err)) return;
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

    // GET /preferences — defaults the next conversation starts with.
    if (req.method === "GET" && url.pathname === "/preferences") {
      try {
        jsonResponse(res, 200, await readPreferences());
      } catch (err: unknown) {
        // A preference is never worth failing a page load over: unreadable
        // file → empty defaults, same as a first run.
        jsonResponse(res, 200, {});
        void err;
      }
      return;
    }

    // PUT /preferences — merge the given keys into the stored defaults.
    if (req.method === "PUT" && url.pathname === "/preferences") {
      try {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const key of [
          "locale",
          "theme",
          "streamDensity",
          "defaultPermissionMode",
          "lastProviderId",
          "lastModelId",
          "lastReasoningEffort",
          "titleProviderId",
          "titleModelId",
        ]) {
          if (typeof body?.[key] === "string") patch[key] = body[key];
        }
        jsonResponse(res, 200, await patchPreferences(patch));
      } catch (err: unknown) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
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
        const created = await providerStore.create(body as Parameters<typeof providerStore.create>[0]);
        // Same shape as GET /providers: clients merge this response straight
        // into their provider list, so it must carry the inlined `models`
        // (a catalog PublicProvider only has `modelCodes` on its own).
        jsonResponse(res, 201, (await withReasoningCapability([created]))[0]);
      } catch (err: unknown) {
        if (respondBodyError(err)) return;
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
        // Shape-identical to GET /providers — see POST above.
        jsonResponse(
          res,
          updated ? 200 : 404,
          updated ? (await withReasoningCapability([updated]))[0] : { error: "Not found" },
        );
      } catch (err: unknown) {
        if (respondBodyError(err)) return;
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

    // GET /commands — the web command menu's "系统内置" data source. Reads the
    // same array wiring.ts hands to createAgent({ commands }), so the menu can
    // never drift from what resolveInput actually expands.
    if (req.method === "GET" && url.pathname === "/commands") {
      jsonResponse(res, 200, {
        commands: builtInCommands(
          await activeLocale(getConfigDir(), req.headers["accept-language"]),
        ).map((c) => ({
          name: c.name,
          description: c.description ?? "",
          args: c.args,
        })),
      });
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
        // includeDefinitions=1 is the settings catalog: every on-disk
        // definition (shadowed losers included) with its scope and source
        // path. Without it the response shape stays exactly what the `/`
        // command panel has always consumed.
        if (url.searchParams.get("includeDefinitions") === "1") {
          const definitions = await listSkillDefinitions(skillsCwd);
          jsonResponse(res, 200, {
            skills: definitions.map((d) => ({
              id: d.id,
              name: d.name,
              description: d.description,
              scope: d.scope,
              filePath: d.filePath,
              baseDir: d.baseDir,
              modelInvocable: d.invocation.modelInvocable,
              userInvocable: d.invocation.userInvocable,
              shadowed: d.shadowed,
            })),
          });
          return;
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

    // GET /tools — the catalogue the sub-agent form offers as checkboxes.
    // Lists `agent.tools`: the same assembled list createAgent hands session
    // assembly (and therefore every turn), so what the form offers cannot
    // drift from what a sub-agent actually receives. Optional ?projectId=
    // validates the project exists (resolved like /skills); tool names and
    // descriptions themselves do not vary by cwd — adapters and static
    // definitions are identical across projects.
    if (req.method === "GET" && url.pathname === "/tools") {
      try {
        const projectId = url.searchParams.get("projectId");
        if (projectId !== null) {
          const projectPath = await resolveProjectPath(projectStore, projectId);
          if (projectPath === undefined) {
            jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
            return;
          }
        }
        jsonResponse(res, 200, {
          tools: agent.tools.map((t) => ({
            name: t.definition.name,
            description: t.definition.description,
          })),
        });
      } catch (err: unknown) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET|POST /agents, PUT|DELETE /agents/:id — sub-agent definition CRUD.
    // Like /skills, an optional ?projectId= scopes the project-level source
    // (and the project-scope write target) to that project's directory,
    // resolved through projectStore the same way sessions resolve a turn's
    // cwd. Every verb rescans/re-reads disk: definitions are files a user may
    // edit between calls, so nothing here is cached across requests.
    if (url.pathname === "/agents" || url.pathname.startsWith("/agents/")) {
      const projectId = url.searchParams.get("projectId");
      let agentsCwd = cwd;
      if (projectId !== null) {
        const projectPath = await resolveProjectPath(projectStore, projectId);
        if (projectPath === undefined) {
          jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
          return;
        }
        agentsCwd = projectPath;
      }
      const agentsCtx: AgentsContext = {
        cwd: agentsCwd,
        configDir: getConfigDir(),
        pluginSpecs: pluginAgents,
      };

      // GET /agents — merged list across project / user / plugin sources.
      if (req.method === "GET" && url.pathname === "/agents") {
        try {
          jsonResponse(res, 200, await listAgents(agentsCtx));
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // POST /agents — create at the requested scope; 201 carries the entry.
      if (req.method === "POST" && url.pathname === "/agents") {
        try {
          const body = JSON.parse(await readBody(req)) as {
            scope?: unknown;
            spec?: unknown;
          };
          jsonResponse(res, 201, await createAgentDefinition(agentsCtx, body));
        } catch (err: unknown) {
          if (respondBodyError(err)) return;
          if (err instanceof AgentsHttpError) {
            jsonResponse(res, err.status, { error: err.message });
            return;
          }
          if (err instanceof SyntaxError) {
            jsonResponse(res, 400, { error: "Invalid JSON body" });
            return;
          }
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // PUT /agents/:id — replace the spec. Plugin-sourced ids answer 409.
      if (req.method === "PUT" && url.pathname.startsWith("/agents/")) {
        try {
          const id = decodeURIComponent(url.pathname.slice("/agents/".length));
          const body = JSON.parse(await readBody(req)) as { spec?: unknown };
          jsonResponse(res, 200, await updateAgentDefinition(agentsCtx, id, body));
        } catch (err: unknown) {
          if (respondBodyError(err)) return;
          if (err instanceof AgentsHttpError) {
            jsonResponse(res, err.status, { error: err.message });
            return;
          }
          if (err instanceof SyntaxError) {
            jsonResponse(res, 400, { error: "Invalid JSON body" });
            return;
          }
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // DELETE /agents/:id — 204 on success, 404 unknown, 409 plugin-sourced.
      if (req.method === "DELETE" && url.pathname.startsWith("/agents/")) {
        try {
          const id = decodeURIComponent(url.pathname.slice("/agents/".length));
          await deleteAgentDefinition(agentsCtx, id);
          res.writeHead(204, corsHeaders);
          res.end();
        } catch (err: unknown) {
          if (err instanceof AgentsHttpError) {
            jsonResponse(res, err.status, { error: err.message });
            return;
          }
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    }

    // GET|PUT /config/routing-tiers — the model routing tier table the
    // sub-agent dispatch resolves tier ids against. PUT is a full replace;
    // a tier id that disappears while agent definitions still reference it
    // answers 409 with those definitions. Plugin-sourced references are
    // hints only and never block. Every verb re-reads disk, like /agents.
    if (url.pathname === "/config/routing-tiers") {
      const tierStore = createRoutingTierStore();

      // GET — the current table. Before the first PUT this is the factory
      // template (unassigned targets, served unpersisted — spec v2 D7/D8);
      // `[]` means the table is explicitly empty and callers fall back to
      // plain model references.
      if (req.method === "GET") {
        try {
          jsonResponse(res, 200, {
            tiers: await tierStore.list(
              await activeLocale(getConfigDir(), req.headers["accept-language"]),
            ),
          });
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // PUT — replace the whole table: 200, 400 (validation failure naming
      // the tier), or 409 (a removed tier id is still referenced).
      if (req.method === "PUT") {
        try {
          const body: unknown = JSON.parse(await readBody(req));
          const tiers = validateTierRecords(body);
          // Target check: every ASSIGNED target must resolve in the provider
          // registry; `target: null` (unassigned) is legal and skips the
          // lookup. resolveModel is the one call that returns plaintext
          // credentials — only its null/miss answer is used here, never the
          // payload.
          for (const tier of tiers) {
            if (tier.target === null) continue;
            const resolved = await providerStore.resolveModel(
              tier.target.providerId,
              tier.target.modelId,
            );
            if (resolved === null) {
              throw new RoutingTierValidationError(
                `routing tier "${tier.id}" targets unknown model: ${JSON.stringify(tier.target)}`,
              );
            }
          }
          // Deletion reference scan — only ids that disappear can strand an
          // existing definition.
          const nextIds = new Set(tiers.map((t) => t.id));
          const removedIds = (await tierStore.list())
            .map((t) => t.id)
            .filter((id) => !nextIds.has(id));
          let scan: TierReferenceScan = { references: [], skipped: [] };
          if (removedIds.length > 0) {
            scan = await collectTierReferences(removedIds, {
              projectPaths: (await projectStore.list()).map((p) => p.path),
              configDir: getConfigDir(),
              pluginSpecs: pluginAgents,
            });
          }
          if (scan.references.some((r) => r.scope !== "plugin")) {
            jsonResponse(res, 409, {
              error: `cannot remove routing tier(s) still referenced by agent definitions: ${removedIds.join(", ")}`,
              references: scan.references,
              ...(scan.skipped.length > 0 ? { skipped: scan.skipped } : {}),
            });
            return;
          }
          await tierStore.replace(tiers);
          jsonResponse(res, 200, {
            tiers,
            ...(scan.references.length > 0 ? { references: scan.references } : {}),
            ...(scan.skipped.length > 0 ? { skipped: scan.skipped } : {}),
          });
        } catch (err: unknown) {
          if (respondBodyError(err)) return;
          if (err instanceof SyntaxError) {
            jsonResponse(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (err instanceof RoutingTierValidationError) {
            jsonResponse(res, 400, { error: err.message });
            return;
          }
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    }

    // GET /sessions — lightweight list for the web app's session recovery.
    // `?q=` switches to a title + message text search; `projectId` / `limit`
    // optionally narrow it. Empty q keeps the plain list contract.
    if (req.method === "GET" && url.pathname === "/sessions") {
      try {
        const q = url.searchParams.get("q")?.trim() ?? "";
        if (q !== "") {
          // Empty parameters mean "absent": `?projectId=` / `?limit=` must
          // not silently become a filter for "" or clamp the page to 1 row.
          const projectIdParam = url.searchParams.get("projectId")?.trim() ?? "";
          const projectId = projectIdParam !== "" ? projectIdParam : undefined;
          const limitParam = url.searchParams.get("limit")?.trim() ?? "";
          const limitRaw = limitParam !== "" ? Number(limitParam) : Number.NaN;
          // One directory scan for the whole request: the same records feed
          // both the search and the summary assembly below.
          const { records, skipped } = await chatStore.listSessions();
          const hits = await chatStore.searchSessions(q, {
            ...(projectId !== undefined ? { projectId } : {}),
            limit: Number.isFinite(limitRaw) ? limitRaw : 20,
            records,
          });
          const byId = new Map(records.map((record) => [record.sessionId, record]));
          const sessions = hits.flatMap((hit) => {
            const record = byId.get(hit.sessionId);
            if (record === undefined) return [];
            return [{
              id: record.sessionId,
              title: record.meta.title ?? "",
              ...bindingsOf(record.meta),
              messageCount: projectMessageEntries(record.events).length,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              snippet: hit.snippet,
            }];
          });
          jsonResponse(res, 200, { sessions, unreadableSessions: skipped.length });
          return;
        }
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

    // GET /sessions/:id/events — raw persisted events for one session. Serves
    // sub-agent pane hydration (spec 2026-09-12 §4.4): no projection, wire-order
    // events, same auth as every other /sessions route. Unknown ids answer
    // 200 + empty (the /trajectory contract), so a child session that never
    // wrote anything renders an empty pane instead of an error.
    if (req.method === "GET") {
      const eventsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
      if (eventsMatch) {
        const id = decodeURIComponent(eventsMatch[1]!);
        try {
          const record = await chatStore.readSession(id);
          jsonResponse(res, 200, { sessionId: id, events: record?.events ?? [] });
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

    // GET /sessions/:id/plan — the session's current plan document (plan
    // mode, spec 2026-09-19 §4). 404 = no plan: either the session has no
    // project binding (a plan is only ever written under one, via save_plan)
    // or none was saved yet. Same auth as every other /sessions route — the
    // guard above runs before any route matching.
    if (req.method === "GET") {
      const planMatch = url.pathname.match(/^\/sessions\/([^/]+)\/plan$/);
      if (planMatch) {
        const id = decodeURIComponent(planMatch[1]!);
        try {
          const projectPath = registry.getSessionProjectPath(id);
          // A session with no project binding has no reachable plan: only a
          // rebuilt session's agent (save_plan) ever writes one, and it
          // writes under the very projectPath resolved here.
          if (projectPath === null) {
            jsonResponse(res, 404, { error: "no plan" });
            return;
          }
          const content = await planStore.read(id, projectPath);
          if (content === null) {
            jsonResponse(res, 404, { error: "no plan" });
            return;
          }
          // updatedAt is the plan file's own mtime. The PlanStore port
          // returns content only, so the mtime is stat'ed from the file this
          // store manages — the layout formula is createPlanStore's contract,
          // pinned by plan-store.test.ts. A file that vanished between the
          // read and this stat reads as "no plan" rather than a 500.
          const planFile = path.join(
            getConfigDir(),
            "sessions",
            encodeWorkspaceName(projectPath),
            `${id}.plan.md`,
          );
          const stat = await fs.stat(planFile).catch(() => undefined);
          if (!stat) {
            jsonResponse(res, 404, { error: "no plan" });
            return;
          }
          jsonResponse(res, 200, { content, updatedAt: stat.mtime.toISOString() });
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    }

    // PATCH /sessions/:id — rename. Titles are session_meta (last-wins), so a
    // rename is an appended meta event, not an in-place edit of the log. The
    // write itself goes through the registry's ranked writer: a client that
    // tries to bury a name the user typed gets a 409 instead of a silent
    // 204, and every writer (route, derived title, model title) shares one
    // rule about who outranks whom.
    if (req.method === "PATCH" && url.pathname.startsWith("/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
      try {
        const body = JSON.parse(await readBody(req)) as { title?: unknown; source?: unknown };
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (title.length === 0 || title.length > 200) {
          jsonResponse(res, 400, { error: "title must be 1-200 characters" });
          return;
        }
        const source = body.source ?? "user";
        if (source !== "user" && source !== "model" && source !== "heuristic") {
          jsonResponse(res, 400, {
            error: 'source must be one of "user", "model", "heuristic"',
          });
          return;
        }
        // workspacePath is only consulted to place a *new* file; this session
        // already has one (the writer reads it), so resolveWritePath reuses
        // that existing path regardless of what is passed here. This is safe
        // only because there is no concurrent delete between the read and the
        // append — if a delete occurred between them, resolveWritePath would
        // write to a fresh top-level file for a session that was just removed.
        const result = await registry.writeTitle(id, title, source);
        if (result === "missing") {
          jsonResponse(res, 404, { error: `Unknown session: ${id}` });
          return;
        }
        if (result === "outranked") {
          jsonResponse(res, 409, {
            error: "a higher-priority title source owns this session",
          });
          return;
        }
        res.writeHead(204, corsHeaders);
        res.end();
      } catch (err: unknown) {
        if (respondBodyError(err)) return;
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET /sessions/:id/export — download the persisted transcript as
    // Markdown (default) or v2 JSONL. Read-only; no temp files.
    if (req.method === "GET") {
      const exportMatch = url.pathname.match(/^\/sessions\/([^/]+)\/export$/);
      if (exportMatch) {
        const id = decodeURIComponent(exportMatch[1]!);
        const format = url.searchParams.get("format") ?? "md";
        if (format !== "md" && format !== "jsonl") {
          jsonResponse(res, 400, { error: "format must be md or jsonl" });
          return;
        }
        try {
          const record = await chatStore.readSession(id);
          if (!record) {
            jsonResponse(res, 404, { error: `Unknown session: ${id}` });
            return;
          }
          const body =
            format === "md"
              ? renderSessionMarkdown(id, record.meta, record.events)
              : renderSessionJsonl(id, record.events);
          const base =
            (record.meta.title ?? "session")
              .replace(/[^\p{L}\p{N}._-]+/gu, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 80) || "session";
          // The id segment gets the same sanitizing as the title: an id with
          // a quote or CR would make writeHead throw on the header value.
          const safeId =
            id
              .replace(/[^\p{L}\p{N}._-]+/gu, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 8) || "session";
          const filename = `${base}-${safeId}.${format}`;
          res.writeHead(200, {
            "Content-Type":
              format === "md" ? "text/markdown; charset=utf-8" : "application/x-ndjson; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Length": Buffer.byteLength(body),
          });
          res.end(body);
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    }

    // POST /sessions/:id/fork — copy a completed turn prefix into a new
    // session. The source is never modified; attachments and plan follow the
    // prefix. 400 invalid cut, 404 unknown, 409 source mid-turn.
    if (req.method === "POST") {
      const forkMatch = url.pathname.match(/^\/sessions\/([^/]+)\/fork$/);
      if (forkMatch) {
        const id = decodeURIComponent(forkMatch[1]!);
        try {
          const record = await chatStore.readSession(id);
          if (!record) {
            jsonResponse(res, 404, { error: `Unknown session: ${id}` });
            return;
          }
          if (registry.isRunning(id)) {
            jsonResponse(res, 409, { error: "Cannot fork a session while a turn is running" });
            return;
          }
          // Subagent transcripts are an implementation detail of the task
          // tool; branching one would produce a "top-level" session that
          // still carries the subagent's delegationDepth.
          if (record.meta.origin === "subagent") {
            jsonResponse(res, 400, { error: "Cannot fork a subagent session" });
            return;
          }
          const body = (await readBody(req).then((raw) => (raw.trim() === "" ? {} : JSON.parse(raw)))) as {
            throughSeq?: unknown;
            throughTurn?: unknown;
            title?: unknown;
          };
          if (typeof body.title !== "undefined") {
            if (typeof body.title !== "string") {
              jsonResponse(res, 400, { error: "title must be a string" });
              return;
            }
            // Same contract as PATCH rename: an empty or oversized title must
            // not reach the meta (an empty string would also defeat the
            // `title ?? default` fallback inside forkSession).
            const titleLength = body.title.trim().length;
            if (titleLength === 0 || titleLength > 200) {
              jsonResponse(res, 400, { error: "title must be 1-200 characters" });
              return;
            }
          }
          if (
            body.throughSeq !== undefined &&
            (typeof body.throughSeq !== "number" || !Number.isInteger(body.throughSeq))
          ) {
            jsonResponse(res, 400, { error: "throughSeq must be an integer" });
            return;
          }
          if (
            body.throughTurn !== undefined &&
            (typeof body.throughTurn !== "number" || !Number.isInteger(body.throughTurn))
          ) {
            jsonResponse(res, 400, { error: "throughTurn must be an integer" });
            return;
          }
          const projectPath =
            record.meta.projectId === null
              ? null
              : ((await resolveProjectPath(projectStore, record.meta.projectId)) ?? null);
          const newId = randomUUID();
          const result = await forkSession(
            record,
            {
              ...(typeof body.throughSeq === "number" ? { throughSeq: body.throughSeq } : {}),
              ...(typeof body.throughTurn === "number" ? { throughTurn: body.throughTurn } : {}),
              ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
              locale: await activeLocale(getConfigDir(), req.headers["accept-language"]),
            },
            {
              chatStore,
              attachmentStoreFor,
              planStore,
              projectPath,
              newId,
            },
          );
          jsonResponse(res, 201, result);
        } catch (err: unknown) {
          if (err instanceof ForkError) {
            jsonResponse(res, err.status, { error: err.message });
            return;
          }
          if (respondBodyError(err)) return;
          if (err instanceof SyntaxError) {
            jsonResponse(res, 400, { error: "Invalid JSON body" });
            return;
          }
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
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
        // Drop the session's attachments alongside its transcript. The store
        // treats an empty/invalid session id as a no-op, so a malformed id
        // can never wipe the whole root.
        await attachmentStoreFor(id).deleteBySession(id);
        // Drop the plan document too — same lifecycle as the transcript
        // (spec 2026-09-19 §3.3). A session this process never rebuilt has no
        // reachable projectPath; the empty one degrades to an rm of a path
        // that cannot exist (force:true), a harmless no-op.
        await planStore.deleteBySession(id, registry.getSessionProjectPath(id) ?? "");
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
        // Standing todo list for the web TodoDock. Folded from the durable
        // event log so a cold page load restores the plan without replaying
        // tool args. Live SSE `todoListUpdated` frames still override this.
        const todos = foldStandingTodos(record.events);
        // The durable steering queue still waiting for delivery, in FIFO
        // order with each entry's enqueue time. Always present: `[]` means
        // "nothing queued", never "field omitted".
        const queuedMessages = pendingSteeringEntries(record.events);
        // The same text projection the conversation view uses, so a pending
        // entry can be matched against the message it parked at the turn end.
        const textOf = (content: string | ContentBlock[]): string =>
          typeof content === "string"
            ? content
            : content
                .filter(
                  (block): block is Extract<ContentBlock, { type: "text" | "structured" }> =>
                    block.type === "text" || block.type === "structured",
                )
                .map((block) => block.text)
                .join("");
        // The chat feed must not render a still-queued message as already
        // sent (D16): the view projection parks an undelivered entry at its
        // turn's end (spec scenario H), so drop exactly those entries here
        // and hand them to the dock through `queuedMessages`. Only this route
        // splits them — the trajectory route and every other
        // `readConversation` consumer keep the scenario-H placement.
        const messages = view.messages.filter(
          (message) =>
            !(
              message.role === "user" &&
              queuedMessages.some(
                (entry) =>
                  entry.time === message.timestamp && textOf(entry.content) === message.content,
              )
            ),
        );
        jsonResponse(res, 200, {
          id,
          ...bindingsOf(record.meta),
          messages,
          queuedMessages,
          contextUsage,
          todos,
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

    // POST /sessions/:id/compact — on-demand idle-session compaction.
    // Delegates to agent.compactNow() so the write-back path is shared with
    // automatic pre-request compaction. Answers:
    //   200 { replacedCount, tokensFreedEstimate } when state shrank
    //   200 { ok: true, compacted: false } when there was nothing to do
    //   409 when a turn is mid-flight (CompactionBusyError)
    //   404 when the session is unknown (neither live nor persisted)
    if (req.method === "POST") {
      const compactMatch = url.pathname.match(/^\/sessions\/([^/]+)\/compact$/);
      if (compactMatch) {
        const id = decodeURIComponent(compactMatch[1]!);
        try {
          if (!(await registry.hasSession(id))) {
            jsonResponse(res, 404, { error: `Unknown session: ${id}` });
            return;
          }
          // ensureAgent builds a session-scoped instance on a cold start so
          // compact never falls back to the process-wide shared agent.
          const target = await registry.ensureAgent(id);
          const result = await target.compactNow();
          if (result === null) {
            jsonResponse(res, 200, { ok: true, compacted: false });
            return;
          }
          jsonResponse(res, 200, result);
        } catch (err: unknown) {
          if (err instanceof CompactionBusyError) {
            jsonResponse(res, 409, { error: err.message });
            return;
          }
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
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

    // POST /fs/reveal — open the OS file manager with the path selected
    if (req.method === "POST" && url.pathname === "/fs/reveal") {
      try {
        const body = JSON.parse(await readBody(req)) as { path?: unknown };
        if (typeof body.path !== "string" || body.path.trim() === "") {
          jsonResponse(res, 400, { error: "path is required" });
          return;
        }
        await pathRevealer.reveal(body.path);
        jsonResponse(res, 200, { ok: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof RevealInvalidPathError) {
          jsonResponse(res, 400, { error: message });
        } else if (err instanceof RevealUnsupportedError) {
          jsonResponse(res, 501, { error: message });
        } else if (err instanceof CommandTimeoutError) {
          jsonResponse(res, 504, { error: message });
        } else {
          jsonResponse(res, 500, { error: message });
        }
      }
      return;
    }

    // GET /fs/tree — list one directory of a registered project (read-only)
    if (req.method === "GET" && url.pathname === "/fs/tree") {
      const projectId = url.searchParams.get("projectId");
      const rel = url.searchParams.get("path") ?? "";
      if (projectId === null || projectId === "") {
        jsonResponse(res, 400, { error: "projectId is required" });
        return;
      }
      try {
        const projectRoot = await resolveProjectPath(projectStore, projectId);
        if (projectRoot === undefined) {
          jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
          return;
        }
        const entries = await listDirectory(projectRoot, rel);
        jsonResponse(res, 200, { path: rel, entries });
      } catch (err: unknown) {
        const mapped = fsErrorStatus(err);
        jsonResponse(res, mapped?.status ?? 500, { error: mapped?.message ?? String(err) });
      }
      return;
    }

    // GET /file-refs — settle-time file reference annotations for one session.
    // Ambiguous or unknown refs carry no annotation and render as plain text.
    if (req.method === "GET" && url.pathname === "/file-refs") {
      const projectId = url.searchParams.get("projectId");
      const sessionId = url.searchParams.get("sessionId");
      if (projectId === null || projectId === "" || sessionId === null || sessionId === "") {
        jsonResponse(res, 400, { error: "projectId and sessionId are required" });
        return;
      }
      try {
        jsonResponse(res, 200, { refs: await fileRefs.getRefs(projectId, sessionId) });
      } catch (err: unknown) {
        if (err instanceof UnknownProjectError) {
          jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
          return;
        }
        if (err instanceof UnknownSessionError) {
          jsonResponse(res, 404, { error: `Unknown session: ${sessionId}` });
          return;
        }
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET /fs/search — filename/dirname search confined to the project root
    if (req.method === "GET" && url.pathname === "/fs/search") {
      const projectId = url.searchParams.get("projectId");
      const q = url.searchParams.get("q");
      if (projectId === null || projectId === "" || q === null || q === "") {
        jsonResponse(res, 400, { error: "projectId and q are required" });
        return;
      }
      try {
        const projectRoot = await resolveProjectPath(projectStore, projectId);
        if (projectRoot === undefined) {
          jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
          return;
        }
        jsonResponse(res, 200, { matches: await searchFiles(projectRoot, q) });
      } catch (err: unknown) {
        const mapped = fsErrorStatus(err);
        jsonResponse(res, mapped?.status ?? 500, { error: mapped?.message ?? String(err) });
      }
      return;
    }

    // GET /fs/file — one file's preview payload (text/image/binary)
    if (req.method === "GET" && url.pathname === "/fs/file") {
      const projectId = url.searchParams.get("projectId");
      const rel = url.searchParams.get("path");
      if (projectId === null || projectId === "" || rel === null || rel === "") {
        jsonResponse(res, 400, { error: "projectId and path are required" });
        return;
      }
      try {
        const projectRoot = await resolveProjectPath(projectStore, projectId);
        if (projectRoot === undefined) {
          jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
          return;
        }
        jsonResponse(res, 200, await readFilePayload(projectRoot, rel));
      } catch (err: unknown) {
        const mapped = fsErrorStatus(err);
        jsonResponse(res, mapped?.status ?? 500, { error: mapped?.message ?? String(err) });
      }
      return;
    }

    // GET /git/summary — repository probe for the workspace git pane
    if (req.method === "GET" && url.pathname === "/git/summary") {
      const projectId = url.searchParams.get("projectId");
      if (projectId === null || projectId === "") {
        jsonResponse(res, 400, { error: "projectId is required" });
        return;
      }
      try {
        const projectRoot = await resolveProjectPath(projectStore, projectId);
        if (projectRoot === undefined) {
          jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
          return;
        }
        jsonResponse(res, 200, await getRepository(projectRoot));
      } catch (err: unknown) {
        const mapped = gitErrorStatus(err);
        jsonResponse(res, mapped?.status ?? 500, { error: mapped?.message ?? String(err) });
      }
      return;
    }

    // GET /git/branches — local + remote-tracking branches, truncated
    if (req.method === "GET" && url.pathname === "/git/branches") {
      const projectId = url.searchParams.get("projectId");
      if (projectId === null || projectId === "") {
        jsonResponse(res, 400, { error: "projectId is required" });
        return;
      }
      try {
        const projectRoot = await resolveProjectPath(projectStore, projectId);
        if (projectRoot === undefined) {
          jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
          return;
        }
        const q = url.searchParams.get("q") ?? undefined;
        jsonResponse(res, 200, await listBranches(projectRoot, { q }));
      } catch (err: unknown) {
        const mapped = gitErrorStatus(err);
        jsonResponse(res, mapped?.status ?? 500, { error: mapped?.message ?? String(err) });
      }
      return;
    }

    // POST /git/checkout — switch to a local or remote branch
    if (req.method === "POST" && url.pathname === "/git/checkout") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          projectId?: unknown;
          name?: unknown;
          kind?: unknown;
        };
        if (
          typeof body.projectId !== "string" ||
          body.projectId === "" ||
          typeof body.name !== "string" ||
          body.name === "" ||
          (body.kind !== "local" && body.kind !== "remote")
        ) {
          jsonResponse(res, 400, { error: "projectId, name, and kind (local|remote) are required" });
          return;
        }
        const projectRoot = await resolveProjectPath(projectStore, body.projectId);
        if (projectRoot === undefined) {
          jsonResponse(res, 404, { error: unknownProjectMessage(body.projectId) });
          return;
        }
        const result = await checkoutBranch(projectRoot, { name: body.name, kind: body.kind });
        jsonResponse(res, 200, result);
      } catch (err: unknown) {
        if (respondBodyError(err)) return;
        const mapped = gitErrorStatus(err);
        jsonResponse(res, mapped?.status ?? 500, { error: mapped?.message ?? String(err) });
      }
      return;
    }

    // POST /git/branches — create a new branch from HEAD and check it out
    if (req.method === "POST" && url.pathname === "/git/branches") {
      try {
        const body = JSON.parse(await readBody(req)) as { projectId?: unknown; name?: unknown };
        if (
          typeof body.projectId !== "string" ||
          body.projectId === "" ||
          typeof body.name !== "string" ||
          body.name === ""
        ) {
          jsonResponse(res, 400, { error: "projectId and name are required" });
          return;
        }
        const projectRoot = await resolveProjectPath(projectStore, body.projectId);
        if (projectRoot === undefined) {
          jsonResponse(res, 404, { error: unknownProjectMessage(body.projectId) });
          return;
        }
        const result = await createAndCheckoutBranch(projectRoot, body.name);
        jsonResponse(res, 200, result);
      } catch (err: unknown) {
        if (respondBodyError(err)) return;
        const mapped = gitErrorStatus(err);
        jsonResponse(res, mapped?.status ?? 500, { error: mapped?.message ?? String(err) });
      }
      return;
    }

    // GET /git/graph — limited topological commit list
    if (req.method === "GET" && url.pathname === "/git/graph") {
      const projectId = url.searchParams.get("projectId");
      if (projectId === null || projectId === "") {
        jsonResponse(res, 400, { error: "projectId is required" });
        return;
      }
      try {
        const projectRoot = await resolveProjectPath(projectStore, projectId);
        if (projectRoot === undefined) {
          jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
          return;
        }
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw !== null && limitRaw !== "" ? Number(limitRaw) : undefined;
        jsonResponse(res, 200, await getGraph(projectRoot, { limit }));
      } catch (err: unknown) {
        const mapped = gitErrorStatus(err);
        jsonResponse(res, mapped?.status ?? 500, { error: mapped?.message ?? String(err) });
      }
      return;
    }

    // GET /git/commits/:hash — full detail for one commit
    if (req.method === "GET") {
      const commitMatch = url.pathname.match(/^\/git\/commits\/([^/]+)$/);
      if (commitMatch) {
        const hash = decodeURIComponent(commitMatch[1]!);
        const projectId = url.searchParams.get("projectId");
        if (projectId === null || projectId === "") {
          jsonResponse(res, 400, { error: "projectId is required" });
          return;
        }
        try {
          const projectRoot = await resolveProjectPath(projectStore, projectId);
          if (projectRoot === undefined) {
            jsonResponse(res, 404, { error: unknownProjectMessage(projectId) });
            return;
          }
          jsonResponse(res, 200, await getCommitDetail(projectRoot, hash));
        } catch (err: unknown) {
          const mapped = gitErrorStatus(err);
          jsonResponse(res, mapped?.status ?? 500, { error: mapped?.message ?? String(err) });
        }
        return;
      }
    }

    // GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { status: "ok" });
      return;
    }

    // /attachments routes — POST upload, GET download
    if (await attachmentRoutes(req, res, url, corsHeaders, jsonResponse)) {
      return;
    }

    jsonResponse(res, 404, { error: "Not found" });
  };

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      // Top-level guard: a malformed percent-encoded path segment makes
      // decodeURIComponent throw before any route-level try block runs.
      // Answer 400 for that client error and 500 for anything else; never
      // let the rejection escape and take the process down.
      if (!res.headersSent) {
        const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
        res.writeHead(err instanceof URIError ? 400 : 500, {
          "Content-Type": "application/json",
          ...corsHeadersFor(origin),
        });
        res.end(
          JSON.stringify({
            error:
              err instanceof URIError ? "Malformed URI path segment" : "Internal server error",
          }),
        );
      } else {
        res.end();
      }
    });
  });

  // WebSocket server on the same HTTP server. `noServer` so the upgrade
  // path can run the same auth guard the HTTP request chain uses — a WS
  // handshake does not pass through the createServer request handler.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    // Origin BEFORE auth, mirroring the HTTP chain (isOriginAllowed above):
    // different localhost ports are same-site, so the SameSite=Strict cookie
    // WOULD be sent to us from another page on localhost — Origin is the
    // only check that stops a malicious localhost page from driving /ws
    // with the user's cookie. Missing Origin (curl, Node `ws` without
    // `origin`) stays allowed, same as HTTP.
    const originHeader = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!isOriginAllowed(originHeader)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Auth BEFORE path matching, same as the HTTP guard: an unauthenticated
    // caller must get 401 for ANY upgrade path — never a 404 that would
    // leak which paths exist. A valid query-token exchange (isAuthorized)
    // is accepted: a WS handshake cannot complete a 302 + Set-Cookie
    // redirect, and the token was still valid.
    if (!isAuthorized(auth.authorize(req))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket: WebSocket, req: http.IncomingMessage) => {
    // Path and credentials were already validated in the upgrade handler.
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
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

  httpServer.on("close", () => void registry.closeAll());

  // Configured-port URL for the return value. The listen callback re-derives
  // the real port (relevant when port: 0 asked the OS to pick one).
  const authenticatedUrl = auth.authenticatedUrl(`http://${host}:${port}`);

  httpServer.listen(port, host, () => {
    const addr = httpServer.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
    const url = auth.authenticatedUrl(`http://${host}:${actualPort}`);
    console.log(`Headless server listening on http://${host}:${actualPort}`);
    console.log(`Open this URL to authenticate: ${url}`);
    // When a concrete web origin is configured (the common dev setup — the
    // web app rewrites /gateway/* to this gateway), also print the proxied
    // token URL so the browser lands on the UI's own origin and the cookie
    // is minted where the UI will send it from.
    if (corsOrigin !== "*" && /^https?:\/\//.test(corsOrigin)) {
      const webUrl = new URL("/gateway", corsOrigin);
      webUrl.searchParams.set("token", auth.launchToken);
      console.log(`Or open the web app URL: ${webUrl.toString()}`);
    }

    // Best-effort orphan reclaim on startup. Failures must never block or
    // fail the server — a leftover attachment dir is a disk-usage issue,
    // not a reason to refuse connections.
    void (async () => {
      try {
        const { records } = await chatStore.listSessions();
        const liveSessionIds = new Set(records.map((r) => r.sessionId));
        const { removed } = await cleanupOrphanAttachments({
          rootDir: attachmentRoot,
          now: Date.now(),
          liveSessionIds,
        });
        if (removed.length > 0) {
          console.log(`Reclaimed ${removed.length} orphaned attachment dir(s): ${removed.join(", ")}`);
        }
      } catch (err: unknown) {
        console.warn(
          "Orphan attachment cleanup failed (non-fatal):",
          err instanceof Error ? err.message : err,
        );
      }
    })();
  });

  return Object.assign(httpServer, {
    launchToken: auth.launchToken,
    authenticatedUrl,
  });
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
