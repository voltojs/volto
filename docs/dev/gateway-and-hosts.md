---
title: Gateway and hosts
status: current
source:
  - apps/gateway/src
  - apps/desktop-app/src/main
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-08-31-web-app-sse-design.md
  - docs/archive/superpowers/specs/2026-09-02-native-directory-picker-design.md
  - docs/archive/superpowers/specs/2026-09-09-security-architecture-analysis.md
  - docs/archive/superpowers/specs/2026-11-12-standalone-sdk-gateway-web-design.md
  - docs/archive/superpowers/plans/2026-09-09-gateway-auth.md
  - docs/archive/superpowers/plans/2026-11-12-release-0.1-sdk-gateway-web.md
---

# Gateway and hosts

## Scope and where it sits

There are three hosts in this repo, and only one of them is a server:

- **Gateway** (`apps/gateway`) — `createServer` in `src/server.ts` builds an `http.Server`
  that serves the exported web app, the HTTP API, the per-session SSE channel and the
  legacy WebSocket/one-shot endpoints, plus the CLI (`src/bin.ts` → `src/cli.ts`). It is
  the only published app package (`@voltojs/gateway`, `bin: volto`).
- **Web** (`apps/web`) — a Next.js app built with `output: 'export'`; its plain files are
  served by the gateway (or `volto web`), and it talks to the API over `fetch` and
  `EventSource` using the protocol types from `@voltojs/sdk/sse`.
- **Desktop** (`apps/desktop-app`) — an Electron app that builds its **own** agent instances
  in the main process and never speaks HTTP/SSE to the gateway.

The gateway is a wiring layer, not a second kernel: it constructs agents through
`createWiredAgent` (`src/wiring.ts`), drives them through `createSessionRegistry`
(`src/sessions.ts`), and frames their events with the SDK's `sse` module
(`packages/sdk/src/sse/`). Nothing in `packages/core` knows a socket exists.

Default addresses: gateway `127.0.0.1:3100` (`DEFAULT_PORT`), `volto web` `127.0.0.1:6100`
proxying `http://127.0.0.1:3100` (`DEFAULT_WEB_PORT`, `DEFAULT_GATEWAY_URL` in
`src/cli.ts`). `apps/web`'s dev server also runs on 6100 — the origin the gateway's default
CORS allow-list names (`DEFAULT_CORS_ORIGIN`).

Where state lives: one config directory (`~/.volto` unless `VOLTO_CONFIG_DIR` /
`--config-dir` overrides it) holds `config.json`, `access-token`, `auth-secret`, `sessions/`
transcripts, `attachments/` and `db/sessions.db`. The sandbox denies the agent read access to
that directory and strips secret-shaped variables (`SECRET_ENV_PATTERNS` in `src/wiring.ts`),
because the token that authorizes the API sits next to the transcript store.

## Current behavior (HTTP surface, SSE, auth, session lifecycle)

### CLI surface

`parseCliArgs` accepts four subcommands (`COMMANDS` in `src/cli.ts`): `serve` (default,
also selected when the first argument is a flag), `token`, `doctor`, `web`.

| Command | Behavior |
| --- | --- |
| `volto` | Starts the gateway, prints exactly two stdout lines (`volto gateway <v> listening on http://<host>:<port>` and `Open: <url?token=…>`), opens that URL by default in local mode (`--open`/`--no-open` override), then waits for shutdown. |
| `volto token [--rotate]` | Prints the persistent access token and its login URL; `--rotate` replaces it, immediately invalidating every issued cookie. |
| `volto doctor` | Runs six independent checks (node ≥ 22, sandbox backend, sandbox binary, config dir writable, session store, port free). Only a failed **hard** check exits 1 — a busy port or a degraded (fallback) store is reported, not fatal. |
| `volto web` | Serves the exported UI and proxies every API path to `--gateway`; prints three lines (`listening … -> <gateway>`, `Open:`, `Login:`). |

A failed bind prints nothing on stdout and exits 1 (`bindOrReport`): the stdout lines are a
script contract, and "listening" for a port the process does not hold would be a lie.
`--serve-remote` is the only way a non-loopback `--host` is accepted; without it both
`runServe` and `runWeb` refuse before any listener exists, and `createServer` throws too.

