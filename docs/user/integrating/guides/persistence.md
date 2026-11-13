---
title: Persistence and recovery
type: guide
source:
  - packages/core/src/ports.ts
  - packages/stores/jsonl/src
  - packages/sdk/src/transcript-reader.ts
  - apps/gateway/src/sessions.ts
generated: false
verified: 2026-11-11
---

# Persistence and recovery

> After reading this you will: know which three things to store, and what "continue the conversation after a restart" actually recovers from.

## Three things, do not mix them up

| What to store | Port | Content | What happens if lost |
| --- | --- | --- | --- |
| State snapshot | `SessionStore` | `{ id, state, createdAt }`, the kernel's complete state | The session cannot resume in place |
| Event log | `TranscriptStore` + `TranscriptReader` | Append-only event stream (what happened in each turn) | UI history, audit and export are all gone |
| Session metadata | Stored by the host itself | Title, workspace, model, permission mode | The conversation is unrecognizable in the list |

What the official host does: state and session metadata go into the session store, events go into the transcript (JSONL, appended one by one), and the two are linked by the same `sessionId`. The transcript is injected via `createAgent({ chatStore })` — it implements both writing (`TranscriptStore`) and reading (`TranscriptReader`).

## The SessionStore contract

```text
interface SessionStore {
  save(snapshot: SessionSnapshot): Promise<void>;
  load(id: string): Promise<SessionSnapshot | undefined>;
  list(): Promise<SessionSnapshot[]>;
}
```

- `save` is **overwriting**: just save the latest snapshot for an id, there is no need to maintain versions yourself.
- `snapshot.state` must be serializable. Anything holding a Promise should not be in the state (this is exactly why the kernel keeps background tasks outside the state).
- The official set also ships file / sqlite / postgres implementations sharing one contract test suite — when writing your own, copy that suite.

## The transcript contract

```text
interface TranscriptStore {
  appendEvents(sessionId: string, events: TranscriptEventInput[]): Promise<void>;
}
interface TranscriptReader {
  readEvents(sessionId: string): Promise<TranscriptEvent[]>;
}
```

- Append-only, never rewritten: this keeps the audit trail trustworthy and makes replay possible.
- Writes are **best-effort**: a failed write must not crash the turn. In the official implementations every write is wrapped in a fallback.

## Two ways to recover

1. **Restore from a snapshot**: `load(id)` gives you the state, and you rebuild the instance with `createAgent`'s seed options (`initialMessages` / `initialTurn` / `initialStep`). Fast and complete, but the snapshot shape evolves with the kernel version, so it may not be readable across versions.
2. **Replay events**: read the transcript and feed it back into the kernel. Slower but more robust, and it is also what the replay tests do.

The cross-version compatibility strategy is yours to define: the official host chooses "fail loudly when it cannot read" (returns 410) instead of guessing.

## Compaction and deletion

- Compaction changes the state but **does not delete historical events**: the transcript keeps the full text, the state keeps only the summary. That is why "you can still see old messages after compaction" relies on the transcript, not the state.
- When the official host deletes a session it does three things: delete the transcript, delete that session's attachments, delete the plan documents; it **does not clean up the `SessionStore` snapshot** — the list is driven by the transcript, so the leftover snapshot is never read. If your own host uses snapshots as the list source, you have to add that step yourself, or you will see "deleted, then it came back".

## Audit and export

- `AuditSink` is a separate channel: tool calls, approval decisions and the like are written as an audit trail (`~/.volto/audit.jsonl`). It is **not** a replacement for the transcript — one is a ledger for humans to inspect, the other is the basis for restoring a conversation.
- Export (Markdown / JSONL) is generated from the transcript, not from the state: the state's shape is an implementation detail, the transcript is the readable fact.

## When something goes wrong

- **The session opens empty after a restart** → only the transcript was stored and not the snapshot (or the reverse); you need both.
- **After recovery the model has forgotten the tool results from a moment ago** → the snapshot only holds the state and the tool results were pruned; verify with the replay path.
- **A failed event write takes the whole turn down** → check whether your `appendEvents` swallows errors internally; it should not throw exceptions at the caller.
- **Old sessions cannot be read across versions** → fail loudly and point to export; do not silently reset.