---
title: Understanding changes, approvals and resuming sessions
type: tutorial
source:
  - apps/web/components/chat*
  - apps/web/lib/diff-view.ts
  - apps/web/messages/zh/chat.json
generated: false
verified: 2026-11-11
---

# Understanding changes, approvals and resuming sessions

> After reading: know exactly what the agent changed in each turn, when it is waiting for your go-ahead, and how to continue the conversation after closing the window.

## What happens in a turn

1. You send a message; the agent decides whether to call tools (read files, search code, run commands, change files).
2. Actions that need your consent pop an **approval card** and block until you choose.
3. When files change, the change hangs under the corresponding message as a **diff card**.
4. The turn ends; you can keep asking follow-ups, or start a new conversation.

## The approval card

The approval card states what will be executed and why. Your choices:

- **Allow once**: allow just this time.
- **Deny**: the agent receives the denial result and takes another approach; it does not get stuck.
- **Always allow…** (appears only for qualifying `bash` commands): records this command prefix into `permissions.rules` in `~/.volto/config.json`, effective **from the next turn** for all projects. The report states clearly whether it was actually written, and why not if it was not.

To stop a class of operations from interrupting you without widening the overall permissions, configure rules in [Permissions and approvals](../guides/permissions-and-approvals.md).

## Plan mode

Send `/plan <goal>` in the input box and the session enters plan mode: **read-only research**, producing a plan document for you to review. It executes only after you approve.

In plan mode the agent can only read, not modify; what it produces is the plan itself, written into the session's own plan document, not into your workspace.

## Where to see the changes

- **Diff card**: below this turn's tool calls, listing added and deleted lines per file.
- **"Files" pane**: lists the files touched in this turn, switchable between file tree / preview / diff.
- **"Git" pane**: workspace status, diff, commit graph and branch switching.

The pane's collapse button is at the far right of the top bar; after collapsing, reopen it with "Expand pane" at the top of the chat. Pane state is remembered per session: switching sessions restores each session's own pane, and returning to an old session restores its subagent / plan tabs exactly as they were; see [Subagents and background tasks](../guides/subagents-and-tasks.md).

## Continue where you left off

Sessions are persisted under `~/.volto/`. Closing the browser or restarting the frontend does not matter: click back into the left-hand list and the original context is there.

- The title is generated from the first message; in "Settings → General" you can designate a cheap model to title sessions.
- When the context fills up, compaction triggers (older messages are folded into a summary). You can also trigger one manually with `/compact`.

## When something goes wrong

- **The approval card never appears and the UI is stuck on "waiting for approval"** → the connection between the gateway and the frontend dropped; refresh the page and send the request again.
- **The model reports 4xx** → there is a problem with the provider/model configuration or the key; go back to "Settings → Models" and check.
