/**
 * AgentInput — all possible inputs to the step() reducer.
 * Every input is a plain, serializable data object.
 */

import type { ContentBlock, TodoItem, ToolResultBlock } from "./state.js";
import type { ErrorKind } from "./error-taxonomy.js";
import type { ApprovalDenialReason, FileWatchEvent, TokenUsage } from "./ports.js";

/** User sent a message */
export interface UserMessageInput {
  type: "user_message";
  content: string | ContentBlock[];
}

/**
 * Edit a queued (not yet delivered) steering message in place — same id,
 * same queue position, new content (spec 2026-11-04 D14). Accepted in ANY
 * status: the queue outlives the turn. An id no longer in `queuedUserInputs`
 * (already delivered, removed, or never queued) yields an errorResult —
 * delivery wins, so a sent message can never be edited.
 */
export interface SteeringEditInput {
  type: "steering_edit";
  id: string;
  content: string | ContentBlock[];
}

/**
 * Withdraw a queued (not yet delivered) steering message — hard delete, no
 * tombstone (spec 2026-11-04 D15). Accepted in ANY status. An id no longer
 * in `queuedUserInputs` yields an errorResult — delivery wins, so a sent
 * message can never be withdrawn.
 */
export interface SteeringRemoveInput {
  type: "steering_remove";
  id: string;
}

/** Streaming chunk from the model (partial text or tool_use delta) */
export interface ModelChunkInput {
  type: "model_chunk";
  chunk: {
    type: "text_delta" | "reasoning_delta" | "tool_use_delta";
    text?: string;
    toolCallId?: string;
    toolCallName?: string;
    argumentsDelta?: string;
  };
}

/** Model finished generating (stop reason determined) */
export interface ModelDoneInput {
  type: "model_done";
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Tokens read from provider-side prompt cache. */
    cacheReadTokens?: number;
    /** Tokens written to provider-side prompt cache. */
    cacheWriteTokens?: number;
  };
  /** Adapter-private replay state from the stream's terminal event. */
  meta?: unknown;
}

/** Model encountered an error */
export interface ModelErrorInput {
  type: "model_error";
  error: string;
  retriable?: boolean;
  /** Classified error kind — set by the Runner after classifyError() */
  errorKind?: ErrorKind;
}

/** Tool execution result (returned by Runner after ExecuteTool effect) */
export interface ToolResultInput {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  result: {
    modelContent: string | ToolResultBlock[];
    isError?: boolean;
    displayMetadata?: Record<string, unknown>;
    /** Classified error kind — set by the Runner when tool fails */
    errorKind?: ErrorKind;
    /** Mirrors ToolResult.statePatch; Runner passes tool output through verbatim. */
    statePatch?: {
      todos?: TodoItem[];
    };
  };
}

/** HITL approval decision (returned after RequestApproval effect) */
export interface ApprovalDecisionInput {
  type: "approval_decision";
  toolCallId: string;
  decision: "allow" | "deny";
  /**
   * Why the decision came out this way, when the gate supplied it.
   *
   * Reaches the MODEL, not just the UI: the tool result the reducer
   * synthesizes for a denial names who denied it, and telling the model a
   * dropped connection was "the user" makes it ask a follow-up question
   * nobody is there to answer. Optional so existing inputs and recorded
   * replays stay valid.
   */
  reason?: ApprovalDenialReason;
}

/** Cancel requested */
export interface CancelInput {
  type: "cancel";
  reason?: string;
}

/**
 * Budget exceeded — fed by the Runner when wallclock or cost limits are breached.
 * The core reducer terminates the turn with a "done" state and emits a
 * clear reason. Separated from Cancel to preserve semantic clarity.
 */
export interface BudgetExceededInput {
  type: "budget_exceeded";
  reason: string;
}

/**
 * Self-correction injection — fed by the Runner when a validator fails
 * against a tool result and the self-correction budget allows.
 *
 * The reducer is responsible for:
 *  - Appending the repair prompt as a `user` message (so it's part of the
 *    canonical message history and survives replay/checkpoint).
 *  - Bumping `selfCorrectionCount` when `consumesBudget` is true.
 *
 * Keeping this as an explicit input (vs. Runner mutating state) preserves
 * the determinism contract: replaying the same input sequence reproduces
 * the same (state, effects) sequence.
 */
export interface SelfCorrectInput {
  type: "self_correct";
  repairPrompt: string;
  /**
   * Whether this correction consumes one budget slot.
   * `true` for active repair attempts; `false` for terminal
   * "budget exhausted" notices that should not bump the counter again.
   */
  consumesBudget: boolean;
}

/**
 * Loop soft-reminder injection — fed by the Runner when the ladder's reminder
 * tier fires (error chain at K-1 with K >= 3, or repeat chain at K; spec
 * 2026-10-16 D2/D4). Shape-isomorphic to SelfCorrectInput; the reducer
 * appends the prompt as a `user` message and emits `context_reminder` with
 * kind `loop_reminder`.
 *
 * Reminders are a cheap signal: `consumesBudget` is the literal `false` and
 * no counter is touched (the `loopRemindedCount` dedup field is written
 * exclusively by the model_done ladder branch, never by this handler).
 */
export interface LoopReminderInput {
  type: "loop_reminder";
  repairPrompt: string;
  consumesBudget: false;
}

