# Volto user documentation

Volto is a coding agent that runs on your machine: it reads your repository, edits files and runs commands, and it can stop and ask you at every step.

Pick a path based on who you are:

## I am a user (install it and go)

| # | Page | What you get |
| --- | --- | --- |
| 1 | [Install and start](using/tutorial/01-install.md) | The gateway + Web UI running, and you are signed in |
| 2 | [Configure a model and have your first conversation](using/tutorial/02-first-conversation.md) | A provider configured and one code change made by the agent |
| 3 | [Review changes, approvals and restoring a session](using/tutorial/03-review-changes.md) | You know what it changed and when it is waiting for you |

Common guides:

- [Models and providers](using/guides/models-and-providers.md) — configure keys, model capabilities, routing tiers
- [Workspaces and sessions](using/guides/workspace-and-sessions.md) — workspaces, recovering sessions, attachments, export
- [Permissions and approvals](using/guides/permissions-and-approvals.md) — the four permission modes, rules, one-click remember
- [Sandbox and platform support](using/guides/sandbox-and-platforms.md) — which platforms can isolate, and what it stops
- [Network egress allowlist](using/guides/network-egress.md) — limiting the agent's network access, and where that boundary lies
- [Subagents and background tasks](using/guides/subagents-and-tasks.md) — delegating work, narrowing permissions, custom types
- [Testing a web page with the browser](using/guides/browser-testing.md) — letting the agent click through pages itself, read the console / network, and reuse a test login state
- [Skills and MCP](using/guides/skills-and-mcp.md) — writing skills; where MCP works today
- [Code intelligence and databases](using/guides/lsp-and-database.md) — the language server and SQLite
- [Remote access](using/guides/remote-access.md) — tunnels, `--serve-remote`, rotating the token, serving the UI separately
- [Troubleshooting](using/guides/troubleshooting.md) — look up a cause by symptom

Lookup:

- [Tool reference](using/reference/tools.md) — which tools the agent can use
- [Configuration reference](using/reference/config.md) — every field of `~/.volto/config.json`
- [Slash commands and input tricks](using/reference/slash-commands.md) — `/plan` `/clear` `/compact` and `@` references

## I am an integrator (embed it in my own host with the SDK)

| # | Page | What you get |
| --- | --- | --- |
| 1 | [Embed the agent in your own host](integrating/tutorial/01-embed-agent.md) | A full turn working in thirty lines of code |

- [Ports and default implementations](integrating/guides/ports-and-defaults.md) — what you must wire yourself and what can stay default
- [Connecting a model](integrating/guides/model-provider.md) — implement ModelPort yourself, or decide whether an existing adapter is enough
- [Tool wiring and permission policy](integrating/guides/tools-and-policy.md) — the four-stage pipeline, visibility trimming, the approval gate
- [Event streams and the UI](integrating/guides/events-and-ui.md) — which events you can rely on, how to recover after a disconnect
- [Persistence and recovery](integrating/guides/persistence.md) — snapshots, transcripts, compaction and export
- [Sandbox and hooks](integrating/guides/sandbox-and-hooks.md) — whether isolation really takes effect, how to write hooks
- [Building your own host](integrating/guides/custom-host.md) — what the official gateway does, and how to assemble a minimal host
- [SDK guide](integrating/reference/sdk-api.md) — option categories, instance methods, the error contract
- [Tool contract](integrating/reference/tool-contract.md) — write a tool that can be dispatched correctly
- [SDK exports](integrating/reference/sdk-exports.md) — the complete list of public exports
- [Gateway HTTP API](integrating/reference/gateway-api.md) — the contract a custom frontend can integrate with
- [Publishing and installation](integrating/guides/publishing.md) — where packages are published, who can install them, how to ship a version

## I want the concepts first

- [What happens in a turn](concepts/how-a-turn-works.md)
- [Visibility and permission are two separate things](concepts/tools-and-permissions.md)
- [Why everything is injected through ports](concepts/determinism-and-ports.md)
- [Safety model (user edition)](concepts/safety-model.md)

## About this documentation

- **The writing rules** are in [WRITING.md](https://github.com/voltojs/volto/blob/main/docs/user/WRITING.md) (shared by humans and agents).
- The terms used across these pages are fixed in [GLOSSARY.md](GLOSSARY.md).
- The tools, config fields and gateway endpoints in the reference pages are generated from code by `pnpm docs:gen`, so they do not drift from the implementation.
- If a page disagrees with what the software does, that is a bug — `pnpm docs:check` should have caught it.
- Developer-facing documentation (architecture, design trade-offs, roadmap) lives in the contributor guide [AGENTS.md](https://github.com/voltojs/volto/blob/main/AGENTS.md) and the documentation map [docs/README.md](https://github.com/voltojs/volto/blob/main/docs/README.md); it is not meant for users.