### Request pipeline

`handleRequest` in `src/server.ts` runs in a fixed order, and the order is the security
model:

1. **Origin check** — `isOriginAllowed`: no `Origin` is allowed (non-browser clients send
   none); `*` in the allow-list allows everything; otherwise a normalized allow-list match,
   then a same-origin check comparing `Origin`'s host with the `Host` header after URL
   parsing. A mismatch answers 403 with the rejected origin in the body.
2. **CORS preflight** — `OPTIONS` answers 204 with `corsHeadersFor`, deliberately *before*
   the auth guard so a browser can discover `Authorization` and `Last-Event-ID` without a
   credential.
3. **Static hosting** — `serveStatic` (`src/static/serve.ts`) runs before the guard, for
   `GET`/`HEAD` only, and is skipped entirely when the request carries `?token=`
   (`hasQueryToken`) so the guard can perform the login exchange. Only files inside the real
   web root are served (`readInRoot` checks the file's own realpath); anything else is a 404.
4. **Auth guard** — `createAuthGuard` (`src/auth/middleware.ts`) for every path except
   `publicPaths: ["/health"]`. It answers 302 (cookie exchange), 401 or 429 and returns false
   when it did.
5. **Route matching** — the `url.pathname` chain in `handleRequest`, ending in
   `jsonResponse(res, 404, { error: "Not found" })`.
6. **Body cap** — `readBody` rejects anything over `MAX_BODY_BYTES` (1 MiB) with 413 and
   destroys the socket after the response flushes. The attachment upload route raises its
   own cap to `MAX_IMAGE_BASE64 + 64 KiB` (~5 MiB) in `src/attachments/routes.ts`.

A top-level `.catch` around `handleRequest` turns a malformed percent-encoded segment
(`decodeURIComponent` throwing `URIError`) into 400 and anything else into 500, instead of
an unhandled rejection.

### HTTP surface

Protocol routes (consumed by `apps/web` through `@voltojs/sdk/sse`):

| Method + path | Contract |
| --- | --- |
| `GET /events?sessionId=` | Long-lived SSE channel for one session; `sessionId` defaults to `"default"`. 200 `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, headers flushed immediately. |
| `POST /messages` | Starts a turn. Body: `{ sessionId?, message, projectId?, providerId?, modelId?, permissionMode?, reasoningEffort?, attachments? }`. 400 on a bad shape, unsupported `permissionMode`, unknown attachment id, unsupported `reasoningEffort` or an image sent to a text-only model; 409 when the session has no live `/events` connection; 202 `{ queued: true }` when a turn is already running (the message is steered); 503 when the turn latch is held but no agent materialized within `steerAgentWaitMs`; otherwise 202 `{ sessionId, accepted: true }` and the turn streams over `/events`. |
| `POST /messages/queue` | Edits (`{ kind: "edit", content }`) or withdraws (`{ kind: "remove" }`) a queued message by its `steering_queued` id. 400 on a bad shape or blank content, 409 `QUEUE_ITEM_GONE`, 500 if the seed append failed (nothing mutated — retry is safe), 200 `{ ok: true }`. |
| `POST /interrupt` | Aborts the running turn. 409 when nothing runs, 202 `{ sessionId, interrupted: true }` otherwise. |
| `POST /approvals` | Settles one pending approval: `{ sessionId?, callId, decision: "allow"\|"deny", token?, answer?, remember? }`. 400 on a bad shape (including `remember` with anything but `{ prefixTokens: number }`), 403 on a missing/wrong connection token, 409 on an unknown `callId`, 202 `{ status: "ok", remembered?, rememberError? }`. |

Session and read routes:

| Method + path | Contract |
| --- | --- |
| `GET /sessions` | List from the transcript store; `origin: "subagent"` sessions are hidden. `?q=` switches to search (`projectId`, `limit`); unreadable logs are counted in `unreadableSessions`. |
| `GET /sessions/:id` | Projected conversation (`readConversation`) plus `queuedMessages`, `contextUsage`, `todos` and the config bindings. 404 unknown, 410 for a transcript written by an older format. |
| `GET /sessions/:id/trajectory` | Projected audit ledger (`readTrajectory`). |
| `GET /sessions/:id/events` | Raw persisted events, wire order, no projection; `?tail=1` returns only the unfinished turn plus `running`, which is what the web client uses to rebuild a turn after a reload. |
| `GET /sessions/:id/plan` | Plan document plus its file mtime; 404 when the session has no project or no plan. |
| `GET /sessions/:id/export?format=md\|jsonl` | Download the transcript; 400 on an unknown format. |
| `POST /sessions/:id/fork` | Copy a completed turn prefix into a new session (201); 400 invalid cut, 404 unknown, 409 while the source runs. |
| `PATCH /sessions/:id` | Rename through the ranked title writer; 404 unknown, 409 when a higher-priority source owns the title, 204 on success. |
| `DELETE /sessions/:id` | Drops the transcript, its attachments and its plan; 204. |
| `POST /sessions/:id/compact` | On-demand compaction; 200 with `{ replacedCount, tokensFreedEstimate }`, 200 `{ ok: true, compacted: false }` when nothing to do, 409 mid-turn, 404 unknown. |

Configuration and workspace routes: `GET|POST /projects` + `DELETE /projects/:id`;
`GET|POST /providers`, `PUT|DELETE /providers/:id`, `POST /providers/:id/probe`;
`GET /catalog/providers`; `GET|PUT /preferences`; `GET|PUT /config/browser`;
`GET|PUT /sidebar-state`; `GET|PUT /config/routing-tiers` (PUT replaces the table and 409s
when a referenced tier id would disappear); `GET /commands`, `/skills`, `/tools`;
`GET|POST /agents` + `PUT|DELETE /agents/:id`; `GET /fs/tree`, `/fs/search`, `/fs/file`;
`POST /fs/pick-directory`, `/fs/reveal`; `GET /file-refs`; `GET /git/summary`, `/git/branches`,
`/git/graph`, `GET /git/commits/:hash`, `POST /git/checkout`, `POST /git/branches`;
`POST /attachments`, `GET /attachments/:id?sessionId=`.

Meta routes: `GET /health` (public) returns `{ status: "ok" }`; `GET /gateway-info`
**requires authentication** and returns `{ version, mode, capabilities }`, because `mode`
and the capability flags describe the operator's exposure decision rather than liveness.

Legacy routes, kept for out-of-tree clients with no in-repo consumer: `POST /run` (one-shot,
returns the final state), `POST /resume` (HITL decision), `GET /stream` (anonymous `data:` frames
of raw internal events plus `data: [DONE]`) and `GET /ws` (same raw events) — all driving the
process-wide agent built without a `sessionId`.

### The SSE channel

Framing lives in `packages/sdk/src/sse/event-mapper.ts` (`createEventMapper`,
`formatSSEFrame`): `id:`, `event:`, `data:` lines, no `retry:` field. There are five frame
kinds (`SSEFrameType` in `packages/sdk/src/sse/types.ts`):

| Frame | Meaning |
| --- | --- |
| `event` | An authoritative transcript event, byte-for-byte the `{ time, type, data, turn?, step? }` the Runner persisted. Monotonic `id`; replayable. |
| `delta` | A streaming increment (`text`, `reasoning`, `tool_use`) with optional sub-agent tags (`agentDepth`, `childSessionId`). Shares the last `event` id and is **never** buffered: a lost delta is corrected by the next authoritative event. |
| `heartbeat` | Keep-alive every `heartbeatInterval` (default 15 000 ms). |
| `error` | Transport-level failure (`{ code, message, retryable }`); agent errors travel as transcript events instead. |
| `connected` | Sent once, immediately after a connection opens, carrying the per-connection approval token (`ConnectedData.token`). |

`attach` in `src/sessions.ts` is the whole lifecycle: it detaches any existing connection
first (a session serves **one** client — a new connection displaces the old one), writes a
`: connected` comment, writes the `connected` frame with a fresh
`crypto.randomBytes(32).toString("hex")` token, installs the heartbeat interval, then replays
buffered frames with an id greater than the `Last-Event-ID` header (or `last-event-id` query
parameter). The replay buffer holds up to `replayBufferSize` (200) non-delta frames.

`detach` settles every pending approval as `deny` with reason `connection-lost` — a dropped
channel must never leave a tool call parked, and it must never default to allow. The
heartbeat timer is cleared there; `detachById` only detaches when the closing response is
still the active one, so a superseded connection cannot tear down its replacement.

### Session and turn lifecycle

`createSessionRegistry` keeps one `Session` per id (at most `maxSessions`, default 100; the
least-recently-used session without a connection and not running is evicted, disposing its
agent first). A `Session` owns the agent instance, the resolved-config snapshot it was built
from, carry-forward history, the SSE mapper, the replay buffer, the `running` latch, an
`AbortController`, the approval registry and a `pendingCommands` map.

A turn (`runTurn`):

1. Re-checks the `running` latch; if held, waits up to `steerAgentWaitMs` for an agent and
   steers into it, or reports `server.error.agentStarting` as an `error` frame.
2. Claims the latch in the same synchronous span as the check — no `await` between them, so
   two callers can never both start a turn.
3. Loads `session_meta` once to derive provenance (`attributeTurnInput`): only a subagent
   session gets `source: { kind: "host-continuation" }`, and a main session has any supplied
   source stripped. Then derives a title when the session has none (`prepareHeuristicTitle`,
   with `generateModelTitle` following in the background) through the ranked writer
   `writeSessionTitle`, where `user` > `model` > `heuristic`.
4. `resolveConfig`, then `rebuild` when the binding changed or `permissionsDirty` is set, then
   streams the turn, framing each channel event with `frame`/`push`.

Cold start reads the durable transcript to restore history and any undelivered steering queue
(`pendingSteeredMessages`), so a restart does not truncate context. A failure before `stream()`
is recorded as a bare `error` event on the channel; after that boundary the SDK owns recording.
Every turn closes with `turn_end`, carrying `reason: "cancelled"` after an interrupt.

Approvals are not polled: the gate parks the promise (`src/approval-gate.ts`,
`createApprovalRegistry`), the Runner emits `approval_asked`/`approval_decision` as transcript
events, and `POST /approvals` settles it through `decideApproval`. `ask_user` bypasses the
Runner, so `approvalHooks` synthesizes those two brackets for it. There is deliberately no
timeout: an approval that hangs is visible, one that silently resolved itself is not.

### Authentication and credentials

Two credentials — the per-process **launch token** (never persisted, dies with the process) and
the persistent **access token** (`<configDir>/access-token`, 0600, 32 random bytes base64url) —
presented in three ways. `authorize` in `src/auth/browser-auth.ts` checks them in this order:

1. **Query token** — a valid token on `GET`/`HEAD` is exchanged for a cookie (`authorize`
   returns the `Set-Cookie` + redirect shape). The guard answers 302 only for a document
   navigation (`Sec-Fetch-Mode: navigate`, `redirectable` in `src/auth/middleware.ts`); any
   other token-bearing request keeps the uniform 401, and `?token=` on a POST is not a
   credential at all, because a 302 would drop the body. A WebSocket handshake accepts the
   exchange shape through `isAuthorized`.
2. **Cookie** — `volto_auth`, `HttpOnly; SameSite=Strict; Path=/; Max-Age=7d`, plus `; Secure`
   when the request itself was HTTPS (`cookieAttributesFor`, which follows
   `X-Forwarded-Proto` only under `--trust-proxy`). The payload is versioned and
   generation-bound, `{ v: 2, exp, tv }`, where `tv` is `tokenFingerprint(token)` — the first
   16 hex characters of the token's SHA-256. A presented-but-invalid cookie fails closed
   instead of falling through to the bearer check.
3. **Bearer** — either token, compared in constant time.

The token generation is re-read **per request** (`createTokenGenerationReader`, cached on the
file's `mtimeMs`/size/inode), so `volto token --rotate` invalidates already-issued cookies
immediately rather than after seven days, and a deleted/unreadable token file fails closed.
Every rejection is the byte-identical `{"error":"Unauthorized"}` regardless of cause, and the
429 body is the same string — the status says "slow down", nothing says whether a guess would
have been right.

Failed authentication is rate limited per client IP inside the guard
(`createAuthRateLimiter`): 10 failures in 60 s trip a 60 s cooldown; a success clears the key.
Only failures count, so a cooling-down address can still present a valid credential. The
client IP is the socket address unless `--trust-proxy` was given, in which case the first
`X-Forwarded-For` hop wins — off by default because a directly reachable port makes that
header attacker-controlled. The WebSocket upgrade runs the same origin check, the same
`authorize`, and the same limiter, answering 401/403/429/404 before `handleUpgrade`.

### Remote posture and `volto web`

`--serve-remote` fixes `mode: "remote"` at construction; nothing in a request (header,
origin, source IP) can change it. `resolveCapabilities` (`src/capabilities.ts`) projects the
posture plus wiring facts onto `{ nativeDialogs, browserAutomation, lsp }`:
`nativeDialogs` is `mode === "local"`, while `browserAutomation` and `lsp` report whether
those hosts were actually assembled. In remote mode `/fs/pick-directory` and `/fs/reveal`
answer `501 { error: "capability_unavailable" }` for **every** method, before any body is
read — the route exists, the capability is withdrawn.

`volto web` (`src/web-server.ts`) is a same-origin front end, not a static-only server:

- The root prefix list `API_PREFIXES` is shared with the gateway's own static router, so a
  new API root cannot be proxied here but missed there (or vice versa).
- Any request under those prefixes, or carrying `?token=`, is forwarded upstream with method,
  path, query, headers and body intact. `Host` is forwarded on purpose: the gateway's
  same-origin rule compares it with `Origin`. Hop-by-hop headers are dropped, `Set-Cookie` is
  forwarded verbatim (array form), and `Location` pointing at the gateway origin is rewritten
  to the web origin.
- Responses are `upstreamRes.pipe(res)`, never buffered — `/events` never ends, so a buffered
  proxy would deadlock every live turn.
- `/ws` arrives as an HTTP `upgrade`; the server tunnels it (`tunnelUpgrade`), rebuilding
  `Connection: Upgrade`, forwarding the gateway's 101 verbatim, then splicing the sockets.
- Everything else is served from the exported build by the gateway's own `serveStatic`
  (traversal and symlink containment live in exactly one place).
- The proxy authenticates nothing. It forwards the cookie and relays the gateway's 401/302.
  A non-loopback `--host` is refused unless `--serve-remote`, same as `serve`.

## The web host and the desktop host (what each wires)

### Web (`apps/web`)

The exported build is a pure client. At runtime the address comes from `getGatewayBase()`
(`lib/gateway-base.ts`), resolved once and memoized in this order:
`localStorage["volto.gatewayUrl"]` → `window.__VOLTO_CONFIG__.gatewayUrl` → `DEV_DEFAULT`
(`"/gateway"` under `next dev`, `""` — same origin — otherwise). The gateway serves its own
`/volto-config.js` with `gatewayUrl: ""` and its package version
(`buildConfigScript` in `src/static/serve.ts`); `apps/web/public/volto-config.js` is the
same-origin default for any other static host. `next.config.ts` keeps the `/gateway/:path*`
rewrite **only** outside `VOLTO_WEB_EXPORT=1`, so the dev loop proxies to port 3100 while the
export stays prefix-free.

What it wires:

- `lib/agent-config.ts` — `createGatewaySSEClient` forces `new EventSource(url, { withCredentials: true })`
  because the default `EventSource` sends no cookie; `postMessage` sends
  `credentials: "include"` and throws the server's `error` string on a non-2xx;
  `interruptTurn` maps 409 to "nothing was running"; `postApproval` attaches the
  per-connection `token` learned from the `connected` frame (`getConnectionToken()`) and
  treats 409 as "the card was stale" rather than an error.
- `hooks/use-chat-agent.ts` — opens one channel per active session, routes frames into the
  chat store (`onEvent` / `onDelta` / `onError`), tags sub-agent frames by `childSessionId`,
  and after connecting calls `GET /sessions/:id/events?tail=1` to rebuild an in-flight turn
  (a fresh `EventSource` gets no `Last-Event-ID` replay). Sending is `POST /messages`; the
  user's own message comes back as a `user_message` event, so nothing is added optimistically.
- `lib/capabilities.ts` + `hooks/use-add-project.ts` — `GET /gateway-info` is fetched once at
  boot; only an explicit `nativeDialogs: false` switches the add-workspace flow to a typed
  absolute path, and UNKNOWN (older gateway, 401 during re-login) keeps the native picker.

### Desktop (`apps/desktop-app`)

The Electron main process embeds the SDK; there is no gateway in the loop.

- `src/main/index.ts` creates the IPC event sink, the `AgentManager`, the IPC handlers and the
  window; `before-quit` intercepts the quit and awaits `destroyAgentManager()` so persistent
  bash sessions and background processes are reaped instead of orphaned.
- `src/main/agent/agent-manager.ts` keeps `Map<sessionId, AgentInstance>`. `create()` resolves
  the session's provider/model binding from `electron-store`, converts persisted messages to
  `initialMessages` (`session-history.ts`) and builds the instance through
  `createAgentInstance`; `stream()`/`run()` auto-create on first use, and `destroy()` awaits
  `agent.dispose()`.
- `src/main/agent/wiring.ts` constructs the SDK directly: `createPiAiModelPort` with one
  `custom` provider, node fs/shell/network/scheduler, and a permission triple read from
  `store.permissionMode` — `auto` → `danger-full-access` + `approval: "never"`, `deny` →
  `read-only` + `never`, otherwise `workspace-write` + `ask`. The same mode also builds the
  `SandboxConfig` handed to `createAgent`, because otherwise the persistent-session bash path
  would run unconfined while the config claimed otherwise. `askUserGate` is bound to the same
  gate as `approvalGate`; the SDK's default would auto-answer `ask_user` with "yes".
- `src/main/agent/approval-gate.ts` parks each `ask()` on a promise keyed by a locally minted
  `requestId`, broadcasts `agent:approval-request` to every window, and denies after
  `approvalTimeoutMs` (5 minutes) or when `dispose()` runs. Decisions come back on
  `agent:approval-decide`; `agent:approval-list` re-sends everything still pending so a
  remounted dialog recovers.
- `src/main/ipc/agent-handlers.ts` registers `agent:create`, `agent:send-message`,
  `agent:resume`, `agent:get-status`, `agent:get-state`, `agent:destroy`,
  `agent:approval-decide`, `agent:approval-list`, plus the time-travel pair
  `debug:checkpoints` / `debug:rewind` (checkpoints are the agent's own session store, keyed
  `sessionId#seq`).
- `src/preload/index.ts` exposes `window.electronAPI` (`store`, `agent`, `app`) through
  `contextBridge`; `window.ts` sets `sandbox: false` for the preload and loads the Vite dev
  URL in development, `renderer/index.html` otherwise.

| Concern | Gateway + web | Desktop |
| --- | --- | --- |
| Transport | HTTP + SSE, `EventSource` with credentials | `ipcRenderer.invoke` + `agent:event` broadcasts |
| Agent construction | `createWiredAgent` (config-store driven, per turn rebuild) | `createAgentInstance` (electron-store driven, explicit `create`) |
| Transcript | `@voltojs/store-jsonl` + sqlite session store under the config dir | `electron-store` (`sessions`, `sessionMessages`), replayed into `initialMessages` |
| Providers | provider store, per-session `providerId`/`modelId`, protocol probe | one `custom` provider per session binding, no probe |
| Permission presets | `permission-modes.ts` over `@voltojs/core`'s `PERMISSION_PRESETS` | local `auto`/`ask`/`deny` triple in `wiring.ts` |
| Approvals | SSE channel + `POST /approvals` with a per-connection token | IPC broadcast + `requestId`, 5-minute deny timeout |
| Auth | launch/access token → cookie/bearer, rate limited | none; the process boundary is the app |

The desktop path is the older wiring and the two have drifted: it has no attachments
pipeline, no browser host, no LSP/egress/hooks/skills wiring and no transcript store, and its
permission vocabulary is a separate three-value list rather than the core preset table.

## Invariants and boundaries

- **Auth before routing.** The guard runs before any `url.pathname` match, so an
  unauthenticated caller gets 401 for a path that does not exist too — never a 404 that
  enumerates routes. `/health` is the only public path.
- **One rejection shape.** 401 and 429 bodies are the same bytes; a 403 on `/approvals` uses
  the same text as an unknown `callId`, so a caller cannot learn whether a call is pending.
- **Static before auth, but never credentials.** The shell must be reachable to render a login
  page; a `?token=` request is never answered by the static handler, and every read is confined
  to the real web root (dot segments, backslashes, NULs, protocol-relative paths and out-of-root
  symlinks are refused).
- **Origin is the CSRF boundary, and it is host equality.** Different localhost ports are
  same-site, so `SameSite=Strict` alone would let a page on another local port drive the API
  with the user's cookie. Same-origin means `Origin`'s host equals `Host` after URL parsing.
- **The posture is stated, never inferred.** `mode`, `--trust-proxy` and a non-loopback bind
  are fixed at startup; no request can flip them.
- **One client per session.** A second `/events` connection displaces the first, and the
  displaced client's pending approvals are denied as `connection-lost`.
- **One turn per session.** The latch is claimed in a synchronous span; a message arriving
  mid-turn is steered, never rejected and never run concurrently.
- **A turn needs a listener.** `POST /messages` answers 409 without a live `/events`
  connection, because the response body is only an ack.
- **Approvals are one-shot and fail closed.** No gateway timeout (hang visibly), deny on
  disconnect, deny on interrupt, and a decision requires the connection's own token.
- **The event stream is the transcript.** `event` frames are the persisted events verbatim;
  deltas are decorative and replayable state is only what is in the buffer.
- **Capability facts, not wishes.** `nativeDialogs` follows the mode; `browserAutomation`
  follows whether a browser host was actually constructed; `lsp` follows whether any server is
  configured. `GET /gateway-info` and the route gates read the same `capabilities` object.
- **Body cap.** 1 MiB for every JSON route, ~5 MiB for attachment upload; both answer 413 and
  close the connection after flushing.

## Decisions and rejected alternatives (with dates)

- **2026-08-31 — the SSE protocol** (`web-app-sse-design`). Constant source, no optimistic
  rendering, tool/approval state derived from one event stream. Its original nine named frame
  types (`token`, `tool_call`, `tool_result`, `approval_req`, …) were later replaced by protocol
  v2's `event`/`delta`/`heartbeat`/`error` plus `connected`: a transcript event and a delta are
  the only payloads, and one projection serves live and stored data.
- **2026-09-02 — native directory picker** (`native-directory-picker-design`). Rejected
  `GET /fs/list`: an enumerable listing is a passive filesystem reconnaissance surface, while a
  native dialog leaks nothing until a human confirms. The spec also removed the typed-path
  fallback entirely; the code has since reintroduced one, but only for `nativeDialogs: false`
  (remote mode, 2026-11-12 D11), because a remote caller cannot see the host's dialog.
- **2026-09-09 — gateway authentication** (`gateway-auth` plan,
  `security-architecture-analysis` spec). Rejected "loopback means trusted": a sandboxed `bash`
  the model controls can reach the port. Chose launch token → HMAC-signed
  `HttpOnly; SameSite=Strict` cookie, bearer for scripts, same-origin via a proxy, uniform 401,
  arithmetic rate limiting, and credential isolation (sandbox denies reads of the config dir,
  secret-shaped env vars stripped). The same review rejected R2's "sandbox blocks
  `POST /approvals`" in favour of the per-connection token, which is what the code still does.
- **2026-11-12 — release shape** (`standalone-sdk-gateway-web-design`,
  `release-0.1-sdk-gateway-web` plan). Chose one process on one port with the gateway serving
  the exported UI (A) over a second Next server (B) or a cross-origin split (C); dropped the
  `/gateway` prefix from the protocol (it survives only as the dev rewrite); dual credentials;
  tunnel-first remote access with no built-in TLS/ACME; one subscriber per session;
  `npx`-first packaging. Cross-origin web stays a degradation mode behind `Bearer` — the
  one-time `POST /stream-tickets` endpoint from that spec was never built.
- **Reversals recorded rather than honoured.** The spec's `GET /health` shape was
  `{ ok, version }`; the code returns `{ status: "ok" }`. The runtime config file was planned as
  `/volto-config.json` and is served as the script `/volto-config.js` so it can load
  synchronously in `<head>`. And the spec's P6 ("delete the desktop agent, load the gateway URL")
  has not happened: `apps/desktop-app/src/main/agent/**` still builds agents in-process.

## How to change it (tests to run, contract impact)

Run the package's own gates —
`pnpm turbo run typecheck lint test --filter @voltojs/gateway` — plus
`--filter @voltojs/sdk` when the frame types or `formatSSEFrame` change, and
`--filter @voltojs/web` when a route shape changes. `@voltojs/desktop-app` is excluded by
policy: it has no test script, and its `typecheck` is `tsc -b --noEmit --force`.

Where the existing coverage lives, by change:

| Change | Tests that must move with it |
| --- | --- |
| A new route or status code | `apps/gateway/src/__tests__/server.test.ts`; add the route to `docs/user/reference/gateway-notes.json` or `pnpm docs:check` fails |
| SSE framing, replay, heartbeats | `apps/gateway/src/__tests__/server.test.ts`, `session-tail.test.ts`, `packages/sdk/src/sse/__tests__/` |
| Auth, cookies, rotation, limiter | `apps/gateway/src/auth/__tests__/browser-auth.test.ts`, `middleware.test.ts`, `__tests__/auth-rate-limit-e2e.test.ts`, `query-token-endpoint.test.ts`, `client-ip.test.ts`, `cors.test.ts` |
| Remote posture / capabilities | `__tests__/capabilities.test.ts`, `directory-picker.test.ts`, `server.test.ts` |
| Static hosting / `volto web` proxy | `__tests__/static-site.test.ts`, `web-server.test.ts`, `copy-web-assets.test.ts` |
| Session lifecycle, approvals, steering | `__tests__/session-*.test.ts`, `approval-gate.test.ts`, `steering-gateway.test.ts`, `queue-route.test.ts`, `permission-modes.test.ts` |
| Desktop gate or IPC | none — verify by running `pnpm --filter @voltojs/desktop-app build` and exercising the dialog manually |

Contract impact to check before merging:

- `API_PREFIXES` (`src/web-server.ts`) is the single list static hosting, `volto web` and the
  WebSocket tunnel all key on. A new API root that is missing from it is swallowed by the static
  handler and served as the app shell, in both the gateway and the proxy.
- `resolveCapabilities` is the only producer of the published flags. A route that gates on a
  capability must read the same object, or `/gateway-info` and the route will disagree.
- The generated `docs/user/integrating/reference/gateway-api.md` is built from the literal
  `url.pathname` matches in `server.ts` only. `/attachments`, `/ws` and the static
  `/volto-config.js` do not appear there even though they exist; a route handled inside a
  helper module needs a notes entry (or a generator change) to become part of the contract.
- Anything that changes the wire means the SSE types in `packages/sdk/src/sse/types.ts` and
  `apps/web/lib/agent-config.ts` change in the same commit; `@voltojs/sdk/sse` is the shared
  contract, and the desktop host does not consume it.

## Further reading (archive links)

- ``2026-08-31-web-app-sse-design.md`` — why one event stream carries deltas, tool calls and approvals.
- ``2026-09-02-native-directory-picker-design.md`` — why the picker runs on the gateway, and why enumeration was rejected.
- ``2026-09-09-gateway-auth.md`` — the token/cookie design and the credential-isolation work that came with it.
- ``2026-09-09-security-architecture-analysis.md`` — the trust-boundary argument, the per-connection approval token and its residual risk.
- ``2026-11-12-standalone-sdk-gateway-web-design.md`` — deployment topology, CLI shape, capabilities and remote posture.
- ``2026-11-12-release-0.1-sdk-gateway-web.md`` — the task breakdown behind static hosting, the CLI and `volto web`.
- Current contract: [Gateway HTTP API](../user/integrating/reference/gateway-api.md).
- Sibling pages: [architecture.md](architecture.md), [context-and-compaction.md](context-and-compaction.md), [docs-system.md](docs-system.md); the full index is [docs/dev/README.md](README.md).