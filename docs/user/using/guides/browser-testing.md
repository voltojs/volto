---
title: Testing web pages with a browser
type: guide
source:
  - packages/tools/src/browser
  - packages/runtimes/node/src/browser-host.ts
  - apps/gateway/src/config/browser.ts
verified: 2026-11-12
generated: false
---

# Testing web pages with a browser

> After reading: let the agent open a web page itself, walk through login/form flows, read console and network failures, and turn the repeatable parts into Playwright tests.

The built-in browser is an **internal capability** of the agent: there is no right-hand panel, and it does not share the login state of your everyday browser. It launches your local Chrome/Chromium/Edge on the machine where the gateway runs; by default it runs headless in the background and does not occupy your window. Set `headless` to `false` when you need to watch the page. The browser is **per turn**: it closes when a turn ends and reopens on the next turn.

## Prerequisites

- **No need to download Chromium into the repository**. Volto only uses `playwright-core` as the driver and launches the Chrome / Chromium / Edge already installed on your machine. It is recommended to set the path explicitly in `browser.executablePath` in `~/.volto/config.json`; when unset, common install locations are detected automatically.
- The gateway can reach the target address. When testing a local dev server, `localhost:5173` means **the machine where the gateway runs**, not another computer.

Minimal configuration (all optional):

```json
{
  "browser": {
    "enabled": true,
    "headless": true,
    "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "idleTimeoutMs": 600000,
    "storageStatePath": "~/.volto/browser/auth.json"
  }
}
```

## Choosing a browser in the settings page

1. Open **Settings → Tools**. The card shows "Gateway OS: macOS / Windows / Linux"; the candidate browsers come from **the machine where the gateway runs**, not the computer where you opened the settings page.
2. Under "Browser executable", pick an auto-detected Chrome / Chromium / Edge / Brave, or pick "Custom path" and enter the executable path manually.
3. Click "Save". The choice is written to `browser.executablePath` in `~/.volto/config.json`; picking "Auto-detect" removes that key and goes back to auto-detection.
4. **Restart the gateway.** Saving does not hot-switch a running browser host; the new path takes effect after a restart.

If the gateway is on a remote machine, the candidate list reflects that machine's system; do not fill in paths from your local machine.

## Steps

1. **Start the dev server first.** Tell the agent the port in the conversation, or let it start the server itself with `bash`. It should open the page with `browser_navigate` instead of guessing the API.
2. **Have the agent read the page before acting.** It should call `browser_snapshot` to get element refs, then act with `browser_click` / `browser_type`; after every action the tool returns a fresh snapshot. You can ask it to "first say which elements you see, then click".
3. **Check diagnostics first when something fails.** When the page does not respond or a button does nothing, have it call `browser_diagnostics`: `kind: "console"` for JS errors, `kind: "network"` for failed or 4xx/5xx requests. Diagnostics contain no response bodies.
4. **Take a screenshot when you need visual evidence.** `browser_screenshot` returns a PNG; the screenshot appears in the conversation transcript as a tool result; clicking the thumbnail opens the full image over a translucent full-screen overlay that supports wheel/button zoom, drag with the left button held down, and download. When the current model does not support image input, it suggests using `browser_snapshot { textOnly: true }` instead.
5. **Turn repeatable flows into tests.** Use the browser tools to explore; for regressions, have the agent write Playwright tests and run `pnpm exec playwright test` with `bash`. Do not treat the same manual click-through as a long-term test.
6. **Reuse the login state.** Have the agent log in once with a test account in the page, then call `browser_storage_state { action: "save" }`; cookies/localStorage are written to `storageStatePath` and loaded automatically by the browser in later sessions.

## You should see

- On first use, the machine where the gateway runs starts the browser in the background; a window appears only when `headless: false` is set explicitly. The browser closes automatically when a turn ends.
- The tool result is a page structure annotated with `[ref=eN]`, not just a sentence saying "clicked".
- In a failing flow, `browser_diagnostics` points at the concrete error or HTTP status.
- The file `storageStatePath` points at has `0600` permissions; it contains real login cookies, **do not commit it to git**.

## When something goes wrong

- **No browser_* in the tool list:** the gateway startup log says "browser tools disabled". Point `browser.executablePath` at the executable of your local Chrome/Chromium/Edge, then restart the gateway; the program does not download a browser automatically.
- **Startup fails on Linux/in containers:** do not set `"headless": false` explicitly (it forces a headed browser and fails); remove that field, set it to `true`, or provide `DISPLAY`.
- **Navigation is refused:** top-level navigation is subject to the egress list; check whether the target host is on the deny list, or whether the allow list is missing it (see [Network egress list](network-egress.md)). A refusal triggered by a click lands on the browser error page.
- **Stale ref:** old refs are unusable after the page changes; have the agent run `browser_snapshot` again; do not let it guess CSS selectors.

## Security boundaries

- The browser uses a clean context per session and does not read your everyday browser's cookies.
- Page content is **untrusted data**: the agent is instructed not to follow instructions found in the page.
- The egress policy only blocks top-level navigation; page subresources can still reach the network. Cloud metadata addresses are always refused.
- A saved storage state is a plaintext cookie file; use a test account, not a personal one.

## Related

- [Tool reference](../reference/tools.md)
- [Configuration reference](../reference/config.md)
- [Network egress list](network-egress.md)
- [Permissions and approvals](permissions-and-approvals.md)
