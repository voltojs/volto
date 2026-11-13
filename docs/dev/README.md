# Module documentation

Current implementation documentation, one page per module. This is the place to look for
**why the code is built the way it is** and **what the current behavior is**. The user
documentation (`docs/user/`) explains how to use it; the archive (`docs/archive/`) records
the decisions as they were made.

Every page is verified against the code on its `verified` date. When a page and the code
disagree, the code wins — fix the page.

## Documents

| Page | Scope |
| --- | --- |
| [architecture.md](architecture.md) | The pure kernel, ports, Effect/Runner loop, dependency direction |
| [core-loop.md](core-loop.md) | Turn lifecycle, reducer, hooks, loop detection, timeouts |
| [context-and-compaction.md](context-and-compaction.md) | Context assembly, compaction, token counting, truncation and spill |
| [sessions-and-persistence.md](sessions-and-persistence.md) | Transcripts, stores, checkpoints, resume, export and fork |
| [tools-and-permissions.md](tools-and-permissions.md) | Tool contract, router, capability gating, permission policy and approval |
| [models-and-providers.md](models-and-providers.md) | ModelPort, providers, reasoning effort, model routing |
| [runtime-and-sandbox.md](runtime-and-sandbox.md) | Node runtime, sandbox backends, egress, LSP, database, browser |
| [gateway-and-hosts.md](gateway-and-hosts.md) | Gateway HTTP/SSE, auth, web and desktop hosts |
| [web-ui.md](web-ui.md) | The Next.js frontend: panes, trajectory, diffs, steering, i18n |
| [sdk-and-extensibility.md](sdk-and-extensibility.md) | SDK facade, plugins, subagents, orchestration |
| [observability-and-cost.md](observability-and-cost.md) | Events, cost accounting, debug views |
| [security.md](security.md) | Threat model, boundary implementation, known gaps |
| [docs-system.md](docs-system.md) | The documentation toolchain: generation, surfaces, checks |

## Writing rules

```markdown
---
title: Context and compaction
status: current
source:
  - packages/core/src/context/
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-03-context-assembler-content-layers-design.md
---

# Context and compaction

## Scope and where it sits
## Current behavior
## Invariants and boundaries
## Decisions and rejected alternatives
## How to change it
## Further reading
```

- `status` is `current` or `superseded`. Only `current` pages are meant to track the code.
- `source` lists the implementation paths the page describes, for drift detection.
- `supersedes` points at the archived specs/plans this page replaces; do not copy them.
- Rewrite for the current code. Do not translate or paste a spec: if a decision was
  overturned, describe the current rule and note the reversal in one sentence.
- Cite concrete files and symbols. "The runner retries" is not useful; name the function.
- Keep the page under 500 lines. If it grows, split by concept, not by file.

## Internal archive

Links and `supersedes` entries that point under `../archive/` refer to the internal design
archive. It is kept in the maintainers' working copy and is **not published** with the
repository; those links resolve in a maintainer checkout only. The archived documents are
never the current behavior — these module pages are.

## Relationship to the other doc trees

- `docs/user/` — how to use the product, for users and integrators.
- `docs/dev/` — how it is implemented and why, for contributors.
- `docs/archive/` — the history: specs, plans, reports and roadmaps, frozen.