/**
 * Loop intervention injection — fed by the Runner when an error chain
 * reaches K and the intervention budget remains (spec 2026-10-16 D2).
 * Same shape as SelfCorrectInput, but budgets are fully separate: this
 * input bumps `loopInterventionCount`, never `selfCorrectionCount`
 * (spec D1 — two budgets, two event kinds, two texts).
 */
export interface LoopInterventionInput {
  type: "loop_intervention";
  repairPrompt: string;
  consumesBudget: true;
}

/** Runner requests HITL approval for a pending tool call (ask tier) */
export interface RequestApprovalInput {
  type: "request_approval";
  toolCallId: string;
}

/**
 * Durable write-back of deterministic tool-result pruning.
 *
 * The Runner prunes oversized `tool_result` text on the *request surface*
 * (see `pruneOversizedToolResults`) before calling the model. This input
 * rewrites the already-stored `state.messages` so the history the model
 * sees next turn matches what it saw last turn — keeping request surface
 * and canonical state in lockstep without the Runner mutating state.
 *
 * The reducer matches entries by `toolCallId` against `tool_result` blocks
 * and replaces their `content`. `charsBefore`/`charsAfter` ride along for
 * the transcript event only.
 */
export interface ToolResultsPrunedInput {
  type: "tool_results_pruned";
  entries: Array<{
    toolCallId: string;
    charsBefore: number;
    charsAfter: number;
    content: string | ToolResultBlock[];
    /** Tokenizer-estimated savings for this entry. */
    savedTokens?: number;
    /** Prefix invalidation price; present only on the earliest entry. */
    cacheResetTokens?: number;
    /**
     * True when cacheResetTokens came from the local estimate. Today this is
     * always true: there is no provider cache metric to price the invalidated
     * prefix; the field distinguishes the estimate from a future provider
     * value.
     */
    cacheResetEstimated?: boolean;
  }>;
}

/**
 * Durable write-back of a compaction decision.
 *
 * Replaces the span of messages named by `replacedIds` with a single
 * user-role summary message carrying `summaryId` / `summaryText`, at the
 * earliest position among the replaced span — followed, when preserved
 * images ride along, by one dedicated user-role images message (see
 * `preservedImages` below). Pins that pointed at replaced messages are
 * dropped; unknown ids are ignored.
 *
 * `summaryId` is supplied by the caller — the Runner stamps it via the `Id`
 * port on `StepContext` before feeding this input. The reducer never
 * invents or hardcodes the summary id.
 *
 * `preservedImages` (spec 2026-10-16-compaction-image-offload, D5 v1.2)
 * carries the image ref blocks that survive the compaction: when present
 * and non-empty they ride a dedicated USER-role message inserted right
 * after the summary — content `[marker, image, marker, image, …]`, markers
 * verbatim, one before each image.
 *
 * The summary itself is a USER-role message. A system-role summary is
 * hoisted by the ContextAssembler ahead of the static context layers
 * (AGENTS.md / skill catalogue), which moves those layers behind a changed
 * message and invalidates the whole provider prefix cache on every
 * compaction. As a user message it stays after the static prefix, so only
 * the rewritten history is re-read.
 *
 * `usage` is the summarization model call's own usage (when the adapter
 * reports it), carried into the recorded `compaction` event so the turn's
 * cache-hit / cost figures include the call instead of silently omitting it.
 */
export interface CompactionAppliedInput {
  type: "compaction_applied";
  summaryId: string;
  summaryText: string;
  replacedIds: string[];
  /** Image blocks with `source.type === "ref"` only — the Runner resolves
   *  inline bytes into refs (AttachmentStore) before feeding this input. */
  preservedImages?: ContentBlock[];
  /** Usage of the summarization model call, if the provider reported one. */
  usage?: TokenUsage;
}

/**
 * A background sub-agent was dispatched. Fed by the Runner when a detached
 * task starts, so state records the task even though the promise handle
 * never enters the reducer.
 */
export interface BackgroundTaskStartedInput {
  type: "background_task_started";
  taskId: string;
  subagentType?: string;
}

/**
 * A background sub-agent finished and its result is being handed to the
 * model. Fed at turn-boundary drain (or resume-loss fail); the reducer
 * appends the result as a user message and marks the task collected.
 */
export interface BackgroundTaskCompletedInput {
  type: "background_task_completed";
  taskId: string;
  text: string;
  isError?: boolean;
}

/**
 * Debounced batch of file-watch events, injected by the host/SDK when a
 * `FileWatcher` registration fires. The reducer appends (or, mid-turn,
 * queues) a notice message and — when idle — opens a turn.
 */
export interface FileChangedInput {
  type: "file_changed";
  watchId: string;
  events: FileWatchEvent[];
}

/** All possible inputs to the step() reducer */
export type AgentInput =
  | UserMessageInput
  | SteeringEditInput
  | SteeringRemoveInput
  | ModelChunkInput
  | ModelDoneInput
  | ModelErrorInput
  | ToolResultInput
  | ApprovalDecisionInput
  | RequestApprovalInput
  | CancelInput
  | BudgetExceededInput
  | SelfCorrectInput
  | LoopReminderInput
  | LoopInterventionInput
  | ToolResultsPrunedInput
  | CompactionAppliedInput
  | BackgroundTaskStartedInput
  | BackgroundTaskCompletedInput
  | FileChangedInput;
