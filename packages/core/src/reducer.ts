/**
 * step() — the pure functional reducer.
 * Takes (state, input) and returns { state, effects[] }.
 * Zero I/O, zero side effects, fully deterministic.
 */

import type { AgentState, AssistantMessage, ToolResultMessage, PendingToolCall } from "./state.js";
import type { AgentInput } from "./input.js";
import type { Effect } from "./effect.js";
import type { ToolDefinition } from "./tool.js";

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

export interface StepResult {
  state: ReducerState;
  effects: Effect[];
}

/** Context passed to step() — tools and config, not serializable state */
export interface StepContext {
  tools: ToolDefinition[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

// ──────────────────────────────────────────────
// Extended state (internal accumulator fields)
// ──────────────────────────────────────────────

/**
 * AgentState extended with internal fields used by the reducer
 * for accumulating streaming data. These are set to defaults by createInitialState()
 * and reset between turns.
 */
export interface ReducerState extends AgentState {
  /** Accumulated text content during model streaming */
  _accumulatedText: string;
  /** Tool calls being accumulated during model streaming */
  _accumulatedToolCalls: Array<{
    id: string;
    name: string;
    argumentsText: string;
  }>;
}

// ──────────────────────────────────────────────
// createInitialState
// ──────────────────────────────────────────────

export function createInitialState(overrides?: Partial<AgentState>): ReducerState {
  return {
    messages: [],
    pendingTools: [],
    status: "idle",
    tokenBudget: undefined,
    maxIterations: 20,
    iterationCount: 0,
    readFiles: [],
    _accumulatedText: "",
    _accumulatedToolCalls: [],
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// step()
// ──────────────────────────────────────────────

export function step(
  state: ReducerState,
  input: AgentInput,
  ctx: StepContext,
): StepResult {
  switch (state.status) {
    case "idle":
      return handleIdle(state, input, ctx);
    case "calling_model":
      return handleCallingModel(state, input, ctx);
    case "executing_tools":
      return handleExecutingTools(state, input, ctx);
    case "waiting_for_approval":
      return handleWaitingForApproval(state, input, ctx);
    case "waiting_for_input":
      return handleWaitingForInput(state, input);
    case "cancelling":
      return handleCancelling(state, input);
    case "done":
      throw new Error("step() called on done state — turn is already complete");
    default:
      throw new Error(`Unknown status: ${state.status}`);
  }
}

// ──────────────────────────────────────────────
// Status handlers
// ──────────────────────────────────────────────

function handleIdle(state: ReducerState, input: AgentInput, ctx: StepContext): StepResult {
  if (input.type === "user_message") {
    const userMsg = {
      role: "user" as const,
      content: input.content,
    };
    const newState: ReducerState = {
      ...state,
      messages: [...state.messages, userMsg],
      status: "calling_model",
      iterationCount: 0,
    };
    const effects: Effect[] = [
      {
        type: "call_model",
        request: {
          messages: newState.messages,
          tools: ctx.tools,
          model: ctx.model,
          maxTokens: ctx.maxTokens,
          temperature: ctx.temperature,
        },
      },
      {
        type: "emit",
        event: { type: "user_message", data: { content: input.content } },
      },
    ];
    return { state: newState, effects };
  }

  throw new Error(`idle: unexpected input type "${input.type}"`);
}

function handleCallingModel(state: ReducerState, input: AgentInput, ctx: StepContext): StepResult {
  if (input.type === "model_chunk") {
    const { chunk } = input;
    const effects: Effect[] = [];
    let newState = state;

    if (chunk.type === "text_delta" && chunk.text) {
      newState = { ...newState, _accumulatedText: newState._accumulatedText + chunk.text };
      effects.push({
        type: "emit",
        event: { type: "text_delta", data: { text: chunk.text } },
      });
    } else if (chunk.type === "reasoning_delta" && chunk.text) {
      effects.push({
        type: "emit",
        event: { type: "reasoning_delta", data: { text: chunk.text } },
      });
    } else if (chunk.type === "tool_use_delta") {
      const existing = newState._accumulatedToolCalls;
      const last = existing[existing.length - 1];

      if (chunk.toolCallId && chunk.toolCallName) {
        // New tool call starting
        newState = {
          ...newState,
          _accumulatedToolCalls: [
            ...existing,
            { id: chunk.toolCallId, name: chunk.toolCallName, argumentsText: chunk.argumentsDelta ?? "" },
          ],
        };
      } else if (last && chunk.argumentsDelta) {
        // Arguments delta for existing tool call
        newState = {
          ...newState,
          _accumulatedToolCalls: [
            ...existing.slice(0, -1),
            { ...last, argumentsText: last.argumentsText + chunk.argumentsDelta },
          ],
        };
      }
    }

    return { state: newState, effects };
  }

  if (input.type === "model_done") {
    const newIterationCount = state.iterationCount + 1;

    // Finalize the assistant message
    const assistantContent = buildAssistantContent(state);
    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: assistantContent,
      stopReason: input.stopReason,
    };

    const baseState: ReducerState = {
      ...state,
      messages: [...state.messages, assistantMsg],
      iterationCount: newIterationCount,
      _accumulatedText: "",
      _accumulatedToolCalls: [],
    };

    const emitEffect: Effect = {
      type: "emit",
      event: { type: "model_done", data: { stopReason: input.stopReason, usage: input.usage } },
    };

    // tool_use → extract pending tools, transition to executing_tools
    if (input.stopReason === "tool_use") {
      const toolCalls = extractToolCalls(assistantMsg);
      return {
        state: { ...baseState, pendingTools: toolCalls, status: "executing_tools" },
        effects: [emitEffect],
      };
    }

    // max_tokens → continue or error
    if (input.stopReason === "max_tokens") {
      if (newIterationCount >= state.maxIterations) {
        return {
          state: { ...baseState, status: "done" },
          effects: [
            emitEffect,
            { type: "emit", event: { type: "error", data: { error: "Maximum iterations reached with incomplete response" } } },
            { type: "done" },
          ],
        };
      }
      // Ask model to continue
      return {
        state: { ...baseState, status: "calling_model" },
        effects: [
          emitEffect,
          {
            type: "call_model",
            request: {
              messages: baseState.messages,
              tools: ctx.tools,
              model: ctx.model,
              maxTokens: ctx.maxTokens,
              temperature: ctx.temperature,
            },
          },
        ],
      };
    }

    // end_turn or pure text → done
    return {
      state: { ...baseState, status: "done" },
      effects: [emitEffect, { type: "done" }],
    };
  }

  if (input.type === "model_error") {
    if (input.retriable) {
      return {
        state,
        effects: [
          { type: "emit", event: { type: "error", data: { error: input.error, retriable: true } } },
          {
            type: "call_model",
            request: {
              messages: state.messages,
              tools: ctx.tools,
              model: ctx.model,
              maxTokens: ctx.maxTokens,
              temperature: ctx.temperature,
            },
          },
        ],
      };
    }

    // Non-retriable error → done
    return {
      state: { ...state, status: "done" },
      effects: [
        { type: "emit", event: { type: "error", data: { error: input.error } } },
        { type: "done" },
      ],
    };
  }

  if (input.type === "cancel") {
    return {
      state: { ...state, status: "cancelling" },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }

  throw new Error(`calling_model: unexpected input type "${input.type}"`);
}

function handleExecutingTools(state: ReducerState, input: AgentInput, ctx: StepContext): StepResult {
  if (input.type === "tool_result") {
    const toolResultMsg: ToolResultMessage = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: input.toolCallId,
          content: input.result.modelContent,
          isError: input.result.isError,
        },
      ],
    };

    const remainingTools = state.pendingTools.filter((t) => t.id !== input.toolCallId);

    if (remainingTools.length > 0) {
      // More tools to execute
      return {
        state: {
          ...state,
          messages: [...state.messages, toolResultMsg],
          pendingTools: remainingTools,
        },
        effects: [],
      };
    }

    // All tools done → call model again
    const newState: ReducerState = {
      ...state,
      messages: [...state.messages, toolResultMsg],
      pendingTools: [],
      status: "calling_model",
    };
    return {
      state: newState,
      effects: [
        {
          type: "call_model",
          request: {
            messages: newState.messages,
            tools: ctx.tools,
            model: ctx.model,
            maxTokens: ctx.maxTokens,
            temperature: ctx.temperature,
          },
        },
      ],
    };
  }

  if (input.type === "cancel") {
    return {
      state: { ...state, status: "cancelling", pendingTools: [] },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }

  throw new Error(`executing_tools: unexpected input type "${input.type}"`);
}

function handleWaitingForApproval(state: ReducerState, input: AgentInput, ctx: StepContext): StepResult {
  if (input.type === "approval_decision") {
    if (input.decision === "allow") {
      const approvedTool = state.pendingTools.find((t) => t.id === input.toolCallId);
      if (!approvedTool) {
        throw new Error(`approval_decision: tool call "${input.toolCallId}" not found in pendingTools`);
      }
      return {
        state: { ...state, status: "executing_tools" },
        effects: [{ type: "execute_tool", toolCall: approvedTool }],
      };
    }
    // Denied → add error result to messages, remove from pending, continue
    const deniedTool = state.pendingTools.find((t) => t.id === input.toolCallId);
    if (!deniedTool) {
      throw new Error(`approval_decision: tool call "${input.toolCallId}" not found in pendingTools`);
    }
    const remainingTools = state.pendingTools.filter((t) => t.id !== input.toolCallId);
    const toolResultMsg: ToolResultMessage = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: input.toolCallId,
          content: `Tool "${deniedTool.name}" was denied by the user.`,
          isError: true,
        },
      ],
    };
    if (remainingTools.length > 0) {
      return {
        state: { ...state, messages: [...state.messages, toolResultMsg], pendingTools: remainingTools, status: "executing_tools" },
        effects: [],
      };
    }
    // All tools processed (denied), call model again
    return {
      state: { ...state, messages: [...state.messages, toolResultMsg], pendingTools: [], status: "calling_model" },
      effects: [
        {
          type: "call_model",
          request: {
            messages: [...state.messages, toolResultMsg],
            tools: ctx.tools,
            model: ctx.model,
            maxTokens: ctx.maxTokens,
            temperature: ctx.temperature,
          },
        },
      ],
    };
  }

  if (input.type === "cancel") {
    return {
      state: { ...state, status: "cancelling", pendingTools: [] },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }

  throw new Error(`waiting_for_approval: unexpected input type "${input.type}"`);
}

