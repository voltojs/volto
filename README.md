# Volto

A coding agent that runs on your machine. The core (`@voltojs/core`) is a
zero-dependency, side-effect-free state machine — `step(state, input) → { state, effects[] }`.
Time, randomness and IDs are injected through ports, and real side effects are executed
by a thin interpreter outside the core. Tools, model providers, runtimes (sandbox /
shell / filesystem), stores and hosts (gateway / web UI / desktop) are all pluggable.

## Quick start

Requires **Node ≥ 22** on macOS or Linux.

```bash
npx @voltojs/gateway
```

The gateway serves both the API and the Web UI. On start it prints two lines:

```text
volto gateway 0.0.1 listening on http://127.0.0.1:3100
Open: http://127.0.0.1:3100/?token=…
```

Open the `Open:` URL to sign in (the token is exchanged for a cookie, so
`http://127.0.0.1:3100/` works afterwards; paste the link manually when the browser does
not open). Then add a provider and API key under **Settings → Model configuration**, pick
a workspace, and start chatting.

There is also `volto web` (the UI on its own port, API forwarded to the gateway); it
prints a third `Login:` line with a persistent token.

- `npx @voltojs/gateway doctor` — check whether this machine can run it (Node version /
  sandbox / config directory / session store / port)
- `npx @voltojs/gateway token` — print the persistent token and login URL; `--rotate`
  invalidates browsers that are already signed in
- Use it from a phone or another computer: [remote access](docs/user/using/guides/remote-access.md)
- Step-by-step install, with "what you should see" for every step:
  [install and run](docs/user/using/tutorial/01-install.md)

## Documentation

| You are | Start here |
| --- | --- |
| **User** (install and go) | [User docs index](docs/user/README.md) — tutorials, permissions, sandbox, tools, config, troubleshooting |
| **Integrator** (embed the agent in your own host) | [Embed the agent](docs/user/integrating/tutorial/01-embed-agent.md) |
| **Contributor** | [AGENTS.md](AGENTS.md) — development rules, quality gates, repository layout |
| **Curious about the boundaries** | [User-facing safety model](docs/user/concepts/safety-model.md) · [Full threat model](SAFETY.md) |

Platform support: macOS uses the built-in seatbelt sandbox; Linux requires `bubblewrap`.
On platforms without a sandbox backend (including Windows) the gateway refuses to start
instead of running unconfined. See
[sandbox and platform support](docs/user/using/guides/sandbox-and-platforms.md).

User-level data lives in `~/.volto/`: configuration in `config.json` (see the
[configuration reference](docs/user/using/reference/config.md)); session stores,
attachments, agents and skills have their own directories.

## Development

```bash
pnpm install
pnpm turbo run build
pnpm turbo run typecheck    # type check
pnpm turbo run lint         # lint (includes core zero-dependency / purity rules)
pnpm turbo run test         # tests (vitest)
pnpm docs:check             # user-docs gate (links / generated pages / surface drift)
```

pnpm workspace + Turborepo: `packages/` (core · sdk · tools · providers · runtimes ·
stores · eval · embedders · memories) + `apps/` (gateway · web · desktop-app).

Two rules cut across the repository: `packages/core/` performs no I/O and no side
effects; dependencies point in one direction
(`core ← tools/providers/runtimes/stores ← sdk ← apps`). Details and architecture docs are
indexed in [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).