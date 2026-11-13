---
title: Network egress list
type: guide
source:
  - apps/gateway/src/config/egress.ts
  - packages/runtimes/node/src/egress.ts
generated: false
verified: 2026-11-11
---

# Network egress list

> After reading: know what this list governs and what it does not, and why it cannot serve as a firewall.

## Which three tools it governs

`egress` applies only to the **Network port**, and only three tools are wired to it today:

- `web_fetch`
- `web_search`
- `http_query`

## How to configure it

The `egress` section of `~/.volto/config.json`:

```json
{
  "egress": {
    "allowHosts": ["api.example.com", "docs.example.com"],
    "denyHosts": ["evil.example.net"]
  }
}
```

Rules:

- **Hostnames match exactly**, case-insensitive; **there are no wildcards** — writing `*.example.com` matches nothing, it is treated only as a literal hostname.
- **The deny list wins**: a host on both lists is refused.
- **Setting `allowHosts` switches to allow-list mode**: any host not on the list is refused. `"allowHosts": []` is a valid and meaningful value — refuse everything.
- Setting only `denyHosts` gives deny-list mode; other hosts are allowed.

## What you see when a request is refused

The request is never actually sent; the tool returns a structured error (HTTP 403 semantics) carrying the hostname. The model receives "refused by policy" and either tries another approach or tells you directly.

## When changes take effect

Re-read on every session construction, so changes **take effect for new sessions**; no gateway restart is needed.

A broken configuration (syntax error, `allowHost` missing an `s`, a non-string mixed into the list) **refuses to start** rather than silently allowing. This is intentional: silent failure is more dangerous than an error.

## What it does not cover

This section matters, because it determines whether you can use it as a backstop:

1. **The model's own network traffic does not go through it.** Model requests are sent by the provider adapter, unrelated to this list.
2. **Processes run inside `bash` bypass it entirely.** `curl`, `npm install`, `git push` are not constrained.
3. **It is not a system-level firewall.** To really restrict egress, do it at the container/network layer, not in the agent configuration.

In other words: **it constrains the single path "the agent actively goes online to look things up"**, not whether this machine can reach the internet.

## Networking inside the sandbox

If you enable sandbox isolation, the sandbox's own network settings also decide whether egress is allowed. To send the network tools through a proxy (TCP bridge) inside the isolated environment, `socat` must be present on the system; when it is missing there is an explicit warning rather than a silent downgrade.

## When something goes wrong

- **A host that clearly exists is refused** → check whether allow-list mode is on, and whether the hostname includes a path (only the host goes here, without `https://`).
- **Changed the configuration but nothing changed** → it only applies to new sessions; start a new session.
- **The gateway will not start, reporting an egress configuration error** → fix the JSON; the error names the key and the problem.
