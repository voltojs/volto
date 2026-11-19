---
title: Visibility and permission are two separate things
type: concept
source:
  - packages/core/src/tool-router.ts
  - packages/core/src/permission-policy.ts
  - packages/sdk/src/tool-scope-default.ts
generated: false
verified: 2026-11-11
---

# Visibility and permission are two separate things

> After reading this you will: be able to tell that "the tool did not appear" and "the tool was rejected" are two completely different failures.

## The two layers

| Layer | Question it asks | Who decides | Result |
| --- | --- | --- | --- |
| Visibility | Should this tool be told to the model? | Assembly (which capabilities exist, whether the tool budget is big enough) | The model does not know it exists at all |
| Permission | May this call execute? | Permissions (rules + sandbox + approval) | The model knows it was rejected |

The host sets both layers when a session is built; they do not change freely at runtime.

## Why they must be separate

Because their failure modes are completely different:

- **A visibility problem** is fixed in assembly: if `fs` is not passed, the file tools really do not exist — it is not "no permission", it is "no such capability".
- **A permission problem** is fixed in policy: the tool is there, it is just not allowed this time.

Merging them into one concept leads to a bad design: removing `write_file` from the tool set to "stop it writing files". The result is that the model does not know writing is forbidden and keeps trying other workarounds — whereas the right approach is to keep the tool visible and let the policy reject it explicitly; once the model gets a clear rejection reason it stops.

## The tool budget

The visible set is capped, but the cap grows with what a session actually has. The base is 20 slots: the 14 file/shell/git tools, 5 session tools (todo, task, ask, skill…), and 1 spare for plugin or MCP tools. Every wired feature group — browser, memory, code intelligence, SQLite, plan mode, web search/fetch — then adds exactly as many slots as it brings tools, so those tools can never be crowded out by another group.

The order still matters for the spare slot and for anything unknown: groups are ranked (session tools, then plan, then browser/memory, then code intelligence, then web, then SQLite), and a tool that belongs to no group falls last. So "adding a tool" only competes with unknown and plugin tools — it does not silently evict, say, web search.

## One-line mnemonic

**Visibility decides whether it knows; permission decides whether it may.** Get the first wrong and the model plays dumb; get the second wrong and the model hits a wall.