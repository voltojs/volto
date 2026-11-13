---
title: Event streams and the UI
type: guide
source:
  - packages/core/src/ports.ts
  - packages/runtimes/node/src/runner.ts
  - apps/gateway/src/event-sinks.ts
  - packages/sdk/src/sse
generated: false
verified: 2026-11-11
---

# Event streams and the UI

> After reading this you will: be able to feed kernel events into your own UI, and know which events you can rely on and how to reconnect after a disconnect.

## Transport shape

The kernel knows exactly one interface:

```text
interface EventSink {
  emit(event: { type: string; data: Record<string, unknown> }): void;
}
```

`type` is a string and `data` is free-form. The official gateway turns it into SSE:

```text
data: {"type":"tool_result","data":{"callId":"…","isError":false,"content":"…"}}

```

The client in `@voltojs/sdk/sse` uses named frames with ids and supports resuming with `Last-Event-ID`; the gateway's `/events` reads that header too and replays the events missed while disconnected.

## Two kinds of events

### Deltas that exist only on the connection (never persisted)

| Event | Fields | Notes |
| --- | --- | --- |
| `text_delta` | `text` | Body text delta, rendered character by character |
| `reasoning_delta` | `text` | Reasoning delta (can be shown collapsed) |
| `tool_use_delta` | The first frame carries `toolCallId` / `toolCallName`, later frames carry argument deltas | The argument stream of a tool call |

They are not written to the transcript: they are gone after a page refresh, so rebuild the UI from the transcript events in the next table.

### Transcript events (persisted and also streamed)

| Event | Key fields | Purpose |
| --- | --- | --- |
| `turn_start` / `turn_end` | `turn`; `turn_end.reason` = `done` / `error` / `cancelled` / `budget_exceeded` | The boundary of a turn |
| `model_call_start` / `assistant_message` | `assistant_message.content`, `stopReason`, **`usage`** | One model call; token usage is here, not in a separate event |
| `tool_call` | `callId`, `name`, `input` | The tool call is complete (arguments collected, about to execute) |
| `tool_result` | `callId`, `name?`, `content`, `isError?`, `displayMetadata?` | The tool finished; `content` is a string or an array of content blocks |
| `approval_asked` / `approval_decision` | `callId`, `name`, `riskTier` | Show an approval card / record the decision and its reason |
| `model_error` / `model_retry` | `error`, `retriable`; `attempt`, `delayMs` | Readable errors and automatic retries |
| `compaction` | `replacedCount`, `summaryText` | The context was compacted |
| `tool_results_pruned` | The pruned entries | Oversized tool results were pruned for good |
| `context_reminder` | `kind`, `text` | Injected reminders: workspace/branch, permission boundary, background task completion, and so on |
| `user_message` / `steering_*` | Content / id | Adding, updating and removing user messages and queued messages |
| `subagent_*` | `subagent_started` / `subagent_finished` / `subagent_tools_dropped` / `subagent_permission_downgraded` / `subagent_model_tier_unresolved` | The subagent lifecycle |
| `budget_exceeded` / `error` | `reason` / `message` | Why it stopped, why it failed |

**The authoritative full vocabulary is the transcript event table in `packages/core/src/ports.ts`**; `GET /sessions/:id/events` returns the raw persisted events, the same ones the UI sees.

### Subagent acceptance verdicts

When a dispatch carries acceptance criteria (the `acceptance` argument of `task`), the same verdict is carried in two places:

- `subagent_finished.verification` — an optional field; it is absent for dispatches without criteria and in old logs.
- `tool_result.displayMetadata.verification` — the result of `task` (or of `task_output` for a background task) carries the same verdict, so a tool card can render the badge without joining events.

```text
verification?: {
  status: "passed" | "failed" | "error";
  attempts: number;        // how many times the subagent actually ran; the verdict call is not counted
  failures: string[];      // failure reasons, at most 5
  verifierError?: string;  // why the verifier itself did not run
}
```

`status` is for display and copy only: `failed` means the reworks ran out and the criteria are still not met, and the matching `tool_result` has `isError: true`; `error` means the verifier itself did not run (timeout / unparseable output), which is not a substantive failure and the result is not an error either. To decide "did this dispatch fail", read `isError` (present on both `tool_result` and `subagent_finished`), not `status`.

The event carries only the four fields above; the envelope of `displayMetadata.verification` and of the result body may also carry `retryHint` (a fix suggestion) and `usage` (the spend of the verdict call, accumulated separately and not merged into the subagent's own usage).

For a background dispatch, `subagent_finished` arrives after the dispatching turn has closed, and the verdict is stamped back onto the original dispatch card; when the model never calls `task_output`, the first line of the completion notification (`context_reminder`, `kind: "background_task"`) is the `[background task <taskId> finished]` heading, and the `[verification: …]` verdict line follows right after — do not parse the verdict from the first line alone.

## Three principles

1. **Events are not the truth about state.** When you need "what is the state now", read `getState()` or fetch the session detail again. The event stream expresses "what happened".
2. **Do not derive business conclusions from events.** For "this turn succeeded", look at `turn_end.reason`; do not count `tool_result` events.
3. **Rendering must tolerate unknown events.** Ignore a `type` you do not recognize; otherwise one diagnostic event added to the kernel is enough to blank your UI.

## Disconnects and ordering

- Events are ordered within one session; ordering across sessions is not guaranteed.
- Reconnecting with `Last-Event-ID` replays the events missed while disconnected; without that id you can only continue from the current moment, so **the first paint should still fetch once from the persistence layer** and then merge incrementally.
- Deduplicate on message / call id when merging, not on arrival position.

## When something goes wrong

- **The UI is stuck on "generating"** → `turn_end` never arrived; check whether the SSE connection dropped, and whether your consumer loop can still receive the end event when it throws.
- **The tool card never disappears** → `tool_result.callId` does not match `tool_call.callId` (a common cause: you reordered the events yourself).
- **Messages are duplicated after a refresh** → the reconnect merge did not deduplicate by id.
- **Usage always shows 0** → usage is not in a separate event; take it from `assistant_message.usage`.