---
title: Install and start
type: tutorial
source:
  - apps/gateway/src/cli.ts
  - apps/gateway/src/bin.ts
  - apps/gateway/src/auth/browser-auth.ts
  - apps/gateway/src/config/paths.ts
generated: false
verified: 2026-11-13
---

# Install and start

> After reading: bring up the gateway and the Web UI with a single `npx` command, and sign in from the browser.

## Prerequisites

- **Node.js ≥ 22** (`node -v` to confirm; if it will not install, this is the item at fault and there will be no other error)
- **macOS or Linux**. Windows and other platforms without a sandbox backend currently **cannot start the gateway**: the default mode requires isolation, and a missing backend refuses to start outright (see [Sandbox and platforms](../guides/sandbox-and-platforms.md))

## Steps

### 1. Start

```bash
npx @voltojs/gateway
```

The first run downloads this package; wait a few seconds. The gateway **serves both the API and the Web UI**, so you do not need a second terminal, and you do not need to start the frontend separately.

You should see **only two lines**:

```text
volto gateway 0.0.1 listening on http://127.0.0.1:3100
Open: http://127.0.0.1:3100/?token=…
```

The version and port may differ from the above; the shape of the two lines does not change. A successful start prints only these two lines; every other message goes to the error output (stderr), so scripts can parse standard output safely.

These two lines are the output of the **default subcommand `serve`** (that is, no subcommand). `volto token` prints the token plus one `Open:` link, also two lines; `volto web` (see [Remote access](../guides/remote-access.md#running-a-second-frontend-optional)) prints **three lines** — the first two have the same shape as above, and the third, `Login:`, carries the persistent token.

When running locally it opens the `Open:` line in your default browser automatically; to stop that, add `--no-open`, and then that line is the address you paste into the browser manually.

### 2. Sign in

Paste the address after `Open:` into the browser (if it has already jumped to the chat UI, there is nothing to paste).

The `token=` in this address is a one-time credential: after opening, it is exchanged for a cookie and the address bar returns to a clean `/`; the token does not stay in the address bar.

You should see: the chat UI, an empty session list on the left, and the input box at the bottom of the window.

### 3. Confirm you are still signed in

Closing this terminal stops the gateway with it. When you reopen, run `npx @voltojs/gateway` again and **just open `http://127.0.0.1:3100/` in the browser** (without a token) — the cookie exchanged in the previous step is still there and valid for 7 days.

The `Open:` link printed by the newly started process also works at any time; it is another way to sign in.

## Common flags

```bash
npx @voltojs/gateway --port 3200            # use another port (the two printed lines change with it)
npx @voltojs/gateway --no-open              # do not open the browser automatically
npx @voltojs/gateway --config-dir /tmp/v    # use another configuration directory; default is ~/.volto
npx @voltojs/gateway --help                 # all flags
```

Subcommands are optional: without a subcommand it starts the gateway (equivalent to `volto serve`); there are also three subcommands, `token` / `doctor` / `web`. To check whether this machine can run it:

```bash
npx @voltojs/gateway doctor
```

It prints six checks line by line (`node version` / `sandbox backend` / `sandbox binary` / `config dir` / `sqlite` and the port), each with status `ok` / `warn` / `fail`. **It exits with code 1 only when a hard requirement is not met**; the port being taken or the session store falling back to file storage are only notices and do not affect startup.

## When you cannot sign in

- **The page is 401 or stays on the login screen** → the gateway restarted, and the old `token=` link is invalid (a new one is generated on every start). Use the `Open:` link printed by this start, or confirm the browser still has the cookie from the previous step.
- **`npx` reports `404 Not Found`** → the package name or version is wrong, or the npm network is unreachable. Check the spelling and the network, then retry; `npm view @voltojs/gateway version` confirms whether that version exists in the registry.
- **The terminal shows `Could not listen on 127.0.0.1:3100: EADDRINUSE`** → 3100 is already taken: stop the old process first, or use another port (see the port flag above). In this case the lines `volto gateway … listening on …` and `Open: …` are **not printed**, standard output is empty, only this one error appears, and the exit code is 1.
- **It exits right after startup and the terminal has no error covered by the points above** → run `npx @voltojs/gateway doctor` once; the hard requirement that fails is the cause.

For more symptoms see [Troubleshooting](../guides/troubleshooting.md).

## Running from source / for contributors

After cloning the repository (pnpm 10 required):

```bash
pnpm install
pnpm turbo run build
pnpm web:export                 # export the static Web UI
node apps/gateway/dist/bin.js
```

`pnpm web:export` only exports the UI to `apps/web/out`; the `web/` directory the gateway reads by default is produced only when packaging a release and is not in the repository. So running only the three commands above shows "UI not found" when you open the page. To make it serve the build you just exported, point `--web-dir` at it:

```bash
node apps/gateway/dist/bin.js --web-dir apps/web/out
```

The Web frontend and the gateway can also still run separately as before (the handiest setup when developing the frontend); their ports differ, so the gateway has to accept cross-origin requests from the frontend:

```bash
# Terminal 1: the gateway (by default it accepts the development origin http://localhost:6100; set it explicitly when you change ports)
VOLTO_CORS_ORIGINS=http://localhost:6100 node apps/gateway/dist/bin.js
# Terminal 2: the frontend dev server
cd apps/web && pnpm dev
```

The production shape of "the UI on one port and the API forwarded back to the gateway" uses `npx @voltojs/gateway web`, see [Remote access](../guides/remote-access.md#running-a-second-frontend-optional).

## Next steps

[Configure a model and start your first conversation](./02-first-conversation.md)

To reach it outside your own browser (phone, another computer, a tunnel), see [Remote access](../guides/remote-access.md).
