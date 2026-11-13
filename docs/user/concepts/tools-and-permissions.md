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

By default the model can see at most 20 tools at once (21 when memory is wired in). This is a hard constraint, not a suggestion: too many tools make the model pick wrong and make every request more expensive.

Tools beyond the budget queue up by tier priority; tools that belong to no tier fall last. So the hidden cost of "adding one tool" is "crowding out another".

## One-line mnemonic

**Visibility decides whether it knows; permission decides whether it may.** Get the first wrong and the model plays dumb; get the second wrong and the model hits a wall.