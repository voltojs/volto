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
    /**
     * Cache breakpoints (message indices) computed by ContextAssembler.
     * Providers translate these to native cache_control mechanisms
     * (Anthropic: cache_control: ephemeral; OpenAI: diagnostic only).
     * When omitted, providers fall back to their default cache behavior.
     */
    cacheBreakpoints?: number[];
    /** Mapping of context layer IDs to their message indices in the assembled context */
    layerOrigins?: Array<{ id: string; messageIndex: number }>;
  };
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

/** Signal that the turn is complete */
export interface DoneEffect {
  type: "done";
}

/** All possible effects emitted by the step() reducer */
export type Effect =
  | CallModelEffect
  | RequestApprovalEffect
  | EmitEffect
  | CheckpointEffect
  | DoneEffect;
