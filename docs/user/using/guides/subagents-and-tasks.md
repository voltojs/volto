---
title: Subagents and background tasks
type: guide
source:
  - packages/tools/agent/src/task.ts
  - packages/sdk/src/create-agent.ts
  - packages/sdk/src/agent-registry/scan.ts
  - apps/gateway/src/agents/routes.ts
  - packages/core/src/acceptance.ts
  - apps/web/lib/verification-badge.ts
generated: false
verified: 2026-11-11
---

# Subagents and background tasks

> After reading: know when to dispatch a subagent, what it can and cannot do, and how to add your own subagent type.

## What a subagent is

The main agent can call the `task` tool to hand an independent subtask to a **subagent** (another agent instance). A subagent has its own context and **cannot see your conversation with the main agent** — so the dispatch brief must be self-contained.

The benefit is isolation: a broad search or an independent refactor does not pollute the main conversation's context.

## What you can control when dispatching

| Parameter | What it does |
| --- | --- |
| `message` | The subtask brief. Self-contained; state the scope, depth and expected output size |
| `subagent_type` | Which subagent definition to use (omit to use `general-purpose`) |
| `acceptance` | Acceptance criteria. When set, they are always judged; on failure it reworks once automatically by default. See "Acceptance and rework" below |
| `model` | Which model routing tier to use for this run (the tier id, not the model name) |
| `permission` | The subagent's permission mode: `read-only` / `ask` / `auto` / `full`, **narrower only, never wider** |
| `tools` | Tool allowlist, intersected with the parent session's tool set — it can only narrow |
| `max_iterations` | Loop limit for this run |
| `title` | The label shown in the UI (not sent to the subagent) |
| `system_prompt` | Additional instructions appended after the subagent's role prompt |
| `run_in_background` | Return a task id immediately without blocking the main conversation |

**Both permission and tools can only narrow.** Making a subagent do what the parent session cannot is impossible: a wider permission is refused and you get back the list of usable modes. This design is intentional — a subagent must not become a back door around approvals.

## Acceptance and rework

When dispatching you can give the subagent acceptance criteria (the `acceptance` parameter). Write them as criteria you can check off one by one, such as "all tests pass, with output attached" or "the generated file contains fields a and b"; do not write unjudgeable wishes like "do it well". Criteria are at most 2000 characters.

If criteria are set they are always judged, in a fixed flow:

1. **The subagent sees the criteria.** They are attached to the dispatch brief, so the subagent knows it will be judged against them on completion.
2. **On completion, another model call judges.** The judgement looks at the subagent's actual calls and result evidence, not its claim that "I'm done"; criteria the evidence cannot confirm are judged as not passed.
3. **On a first failure, it reworks once automatically.** One rework is allowed by default: the failure reasons and fix suggestions go back to **the same sub-session**, and the subagent continues from the changes it already made instead of starting over.
4. **If the rework also fails, the dispatch returns as a failure.** The `task` call result is a failure, the body lists each failure reason, and the main agent decides the next step from that. If it passes after the rework, it returns as accepted.

The judge failing to run at all (timeout, unparseable output) is not a substantive failure: there is no rework, and it is marked "not verified". A subagent that crashes itself is likewise treated as a failure.

### What the badges mean

A dispatch with criteria gets an extra judgement badge on its card; without criteria there is no badge and behavior is the same as before.

| Badge | Meaning |
| --- | --- |
| Accepted | Met the bar (possibly after rework) |
| Not passed (N) | Ran N times and still did not meet the bar (N is the number of subagent runs; under the default budget the maximum is 2 = first round + one rework) |
| Not verified | The judge itself errored, so whether the work met the bar is undetermined |

"Not passed" and "Not verified" are amber warning marks, **hover to see the reason**; the failure reasons are also written into the tool result body. Open the dispatch card to enter the sub-session and see the full conversation of the rework round.

### Where to see the judgement for background tasks

For background dispatches with criteria (`run_in_background: true`), the judgement appears in three places:

- **The dispatch card**: the badge is filled in as soon as the task ends, no refresh needed;
- **The `task_output` result line**: when the main agent fetches the result, that line carries the same badge;
- **The completion notice**: even if the main agent never fetches the result, the body of the background task completion notice starts with a `[verification: …]` line (such as `[verification: failed after 2 attempts]`) right after the `[background task … finished]` heading, so the judgement is never silently lost.

## Background tasks

With `run_in_background: true`, `task` returns a task id immediately and the main conversation continues. Afterwards:

- fetch the result with `task_output` (repeatedly, until it finishes);
- when a background task ends, an event is pushed to the UI; the "Tasks" tab in the right-hand pane shows progress and results;
- a failing subagent does not take down the main conversation — the error is returned as a result.

Good fits: running a very long test suite, searching several directions in parallel.

## Session switching and the right-hand pane

The pane's state is **remembered per session**: each session remembers its own tabs (including subagent / plan), the active tab and the expanded / collapsed state. Switching to another session restores that session's own state; a session you have never opened defaults to collapsed with no tabs, so you do not see the previous session's subagent pane. Returning to an old session restores its subagent / plan tabs and expanded state exactly as they were. The state is stored on this device and survives a refresh. While you stay in the current session, newly created background tasks or a new plan round still open the corresponding tab automatically.

## Nesting depth

At most two levels by default: main agent → subagent. A subagent dispatching further down is refused. This cap prevents "an agent opening agents" from multiplying without bound — if you really need more depth, split the big task into several sequential dispatches.

## Custom subagent types

Put a Markdown file in either of these two directories, one file per type:

| Directory | Scope | Priority |
| --- | --- | --- |
| `~/.volto/agents/` | User-level, available to all projects | Low |
| `<workspace>/.volto/agents/` | Project-level, available only in that workspace | High (same name overrides user-level) |

The file body is the subagent's system prompt; metadata lives in the file (name, description, tools, model, permission). The two built-in types `general-purpose` and `explore` are always available and **cannot be deleted** — editing them creates a same-named override file at user level.

"Settings → Subagents" shows the merged list, marking each entry's source (project / user / plugin / built-in) and whether it is overridden by a same-named entry.

## When something goes wrong

- **The subagent goes in the wrong direction** → mostly the `message` is not self-contained; it cannot see the context, and knows nothing of the conventions in the main conversation.
- **The subagent has no tools at all** → either `tools` was passed an empty array, or it needs a capability the parent session does not have.
- **The dispatch is refused, saying the permission is too wide** → narrow `permission`; it cannot exceed the parent session's mode.
- **A background task never produces a result** → check its status with `task_output`; a long task may simply still be running.
