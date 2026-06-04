/**
 * Effect — all possible effects emitted by the step() reducer.
 * Effects are the core's way of expressing intent to perform I/O.
 * The Runner interprets these effects and calls the corresponding ports.
 */

import type { AgentState, Message, PendingToolCall } from "./state.js";
import type { RiskTier, ToolDefinition } from "./tool.js";

/** Request the model to generate a response */
export interface CallModelEffect {
  type: "call_model";
  request: {
    messages: Message[];
    tools: ToolDefinition[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
  };
}

/** Execute a single tool call */
export interface ExecuteToolEffect {
  type: "execute_tool";
  toolCall: PendingToolCall;
}

/** Request human approval for a tool call */
export interface RequestApprovalEffect {
  type: "request_approval";
  toolCall: PendingToolCall;
  riskTier: RiskTier;
}

/** Emit an event to the EventSink (streaming tokens, status changes, etc.) */
export interface EmitEffect {
  type: "emit";
  event: {
    type: string;
    data: Record<string, unknown>;
  };
}

/** Save a checkpoint (state snapshot) to SessionStore */
export interface CheckpointEffect {
  type: "checkpoint";
  state: AgentState;
}

/** Pause execution and wait for external input */
export interface WaitForInputEffect {
  type: "wait_for_input";
  reason: string;
}

/** Signal that the turn is complete */
export interface DoneEffect {
  type: "done";
}

/** All possible effects emitted by the step() reducer */
export type Effect =
  | CallModelEffect
  | ExecuteToolEffect
  | RequestApprovalEffect
  | EmitEffect
  | CheckpointEffect
  | WaitForInputEffect
  | DoneEffect;
