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

## Module documentation — `docs/dev/`

Current implementation documentation, one page per module. Each page is verified against
the code and points at the archived specs and plans that explain the historical decisions.

- [docs/dev/README.md](dev/README.md) — index and writing rules.

## Internal design records

The historical specs, plans, reports and roadmaps are kept in the maintainers' working copy
under `docs/archive/` and are **not published**. They record decisions made at a point in
time and may describe behavior that no longer exists; current behavior lives in the code
and `docs/dev/`.

The code, the tests, `docs/user/` and `docs/dev/` are the sources of truth.
