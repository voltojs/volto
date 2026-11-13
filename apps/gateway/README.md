# @voltojs/gateway

The gateway for [volto](https://github.com/voltojs/volto): it hosts the agent
runtime (sandboxed shell, file system, tools), serves the Web UI, and exposes
everything over HTTP + SSE so the UI, the SDK and scripts talk to one process.

This README covers the package itself — how to run it, what it writes where,
and what ships in the tarball. How to *use* volto (tutorials, permissions,
remote access, tools, configuration) lives in the user docs:
[docs/user](https://github.com/voltojs/volto/tree/main/docs/user) — start with
[install and run](https://github.com/voltojs/volto/blob/main/docs/user/using/tutorial/01-install.md)
and [remote access](https://github.com/voltojs/volto/blob/main/docs/user/using/guides/remote-access.md).

## Run it

The packages are published to GitHub Packages (`https://npm.pkg.github.com`),
not npmjs.com, and are **private by default**. `npx` resolves `@voltojs` through
your own `.npmrc`, so configure it once — a GitHub personal access token
(classic) with `read:packages`, and a scope pointing at GitHub Packages:

```bash
export GITHUB_NPM_AUTH_TOKEN=ghp_xxxxxxxx     # in ~/.zshrc
```

```text
# ~/.npmrc
@voltojs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_NPM_AUTH_TOKEN}
```

Keep the token out of any project `.npmrc`: it takes precedence over `~/.npmrc` and would mask it with an empty value. `npm whoami --registry=https://npm.pkg.github.com` confirms the credential. CI uses `NODE_AUTH_TOKEN` instead (written by `setup-node` — see [publishing and installing](https://github.com/voltojs/volto/blob/main/docs/user/integrating/guides/publishing.md)).
Without it `npx` looks on npmjs.com and fails with `404`. See
[publishing and installing](https://github.com/voltojs/volto/blob/main/docs/user/integrating/guides/publishing.md).

```bash
npx @voltojs/gateway          # gateway + Web UI on http://127.0.0.1:3100
```

Requires **Node ≥ 22** on macOS or Linux. A platform without a sandbox backend
(Windows included) is refused at startup rather than run unconfined — see
[sandbox and platforms](https://github.com/voltojs/volto/blob/main/docs/user/using/guides/sandbox-and-platforms.md).

`serve` (the default command) prints exactly two lines on stdout, a contract a
script can parse:

```text
volto gateway 0.1.0 listening on http://127.0.0.1:3100
Open: http://127.0.0.1:3100/?token=…
```

Anything else — including a bind failure — goes to stderr, and a bind that
never happened prints none of those lines.

## Commands

| Command | What it does |
| --- | --- |
| `volto` / `volto serve` | Start the gateway and serve the Web UI |
| `volto token` | Print the persistent access token and its login URL |
| `volto token --rotate` | Replace the token; invalidates every issued cookie immediately |
| `volto doctor` | Check Node, the sandbox backend and binary, the config dir, the session store and the port |
| `volto web` | Serve the exported UI on its own port and proxy API routes to a gateway |

## Flags

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port to listen on (default `3100`; `0` = system-assigned) |
| `--host <addr>` | Interface to bind (default `127.0.0.1`) |
| `--serve-remote` | Remote mode: allows a non-loopback `--host`, requires the access token, withdraws the native dialogs |
| `--trust-proxy` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` — only behind a tunnel you control |
| `--config-dir <p>` | Config directory (default `~/.volto`) |
| `--web-dir <p>` | Web build directory (default: the `web/` shipped beside `dist/`) |
| `--open` / `--no-open` | Open the authenticated URL in a browser (default: on in local mode) |
| `--gateway <url>` | `web` only: the gateway to proxy API routes to (default `http://127.0.0.1:3100`) |
| `--help`, `-h` | Print usage |

`volto web` prints **three** lines: the two above plus a `Login:` URL carrying
the persistent access token. That token is read from (or created in) the config
directory of the `volto web` process, so the `Login:` link only works when the
gateway accepts a token from the same directory — i.e. when both run with the
same `--config-dir`. When the token had to be created, `volto web` says so on
stderr.

## What it writes

Everything is per config directory: `~/.volto` unless `--config-dir` (or
`VOLTO_CONFIG_DIR`) says otherwise. A token belongs to the directory it was
created in; that is why a `Login:` URL from one directory is refused by a
gateway started with another.

| Path | Contents |
| --- | --- |
| `<config-dir>/access-token` | The persistent access token (`0600`), created on first use; `volto token` prints it |
| `<config-dir>/auth-secret` | Cookie signing secret (`0600`), created on first use |
| `<config-dir>/config.json` | Providers and models (API keys encrypted), tool settings, browser settings |
| `<config-dir>/projects.json`, `providers.json`, … | One file per settings section |
| `<config-dir>/sessions/` | Session transcripts (the single source of truth for a session) |

The launch token printed in `Open:` is **not** written anywhere: it is fresh per
process and dies with the process. The access token is the one that survives a
restart, which is why it is the credential for remote access.

## Security posture in one paragraph

Reaching the gateway means reaching an agent that can read and write files and
run shell commands on that machine. Without `--serve-remote` it refuses a
non-loopback bind. In remote mode the native dialogs (`/fs/pick-directory`,
`/fs/reveal`) answer `501 capability_unavailable` and every route requires the
access token; authentication failures are rate limited per client. It adds no
encryption and opens no tunnel of its own — put it behind one, and read
[remote access](https://github.com/voltojs/volto/blob/main/docs/user/using/guides/remote-access.md)
first. The full threat model is in
[SAFETY.md](https://github.com/voltojs/volto/blob/main/SAFETY.md).

## What the tarball contains

`dist/` (the compiled gateway, with neither `__tests__` nor any compiled
`*.test.*`), `web/` (the exported UI), `README.md`, `LICENSE` and
`package.json` — `files` is `["dist", "web", "README.md",
"!dist/**/__tests__", "!dist/**/*.test.*"]`. In the monorepo `pnpm --filter
@voltojs/gateway web:export` builds the export and stages it into `web/` (the
`copy-web-assets.mjs` step wrapping `@voltojs/web build`); a published tarball
already contains it. `pnpm pack` does NOT build or copy anything, so what is on
disk is exactly what ships. The one server entry is `dist/server.js` (`bin` →
`dist/bin.js`).