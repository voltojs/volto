---
title: Gateway HTTP API
type: reference
generated: true
source:
  - apps/gateway/src/server.ts
verified: 2026-11-11
---
<!-- GENERATED FILE — do not edit by hand. Run `pnpm docs:gen`; hand edits are reported as drift by `pnpm docs:check`. -->

# Gateway HTTP API

The gateway (`apps/gateway`) is the official host: it wires the SDK to models, the sandbox and the filesystem, then exposes everything over HTTP + SSE to the Web UI and the desktop app.

**Public contract** means endpoints a custom host or an alternative frontend can rely on: paths, methods, authentication and response shapes stay backward compatible. You can also skip the gateway entirely and call `@voltojs/sdk` directly (see [Embed the agent](../tutorial/01-embed-agent.md)).

## Public contract

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/agents` | List of subagent definitions (the project / user / plugin sources merged). |
| `POST` | `/agents` | Create a subagent definition in the given scope. |
| `DELETE` | `/agents/*` | Delete a subagent definition; built-in types cannot be deleted (they can be overridden by the same name). |
| `PUT` | `/agents/*` | Replace a subagent definition; entries from plugin sources return 409. |
| `POST` | `/approvals` | Give allow / deny / an answer for a tool call awaiting approval. |
| `GET` | `/catalog/providers` | Built-in provider catalog for the "Add provider" form to choose from. |
| `GET` | `/commands` | List of slash command templates, the data source for the `/` panel. |
| `GET` | `/config/browser` | Browser settings of the system hosting the gateway: the current executablePath, the resolved result and the browsers already probed. |
| `PUT` | `/config/browser` | Write `executablePath` into config.json; null means delete it and go back to auto-detection. Requires a gateway restart to take effect. |
| `GET` | `/config/routing-tiers` | Model routing tier table; before the first write it is the factory template. |
| `PUT` | `/config/routing-tiers` | Replace the whole routing tier table; deleting a tier that is still referenced returns 409. |
| `GET` | `/events` | A session's long-lived SSE connection: model deltas, tool calls, approval requests and turn ends all come out of it. **A session serves only one connection at a time** — a new connection displaces the old one, and approvals still waiting at the moment of displacement are rejected as `connection-lost` (not allowed by default). |
| `GET` | `/gateway-info` | Mode and capability facts of this gateway instance: `mode` is `local` or `remote` (`remote` when started with `--serve-remote`). `capabilities.nativeDialogs`: whether this instance offers native directory picking and "reveal in file manager"; it is `false` in `remote` mode, and then any method on `/fs/pick-directory` and `/fs/reveal` returns `501 capability_unavailable` (not 404 — the route exists and the capability is withdrawn). `capabilities.browserAutomation`: whether a desktop browser automation host was actually created — Playwright driving the real local Chrome/Chromium for the browser tools; it is `false` when browser configuration is off or no executable is found ("having a browser" is not what this field means; the web client is itself a browser); `capabilities.lsp`: whether at least one language server is configured (`false` when `lsp.servers` is empty). Requires authentication. |
| `GET` | `/health` | Liveness check: whether the gateway process is ready. |
| `POST` | `/interrupt` | Cancel the turn currently in progress. |
| `POST` | `/messages` | Start one conversation turn; streaming events come back from that session's `GET /events`. |
| `POST` | `/messages/queue` | Edit or withdraw a queued message that has not reached the model yet. |
| `GET` | `/preferences` | Interface defaults: which permission tier and which language and theme the next conversation starts with. |
| `PUT` | `/preferences` | Merge the given keys into the defaults. |
| `GET` | `/projects` | List of registered workspaces. |
| `POST` | `/projects` | Register a workspace directory. |
| `DELETE` | `/projects/*` | Remove a workspace from the registry (the directory on disk is not touched). |
| `GET` | `/providers` | Configured model providers (keys only exist as ciphertext and are never returned in plaintext). |
| `POST` | `/providers` | Add a provider and its model list. |
| `DELETE` | `/providers/*` | Delete a provider and its model configuration. |
| `POST` | `/providers/*` | The single-action family for providers: currently `POST /providers/:id/probe` (really send one minimal request with the current configuration to verify the route works). |
| `PUT` | `/providers/*` | Replace a provider's configuration as a whole (the model list together with its overrides). |
| `POST` | `/resume` | Resume a suspended execution with a human decision (legacy interface). |
| `POST` | `/run` | Execute once and return the final state (legacy interface; use /messages for multiple turns). |
| `GET` | `/sessions` | Session list, used for session resume and the sidebar. |
| `DELETE` | `/sessions/*` | Delete a session and its transcript. |
| `GET` | `/sessions/*` | The read family for a single session: full transcript, trace, raw events, plan document, export. See the `/sessions/:id/...` comments in server.ts for the exact subpaths. |
| `PATCH` | `/sessions/*` | Rename a session (the title follows the last write). |
| `GET` | `/sidebar-state` | Sidebar layout document (pins, order). |
| `PUT` | `/sidebar-state` | Replace the whole sidebar layout document. |
| `GET` | `/skills` | Skill catalog (including skills the user can invoke directly). |
| `GET` | `/stream` | One-shot SSE that emits raw internal events (legacy interface). |
| `GET` | `/tools` | Tool catalog for ticking the tool scope when configuring a subagent. |

## Internal routes (follow the UI, no compatibility promise)

| Method | Path | Category |
| --- | --- | --- |
| `GET` | `/file-refs` | internal |
| `GET` | `/fs/file` | internal |
| `GET` | `/fs/search` | internal |
| `GET` | `/fs/tree` | internal |
| `GET` | `/git/branches` | internal |
| `GET` | `/git/graph` | internal |
| `GET` | `/git/summary` | internal |
| `POST` | `/fs/pick-directory` | internal |
| `POST` | `/fs/reveal` | internal |
| `POST` | `/git/branches` | internal |
| `POST` | `/git/checkout` | internal |

## Authentication and transport

- Everything except `/health` requires authentication: send `Authorization: Bearer <launchToken>`, or visit any path with `?token=<launchToken>` — the gateway exchanges it for a cookie and redirects to the clean path, so the token does not stay in the address bar.
- Request and response bodies are JSON; the streamed events of a turn come from the `GET /events` SSE connection (the client lives in `@voltojs/sdk/sse`).

> Generated by `pnpm docs:gen` from the routes in `server.ts`; purposes come from `docs/user/reference/gateway-notes.json`. Adding or removing a route makes `pnpm docs:check` fail until the notes are updated.
