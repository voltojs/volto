---
title: Slash commands and input tips
type: reference
source:
  - apps/web/lib/input-commands.ts
  - apps/gateway/src/commands.ts
generated: false
verified: 2026-11-11
---

# Slash commands and input tips

> After reading: know what each command in the `/` menu does, and how to use `@` and attachments.

## Command table

| Command | What it does | Who runs it |
| --- | --- | --- |
| `/plan [goal]` | Enter plan mode: read-only research, producing a plan for your approval first | Frontend |
| `/clear` | Start a new session (the current context is not carried over) | Frontend |
| `/compact` | Manually compact the current session's context | Frontend |
| `/review [scope]` | Have the agent review the changes and list problems and fixes by severity; without a scope it looks at uncommitted changes | Gateway template |
| `/explain [subject]` | Have the agent explain an implementation and its key code paths | Gateway template |
| `/skill-name` | Invoke a skill (only those that allow user invocation are listed) | Gateway |

Distinguishing "who runs it" matters:

- **The three frontend commands** (`/plan` `/clear` `/compact`) take effect locally and **do not** become a message sent to the model — so `/clear` does not produce a turn.
- **Gateway templates** (`/review` `/explain`) expand the command into a complete prompt before sending it to the model — what is sent is the expanded content, not the words `/review`.
- A form with extra arguments such as `/clear extra` does not count as a command: it is sent to the model as an ordinary message, with its content normalized to `Unknown command: /clear. Available commands: …`, so what the model sees is "this command does not exist", not "clear the session".

## Input tips

- **`@` file references**: typing `@` pops up the workspace file list; selecting an entry inserts a file reference. A reference is resolved into file content or a path at send time, which is more reliable than typing the path by hand.
- **Images**: paste or drag them straight into the input box. Whether the model can see them depends on whether that model declares image input (see [Models and providers](../guides/models-and-providers.md)).
- **Multiple lines**: `Shift + Enter` inserts a newline, `Enter` sends.
- **Interrupting**: if a turn runs too long, click the stop button (the real effect is interrupting the current turn; content already produced is kept).
- **Queueing**: keep typing while it runs; messages are queued and sent in the next turn instead of being dropped.

## Adding your own commands

`/review` and `/explain` are gateway built-in templates; for more templates you can simply write the full prompt in a message — commands only save typing, there is no other magic. Skills are a separate mechanism: put them in the project or user directory, and the agent decides for itself when to load them.
