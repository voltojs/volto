---
title: Documentation system
status: current
source:
  - scripts/docs/lib.mjs
  - scripts/docs/gen.mjs
  - scripts/docs/check.mjs
  - apps/docs/.vitepress/config.mts
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-11-11-user-docs-system-design.md
---

# Documentation system

## Scope and where it sits

This page documents the tooling that keeps `docs/user/` correct: the generators, the
check gate, the surface baseline and the VitePress site. It does not describe the product;
for behavior see the module pages, for usage see `docs/user/`.

Doc trees:

| Tree | Audience | Maintenance |
| --- | --- | --- |
| `docs/user/` | Users and integrators | Tracks the code; gated by `docs:check` |
| `docs/dev/` | Contributors | Tracks the code; reviewed by hand |
| `docs/archive/` | Anyone tracing history | Frozen; not maintained |

## Current behavior

### Generation

`scripts/docs/gen.mjs` writes the four reference pages twice — English at the normal
path, Chinese under `zh/`:

| Page | Inputs |
| --- | --- |
| `using/reference/tools.md` | Tool declarations discovered from `packages/tools/*/src` + `reference/tool-notes.json` |
| `using/reference/config.md` | Config sections parsed from `apps/gateway/src/config/*.ts` + `reference/config-sections.json` |
| `integrating/reference/gateway-api.md` | Routes extracted from `apps/gateway/src/server.ts` + `reference/gateway-notes.json` |
| `integrating/reference/sdk-exports.md` | Export statements in `packages/sdk/src/index.ts` |

The notes files are bilingual: every value is `{ "en": "…", "zh": "…" }`. The renderers in
`scripts/docs/lib.mjs` pick the locale with `loc(value, locale)`. Static copy (titles,
table headers, intros) lives in the `T` table in the same file, one entry per locale.

The generated header is identical in both locales. A hand edit is detected as drift.

### Checking

`scripts/docs/check.mjs` (run via `pnpm docs:check`) walks `docs/user/**/*.md` and fails
on:

- missing front matter (`title`, `type`, `source`, `generated`, `verified`) — index pages
  `README.md`, `WRITING.md` and `zh/README.md` are exempt;
- dead relative links, anchors and images (external URLs are not fetched);
- generated pages that differ from what the generator would produce, for **both** locales;
- a tool, config section/field or gateway route without a note, or a note missing either
  language;
- an orphan page (nothing links to it), except the index pages;
- TypeScript snippets in `integrating/` that do not compile (`tsc --noEmit` against the
  built SDK);
- a user-visible surface changed without the baseline being synced.

Warnings (errors with `--strict`): more than one H1, pages over 350 lines, missing
"What you will get" line on guides/tutorials, implementation jargon in `using/`, and a
`verified` date older than 90 days. Jargon and the "what you will get" checks only apply
to the English pages; the Chinese mirror is checked structurally.

### Surface baseline

`docs/user/.meta/surface.json` stores fingerprints of the surfaces users can perceive:
tool list, gateway routes, config sections and fields, SDK exports, SDK type signatures and
UI copy catalogs. When a fingerprint changes, the gate fails and `routing.json` maps the
changed surface to the pages likely to need an update.

- `pnpm docs:sync` regenerates the reference pages and accepts the new baseline.
- `pnpm docs:ack "reason"` accepts the baseline change without a page update; the reason is
  written into the diff. It is a review aid, not a waiver.

### The site

`apps/docs` is a VitePress app:

- `srcDir` is `docs/user`; `base` is `/volto/` (project pages).
- `README.md` is rewritten to `index.md`, and `zh/README.md` to `zh/index.md`.
- Locales are `root` (English) and `zh`; the sidebar is generated from the directory tree
  and front-matter titles, so a new page appears without editing the config.
- `WRITING.md` and `.meta/` are excluded via `srcExclude`.
- Dead links fail the build. Links that intentionally leave `docs/user` (for example to
  `SAFETY.md` or `AGENTS.md`) are absolute GitHub URLs, because the site cannot serve them.
- `.github/workflows/deploy-docs.yml` builds on pushes to `main` that touch docs, runs
  `docs:check` and `docs:site`, then deploys to GitHub Pages.

## Invariants and boundaries

- Generated pages are never edited by hand; only their inputs change.
- A generated page and its Chinese mirror come from the same inputs, so they cannot
  disagree about which tools or fields exist.
- `docs:check` is read-only; `docs:sync`/`docs:gen` are the only writers.
- The site is a projection of `docs/user`; it adds no content of its own.

## Decisions and rejected alternatives

- **Two directories instead of `_zh.md` suffixes** (2026-11-13): VitePress locales are
  directory-based, so `zh/` avoids a rewrite plugin and keeps relative links identical in
  both trees.
- **Bilingual notes JSON instead of two notes files**: one entry cannot drift from its
  translation; the cost is that adding a tool requires two strings.
- **Chinese mirror checked structurally, not linguistically**: the gate can prove parity of
  front matter, links and structure; it cannot judge translation quality, which stays a
  review responsibility.
- **No separate dev-docs gate**: `docs/dev/` is small and reviewed by hand; automating
  drift there was judged not worth the complexity yet.

## How to change it

- Changing a generator: edit `scripts/docs/lib.mjs`, run `pnpm docs:gen`, then
  `pnpm docs:check`.
- Adding a tool/config field/route: add the code, add both notes strings, run
  `pnpm docs:sync`.
- Changing the site: `pnpm docs:site` must build without dead links; the deploy workflow
  re-runs `docs:check`.
- After touching the surface fingerprint logic, run `pnpm docs:check` and inspect
  `.meta/surface.json` in the diff.

## Further reading

- [docs/user/WRITING.md](../user/WRITING.md) — page rules and the bilingual workflow.
- `docs/archive/superpowers/specs/2026-11-11-user-docs-system-design.md`
  — the original design of the gate.