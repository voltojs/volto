# Writing user documentation

This file is for humans and agents alike: a page written by either should read the same.
The rules for developer documentation do not apply here — `docs/dev/` explains **why** a
design is the way it is; `docs/user/` explains only **how to use it**.

## Two tracks, kept apart

| Directory | Reader | Question it answers | Vocabulary allowed |
| --- | --- | --- | --- |
| `using/` | People who run the agent | How do I make it do X? | UI labels, commands, config keys |
| `integrating/` | People embedding the agent in their own host | How do I wire it up? | Ports, types, options, events |
| `concepts/` | Both | Why does it behave this way? | Concept names, explained in plain language on first use |

Test: a page that says "reducer", "port" or "Effect" to a `using/` reader is on the wrong
track.

## Page skeleton

```markdown
---
title: Permissions and approvals
type: guide
source:
  - apps/gateway/src/config/permissions.ts
generated: false
verified: 2026-11-11
---

# Permissions and approvals

> You will: <one verifiable result>

## Prerequisites      ← optional
## Steps              ← numbered; every step says "You should see"
## When it goes wrong ← at most 3 items, pointing at troubleshooting
## Related
```

- `title` matches the H1. Exactly one H1 per page.
- `type` is one of `tutorial` (walk the reader through it) · `guide` (solve one problem) ·
  `reference` (look things up) · `concept` (explain one idea).
- `source` lists the implementation paths this page describes; `*` globs are allowed. Its
  purpose is not for readers but for drift detection: when those files change, this page
  probably needs to change too.
- `verified` is the date you checked the page against the real UI and behavior — not the
  date it was edited.
- Keep a page at or under 350 lines. Longer means split it.

## Language: English is the main file

- The English page lives at its normal path; the Chinese mirror lives at the same path
  under `docs/user/zh/`. Every user-facing page must exist in both.
- Translate the `title`, the H1 and the prose. Never translate code, commands, paths,
  config keys, URLs, tool names or permission-mode names.
- Keep the two versions structurally identical. If a page is split, both languages split;
  if a section is removed, remove it in both. Do not let one language drift ahead.
- Use the terms in [GLOSSARY.md](GLOSSARY.md) consistently.
- Links inside a page are relative, so a mirror page keeps the same relative path (it
  resolves inside `zh/`). Do not point a Chinese page at an English page.

## Writing rules

1. **Result first, then steps.** Open with "You will: …" so the reader can decide whether
   to keep reading.
2. **Every step has a "You should see".** A step without an observable result cannot be
   self-checked.
3. **Commands must be copy-pasteable.** No `…` hiding a required argument.
4. **Conclusions only, no argument.** Why a boundary exists lives in `SAFETY.md`; here say
   what it stops and what it does not.
5. **Do not duplicate.** Explain a mechanism once and link to it. Copying between `using/`
   and `integrating/` is flagged by the check.
6. **Fixed vocabulary**: workspace / session / turn / subagent / approval / sandbox /
   provider / skill / memory / host / port.
7. **Two kinds of code block**: runnable examples use ` ```ts ` (they are compiled by
   `tsc`); signature excerpts use ` ```text ` (not compiled). Marking an excerpt as `ts`
   makes the check report false errors.
8. **Screenshots** go under `assets/`, named `<page>-<step>.png`, referenced by a relative
   path (the link check verifies the file exists).

## Generated pages

Four files are generated; hand edits are reported as drift:

| File | Input |
| --- | --- |
| `using/reference/tools.md` | Tool declarations in each tool package + `reference/tool-notes.json` |
| `using/reference/config.md` | `config.json` sections + `reference/config-sections.json` |
| `integrating/reference/gateway-api.md` | Gateway routes + `reference/gateway-notes.json` |
| `integrating/reference/sdk-exports.md` | Export statements in the SDK |

The same four pages are generated under `zh/` from the same inputs, using the Chinese side
of each bilingual note (`{ "en": "…", "zh": "…" }`). Change the code or the notes and run
`pnpm docs:sync`.

**A missing note is a hard error**: adding a tool without an entry makes `docs:check` fail.
That is deliberate — otherwise the generator would emit a table that looks like
documentation but cannot be read.

## Checks and commits

```bash
pnpm docs:check    # read-only; this is what CI runs
pnpm docs:sync     # regenerate reference pages + accept the current surface baseline
pnpm docs:ack "reason"  # use when a surface changed but no page needs updating
```

`docs:check` fails on:

- generated pages out of sync with their inputs (hand-edited, or code changed without
  regenerating);
- dead links, anchors or images;
- a new or removed tool / config field / gateway route whose note is missing;
- **a user-visible surface changed without the baseline being synced** (see below);
- TypeScript examples in the integrator docs that do not compile;
- an orphan page (nothing links to it);
- a page whose Chinese mirror is missing, or a note missing one of its two languages.

## What the surface baseline is

`docs/user/.meta/surface.json` records fingerprints of several "things users can perceive":
the tool list, gateway routes, config sections and fields, SDK exports, SDK type signatures
and UI copy catalogs. When a code change alters a fingerprint, `docs:check` fails and names
the pages to look at (the mapping is in `.meta/routing.json`). Two ways out:

1. update the affected pages, then `pnpm docs:sync` to accept the new baseline;
2. if the change is genuinely invisible, `pnpm docs:ack "reason"` — the reason lands in the
   diff.

Both leave a trace in the commit, so a reviewer sees them. **`docs:ack` is not a waiver**:
a high ack rate means the fingerprints are too coarse; tighten the check instead of
acking more.

## Adding a page

1. Check whether an existing page already has the right home (add a section rather than a
   page).
2. Create the English page with front matter, `source` pointing at the implementation.
3. Create the Chinese mirror at the same path under `zh/`.
4. Add the entry to `docs/user/README.md` and its Chinese mirror; otherwise the orphan
   check fails.
5. Run `pnpm docs:check`.

## Do not

- Move spec or plan content into user docs. Readers do not need the historical reasoning.
- Create "TODO" or "coming soon" placeholder pages. No content, no page.
- Use "obviously" or "simply" — when the reader is stuck, those only make it worse.
- Paste a full configuration JSON into `using/` pages; show the minimal useful fragment and
  link to `reference/config.md`.
- Write one language first and leave the mirror stale. Both versions are reviewed together.