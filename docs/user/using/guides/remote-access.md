---
title: Remote access
type: guide
source:
  - apps/gateway/src/cli.ts
  - apps/gateway/src/auth/access-token.ts
  - apps/gateway/src/auth/middleware.ts
  - apps/gateway/src/client-ip.ts
  - apps/gateway/src/capabilities.ts
  - apps/gateway/src/web-server.ts
generated: false
verified: 2026-11-13
---

# Remote access

> After reading: connect to the volto running on your own machine from a phone or another computer, and be clear about what this step hands over.

## Read this first

**Anyone who can reach the gateway can run commands on this machine.** On the other end of the gateway is an agent that can read and write files and execute a shell, and it has no "just show me" mode. So:

- Run it on a machine that is **dedicated, or that you can discard entirely**.
- **Do not put credentials on that machine that you would not hand to anyone who can open that URL**: SSH private keys, cloud accounts, production database passwords, browser login state.
- Use an address others cannot guess (the random subdomain a tunnel gives you exists for exactly this).

## Choose an approach

| Approach | Good for | Extra process? | Extra command? |
| --- | --- | --- | --- |
| **Tunnel** (recommended) | Phone, public internet, across networks | No | Yes: one more tunnel process |
| Direct LAN | Same Wi-Fi, you trust this network | No | No |
| SSH port forwarding | The gateway is on a remote machine and you only use a browser locally | No | Yes: forward on your own computer |

Shared prerequisite: first start the gateway on that machine following [Install and start](../tutorial/01-install.md) (that machine also needs the `@voltojs` registry and token configured, otherwise `npx @voltojs/gateway` will not install), and keep the gateway running in its own terminal.

### 1. Tunnel (recommended)

Keep the gateway on the default `127.0.0.1` listener and let the tunnel process forward it. Pick one of three.

**cloudflared** (free; you get a temporary random domain without an account):

```bash
cloudflared tunnel --url http://127.0.0.1:3100
```

You should see it print an address like `https://<random words>.trycloudflare.com`. When opening it from your phone, **switch to the tunnel domain and include the token**:

```text
https://<random words>.trycloudflare.com/?token=<volto token>
```

