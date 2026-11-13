# Documentation

This repository has three kinds of documents, with different audiences and freshness
guarantees.

## User documentation — `docs/user/`

For people who install volto and for integrators who embed `@voltojs/sdk` in their own
host. It explains **how to use it**, not why it is built this way.

- Start at [docs/user/README.md](user/README.md).
- The writing rules (two tracks: `using/` and `integrating/`) are in
  [docs/user/WRITING.md](user/WRITING.md).
- Reference pages under `using/reference/` and `integrating/reference/` are generated from
  code and notes JSON by `pnpm docs:gen`. Do not edit them by hand.
- `pnpm docs:check` is the gate: links, generated pages, orphan pages, surface drift and
  TypeScript examples must all pass.

## Contributor and architecture documentation

- [AGENTS.md](../AGENTS.md) — development rules, quality gates, repository layout, coding
  conventions. Read this before changing code.
- [docs/pure-agent-core.md](pure-agent-core.md) — the pure-kernel architecture and port
  contracts.
- [SAFETY.md](../SAFETY.md) — the threat model and the actual strength of the security
  boundaries.

## Historical design records — `docs/archive/` and `docs/superpowers/`

Per-feature specs, implementation plans and self-test reports record **decisions made at a
point in time**. They are not maintained and may describe behavior that no longer exists.
Use them to understand why something was built, never as a description of what the code
does now.

- `docs/superpowers/` — the original flat archive of specs and plans.
- `docs/archive/` — frozen documents, including internal roadmaps.

The code, the tests and the user documentation are the sources of truth.