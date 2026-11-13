---
title: Troubleshooting
type: guide
source:
  - apps/gateway/src/server.ts
  - apps/gateway/src/config/store.ts
  - apps/web/lib/sse-client.ts
generated: false
verified: 2026-11-12
---

# Troubleshooting

> After reading: find the cause from the symptom instead of guessing.

## Startup phase

| Symptom | Cause | Action |
| --- | --- | --- |
| `Cannot find module .../dist/server.js` | Running from source but never built | `pnpm turbo run build` |
| Startup log shows `[sandbox] No sandbox backend available on this platform` | No backend on this platform, or Linux is missing `bwrap` | On Linux install `bwrap` and restart; Windows has no fix right now (the gateway's default mode requires isolation) |
| Configuration corruption reported at startup | `config.json` has a syntax error or a misspelled field name | Fix `~/.volto/config.json`; a broken file is refused rather than ignored |
| Error `Could not listen on 127.0.0.1:3100: EADDRINUSE` | The port (default 3100) is held by an old process. In this case those two startup lines are **not printed**, standard output is empty, and the exit code is 1 | Stop the old process, or use another port |

## Sign-in and connection

| Symptom | Cause | Action |
| --- | --- | --- |
| The page keeps redirecting to login / always 401 | No cookie, and the address you opened has no `token=` | Use the `Open:` link from startup, or the link printed by `npx @voltojs/gateway token`; old links from before a restart no longer work |
| Cannot get back in after the gateway restarts | The startup token changes on every restart (the persistent token does not) | Use the newly printed link, or `npx @voltojs/gateway token` |
| Sending a message does nothing | The SSE stream dropped, or the same session is open in another tab / on another device (a session serves one connection at a time) | Close the extra tabs and refresh; turns from the disconnected period must be sent again |
| The approval card stays "waiting" | The connection to the gateway dropped | Refresh and send the request again |

## Conversation phase

| Symptom | Cause | Action |
| --- | --- | --- |
| The model reports 401 / 403 | Key invalid or permission insufficient | Click "Test route" in "Settings → Models" |
| The model reports 404 / model does not exist | The custom provider's model ID is misspelled | Check the ID; or try another model from the built-in catalog |
| The reply is truncated | `maxOutputTokens` is too small | Raise that model's output limit |
| The context usage bar fills up quickly | `contextWindow` is set too small, or the task really is long | Set the window size correctly; compact with `/compact` |
| A tool call is refused, reporting `Operation not permitted` | The sandbox is blocking according to the mode | Switch modes or directories, see [Sandbox and platforms](./sandbox-and-platforms.md) |
| A tool call is refused, reporting 403 + a hostname | The network egress list blocked it | Change `allowHosts` in the `egress` section |
| A language server call reports `LSP_SERVER_MISSING` | `typescript-language-server` is not installed | `npm install -g typescript-language-server typescript` |

## Where the data lives

All runtime data lives in `~/.volto/`:

- `config.json`: user-level configuration (providers, permissions, routing, hooks, LSP, egress, preferences)
- `key` / `auth-secret`: encryption keys, **do not delete them** — delete them and the stored keys can no longer be decrypted
- session store, attachments, agents, skills: each in its own directory
- `audit.jsonl`: audit log

To reset everything: rename `config.json` as a backup and restart to get back to the default configuration (if the old per-section config files exist, they are read again). **Do not** delete the whole `~/.volto` directory — that loses the session history along with it.