Where the token comes from is covered below in "Rotating the token and signing in" (it should be treated as a one-time credential, and you should assume it stays in the tunnel's request logs). The temporary domain changes every time `cloudflared` restarts; for a fixed domain you need to create a named tunnel with your own Cloudflare account.

**tailscale serve** (the least work when the device is already in your tailnet):

```bash
tailscale serve --bg 3100
```

You should see it report a forward from `https://<machine name>.<your tailnet>.ts.net` → `http://127.0.0.1:3100`. A device with Tailscale installed on the same tailnet opens it directly:

```text
https://<machine name>.<your tailnet>.ts.net/?token=<volto token>
```

`tailscale serve` is open only to your own tailnet and does not go over the public internet.

**Caddy** (when you have your own server and domain):

```caddyfile
volto.example.com {
	reverse_proxy 127.0.0.1:3100
}
```

After `caddy run`, open `https://volto.example.com/?token=<volto token>`.

The tunnel terminates HTTPS in front of the gateway, so what the gateway itself sees is plaintext HTTP. To make rate limiting count by real client and to mark cookies `Secure`, add `--trust-proxy`:

```bash
npx @voltojs/gateway --trust-proxy
```

Only turn this on when you are **sure the gateway is unreachable except through this tunnel layer**: with it on, the gateway trusts `X-Forwarded-For` / `X-Forwarded-Proto`, and anyone can forge those two headers (see below).

### 2. Direct LAN

When you are on the same subnet and trust the network this machine is on, you can let the gateway listen externally:

```bash
npx @voltojs/gateway --serve-remote --host 0.0.0.0
```

Without `--serve-remote` it refuses to start outright:

```text
Refusing to bind to non-loopback host "0.0.0.0" without --serve-remote. The gateway exposes this machine's filesystem and an arbitrary-command agent.
```

Then open `http://<this machine's LAN IP>:3100/?token=<volto token>` from another device. There is no HTTPS on this path, and cookies do not carry `Secure`.

### 3. SSH port forwarding

When the gateway is on a remote machine and you only want to use it from your local browser, do **not** enable `--serve-remote`; forward the port instead:

```bash
ssh -N -L 3100:127.0.0.1:3100 you@dev-box
```

Then open `http://127.0.0.1:3100/?token=<volto token>` locally (print the token on the remote machine with `volto token` and copy it over). The gateway itself is still in local mode, so native dialogs work as usual — they just open on the **remote machine's** screen.

## What `--serve-remote` actually changes

It is an explicit switch, not something guessed from the listen address:

- **Allows listening externally**: a non-loopback `--host` refuses to start without it and is allowed only with it.
- **Enters remote mode**: `mode` in `GET /gateway-info` becomes `remote`, and startup prints one extra line to stderr.
- **Turns off native dialogs**: `POST /fs/pick-directory` (pick a directory) and `POST /fs/reveal` (show in the file manager) return 501 (this capability is unavailable on this instance). The reason is that such windows open on the screen of **the gateway machine**, and whoever clicks for you would be the person sitting in front of that machine.
- **It adds no encryption and creates no tunnel**: "allow external" is all it does; to reach the public internet you still need a tunnel or a reverse proxy.

**Adding a workspace in remote mode**: "Add workspace" discovers that this gateway cannot open a system directory dialog (`capabilities.nativeDialogs` is `false` in `GET /gateway-info`) and instead asks you to enter an absolute path directly — a path on **the gateway machine**. You can also register it through the API, and it can be picked from the dropdown after a page refresh:

```bash
curl -X POST http://127.0.0.1:3100/projects \
  -H "Authorization: Bearer <volto token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"myrepo","path":"/home/me/myrepo"}'
```

`path` is resolved on **the gateway machine** — write a path on it, not a path on your own computer.

## Rotating the token and signing in

The gateway accepts two credentials:

| Credential | Where it comes from | How long it lives |
| --- | --- | --- |
| Startup token | The string in the `Open:` link printed at each start | As long as the process lives; a restart issues a new one |
| Persistent token | Stored in `~/.volto/access-token`, or in the `--config-dir` directory when `~/.volto` is not the default | Unchanged until you rotate it |

Use the persistent token in remote scenarios — restarting the gateway does not invalidate it:

```bash
npx @voltojs/gateway token
```

You should see two lines: the token itself, then an `Open: http://<address>/?token=<token>` sign-in link. **Replace the address inside it with your tunnel domain** before opening it, and you can sign in.

After a successful sign-in the token is exchanged for a cookie (valid for 7 days) and the address bar returns to the clean page — `token=` is removed from the address and the other parameters are kept as they were.

There are two things to remember about the `?token=` form:

- **One-time**: it only takes effect when the browser opens the page (one address-bar navigation); after the exchange for a cookie, the same link is no longer needed. If an already signed-in browser opens an address with a token, it is redirected to the same page with `token` removed, without exchanging a new cookie.
- **Assume it ended up in the tunnel's request logs**: the URL is part of the request, and processes such as cloudflared / ngrok / Caddy usually log the full URL. So treat this link like a password — **do not let it appear in someone else's terminal, chat log or ticket**. For everyday sign-in use the `Login:` link printed by `volto token`, or simply a browser that is already signed in; if you suspect a log leak, rotate with `volto token --rotate`.

If you suspect the token leaked, rotate it:

```bash
npx @voltojs/gateway token --rotate
```

It prints the new token and **immediately** invalidates every cookie already issued — the gateway keeps running, no restart needed. An already signed-in browser is asked to sign in again on its next API call; sign in again with the new link.

## `--trust-proxy` and `VOLTO_CORS_ORIGINS`

**`--trust-proxy`** makes the gateway trust the headers forwarded by the proxy in front of it, and governs two things:

- Failed sign-in attempts are counted by the first segment of `X-Forwarded-For`, not by the address that connected.
- When a request arrives with `X-Forwarded-Proto: https`, cookies carry `Secure`.

Off by default. When it is off, every request coming in through a tunnel looks like the same local address to the gateway: the attempt limit is one budget shared by everyone, but nobody can forge forwarding headers to bypass it or crowd others out. Coarser granularity in exchange for values that cannot be faked.

Do not enable it when the gateway is exposed to the network **directly** (no proxy in front): then anyone can supply those two headers themselves, which amounts to turning rate limiting off.

**`VOLTO_CORS_ORIGINS`** is only needed when the browser UI's origin differs from the gateway's (developing the frontend with `next dev`, or serving the UI directly from the gateway while the tunnel domain is a different origin from the gateway). With the `volto web` approach below, the UI and the forwarding share one origin, so it is not needed. Comma-separated; set it before starting the gateway:

```bash
VOLTO_CORS_ORIGINS="https://volto.example.com,http://localhost:6100" npx @voltojs/gateway
```

Browser origins not on the list get a 403. Same-origin requests do not need it. By default the gateway recognizes only one development origin: `http://localhost:6100`.

## Running a second frontend (optional)

When you want to expose only the **UI** and keep the API port local, use `volto web`: a static UI plus an API forwarding layer, with a single origin facing outward.

```bash
# Terminal 1: the gateway as usual, listening only on localhost
npx @voltojs/gateway
# Terminal 2: the UI on 6100, forwarding the API to 3100
npx @voltojs/gateway web --port 6100 --gateway http://127.0.0.1:3100
```

`volto web` prints three lines — the first two have the same shape as the two lines from gateway `serve`, and the third, `Login:`, is the address that signs you in directly (it already carries the persistent token):

```text
volto web 0.0.1 listening on http://127.0.0.1:6100 -> http://127.0.0.1:3100
Open: http://127.0.0.1:6100/
Login: http://127.0.0.1:6100/?token=…
```

Point the tunnel at 6100 rather than 3100: `/?token=…` is forwarded to the gateway and exchanged for a cookie, the cookie lands on the 6100 origin, and every API call in the page carries it from then on.

The token in `Login:` comes from **the `volto web` process's own configuration directory**. If the gateway uses a different directory (both default to `~/.volto`, so they agree unless you changed it), it refuses this token. So on the first run of `volto web`, when it has to create a token in that directory, it tells you on stderr: that `Login:` link is only valid when the gateway is started with the same `--config-dir`.

When the UI build is not in the default location, use `--web-dir` (when building from source it is `apps/web/out`):

```bash
npx @voltojs/gateway web --port 6100 --web-dir apps/web/out
```

`--host` follows the same rule as the gateway: a non-loopback address requires `--serve-remote`.

## Known limitations

Saying this up front saves you from finding out the hard way:

- **A session serves one browser connection at a time.** Opening the same session in a second tab or on a second device displaces the earlier connection; approvals still pending at that moment are denied as "connection lost" (not allowed by default), and that turn does not continue. Close the old one before switching devices.
- **Remote mode has no native dialogs.** Picking a directory and revealing in the file manager both return 501; adding a workspace switches to entering a path (see "Adding a workspace in remote mode" above), and can also be done through the API.
- **Remote mode does not open a browser automatically.** The printed `Open:` link still works; it just does not pop a browser for you.
- **You cannot see the agent's browser.** Browser tools run on the gateway machine, headless in the background by default, and there is no pane for them in the UI (see [Testing web pages with a browser](./browser-testing.md)). "Watching it click" only makes sense when someone is in front of the machine: setting `headless` to `false` pops a window, but the window opens on **that machine's** screen, which you cannot see over remote access; do not turn it on if nobody is there.
- **`volto web` is a forwarding layer, not an isolation layer.** The API you can reach through it is exactly the same as connecting to the gateway directly; do not treat it as a "read-only frontend".
- **The gateway machine is effectively granted execution rights.** That is the paragraph at the top.

## When something goes wrong

- **Page 401** → sign in again with the link printed by `npx @voltojs/gateway token` (replace the domain with the tunnel domain). If the gateway has restarted, the startup token in the earlier `Open:` link has already expired.
- **403 when sending a message after signing in** → the browser origin is not in `VOLTO_CORS_ORIGINS`; a tunnel + `volto web` deployment should not hit this, and if it does, the frontend and the gateway are not on the same origin.
- **Adding a workspace keeps failing** → in remote mode the system directory dialog is disabled: enter an absolute path on the gateway machine in "Add workspace by path", or register the path through the API.

More symptoms in [Troubleshooting](./troubleshooting.md).
