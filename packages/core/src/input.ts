/**
 * AgentInput — all possible inputs to the step() reducer.
 * Every input is a plain, serializable data object.
 */

import type { ContentBlock } from "./state.js";

/** User sent a message */
export interface UserMessageInput {
  type: "user_message";
  content: string | ContentBlock[];
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
  };
}

/** Model encountered an error */
export interface ModelErrorInput {
  type: "model_error";
  error: string;
  retriable?: boolean;
}

/** Tool execution result (returned by Runner after ExecuteTool effect) */
export interface ToolResultInput {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  result: {
    modelContent: string;
    isError?: boolean;
    displayMetadata?: Record<string, unknown>;
  };
}

/** HITL approval decision (returned after RequestApproval effect) */
export interface ApprovalDecisionInput {
  type: "approval_decision";
  toolCallId: string;
  decision: "allow" | "deny";
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

/** Runner requests HITL approval for a pending tool call (ask tier) */
export interface RequestApprovalInput {
  type: "request_approval";
  toolCallId: string;
}

/** All possible inputs to the step() reducer */
export type AgentInput =
  | UserMessageInput
  | ModelChunkInput
  | ModelDoneInput
  | ModelErrorInput
  | ToolResultInput
  | ApprovalDecisionInput
  | RequestApprovalInput
  | CancelInput
  | BudgetExceededInput;