function handleWaitingForInput(state: ReducerState, input: AgentInput): StepResult {
  if (input.type === "cancel") {
    return {
      state: { ...state, status: "cancelling" },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }
  throw new Error(`waiting_for_input: unexpected input type "${input.type}"`);
}

function handleCancelling(state: ReducerState, input: AgentInput): StepResult {
  if (input.type === "cancel") {
    return {
      state: { ...state, status: "done" },
      effects: [{ type: "done" }],
    };
  }
  throw new Error(`cancelling: unexpected input type "${input.type}"`);
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Build assistant content blocks from accumulated streaming data */
function buildAssistantContent(state: ReducerState): AssistantMessage["content"] {
  const content: AssistantMessage["content"] = [];

  if (state._accumulatedText) {
    content.push({ type: "text", text: state._accumulatedText });
  }

  for (const tc of state._accumulatedToolCalls) {
    let parsedInput: Record<string, unknown> = {};
    try {
      parsedInput = JSON.parse(tc.argumentsText) as Record<string, unknown>;
    } catch {
      // Malformed JSON — keep as empty object, tool router will report error
    }
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: parsedInput,
    });
  }

  return content;
}

/** Extract PendingToolCall[] from an assistant message's tool_use content */
function extractToolCalls(msg: AssistantMessage): PendingToolCall[] {
  return msg.content
    .filter((c): c is import("./state.js").ToolUseContent => c.type === "tool_use")
    .map((c) => ({ id: c.id, name: c.name, input: c.input }));
}
