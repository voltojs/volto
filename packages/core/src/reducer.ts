/**
 * step() — the pure functional reducer.
 * Takes (state, input) and returns { state, effects[] }.
 * Zero I/O, zero side effects, fully deterministic.
 */

import type { AgentState, AssistantMessage, ToolResultMessage, PendingToolCall, ReadFileRecord, Message } from "./state.js";
import type { ApprovalDenialReason, ReasoningEffortId } from "./ports.js";
import type { AgentInput } from "./input.js";
import type { Effect } from "./effect.js";
import type { ToolDefinition, JSONSchema } from "./tool.js";
import type { ContextLayer } from "./context-assembler.js";
import type { PermissionConfig } from "./permission-policy.js";
import { extractFileAccess, recordFileAccess } from "./file-gate.js";
import { detectLoop } from "./loop-detector.js";
import { assembleContext } from "./context-assembler.js";
import { permissionFingerprint, buildPermissionReminder } from "./permission-prompt.js";

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
  /** Max consecutive identical failed tool calls before loop intervention (undefined = no check) */
  maxLoopCount?: number;
  /** Structured / JSON output mode (passed through to ModelPort.stream) */
  responseFormat?: { type: "json"; schema?: JSONSchema };
  /** Optional context layers to inject as system messages */
  contextLayers?: ContextLayer[];
  /** Adapter-owned reasoning effort, passed through to ModelPort.stream. */
  reasoningEffort?: ReasoningEffortId;
  /**
   * The permission boundary in force. Supplied so the reducer can tell the
   * model about it — the model otherwise discovers the boundary only by
   * hitting it. Pure data; the reducer never enforces with it.
   */
  permissionConfig?: PermissionConfig;
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
  /** Accumulated reasoning text during model streaming */
  _accumulatedReasoning: string;
  /** Tool calls being accumulated during model streaming */
  _accumulatedToolCalls: Array<{
    id: string;
    name: string;
    argumentsText: string;
  }>;
  /** Tool call pending HITL approval (set when status is waiting_for_approval) */
  pendingApprovalTool?: PendingToolCall;
  /**
   * Buffer for tool results during parallel execution.
   * Results are collected by tool-call id; once ALL pendingTools have
   * reported, they are flushed in pendingTools order — guaranteeing that
   * the message sequence is independent of completion order and fully
   * deterministic for replay.
   */
  _toolResultBuffer: Record<string, ToolResultMessage>;
  /** Fingerprint of the permission config the model was last told about. */
  _announcedPermission?: string;
  /** The config behind `_announcedPermission`, kept so a change can be framed as one. */
  _announcedPermissionConfig?: PermissionConfig;
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
    tokensUsed: 0,
    maxIterations: 20,
    iterationCount: 0,
    readFiles: [],
    queuedUserInputs: [],
    toolCallCount: 0,
    maxToolCalls: undefined,
    maxCostDollars: undefined,
    maxTokensPerTurn: undefined,
    maxWallclockMs: undefined,
    maxLoopCount: undefined,
    pinnedMessageIds: [],
    selfCorrectionCount: 0,
    maxSelfCorrections: undefined,
    _accumulatedText: "",
    _accumulatedReasoning: "",
    _accumulatedToolCalls: [],
    _toolResultBuffer: {},
    ...overrides,
  };
}

/**
 * Reset turn-scoped fields so the next `user_message` input can be fed without
 * leaking accumulator state from the previous turn.
 *
 * Preserves cross-turn state (`messages`, `readFiles`, `tokenBudget`,
 * `maxIterations`) and clears: pending tools, pending approval, iteration /
 * token counters and the reducer's internal streaming accumulators. The result
 * is in `status: "idle"` and is ready to receive a new user message.
 *
 * SDK / Runner callers should use this instead of hand-crafting partial
 * overrides — the set of internal accumulator fields is reducer-private and
 * subject to change.
 */
export function resetTurnForNextInput(state: ReducerState): ReducerState {
  return {
    ...state,
    status: "idle",
    pendingTools: [],
    pendingApprovalTool: undefined,
    iterationCount: 0,
    tokensUsed: 0,
    toolCallCount: 0,
    selfCorrectionCount: 0,
    queuedUserInputs: [],
    _accumulatedText: "",
    _accumulatedReasoning: "",
    _accumulatedToolCalls: [],
    _toolResultBuffer: {},
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
  // Unified budget_exceeded handler — applies in all active states.
  // Terminates the turn with a clear reason; no exception.
  if (input.type === "budget_exceeded" && state.status !== "done" && state.status !== "idle") {
    return {
      state: {
        ...state,
        pendingTools: [],
        _toolResultBuffer: {},
        status: "done",
      },
      effects: [
        { type: "emit", event: { type: "budget_exceeded", data: { reason: input.reason } } },
        { type: "done" },
      ],
    };
  }

  // Unified self_correct handler — accepts in any active state. The Runner
  // injects this after a validator fails against a tool result and (for
  // active corrections) the self-correction budget allows. Keeping the
  // mutation in the reducer (vs. Runner mutating state directly) preserves
  // the determinism / replay contract.
  if (input.type === "self_correct" && state.status !== "done") {
    const repairMsg = { role: "user" as const, content: input.repairPrompt };
    return {
      state: {
        ...state,
        messages: [...state.messages, repairMsg],
        selfCorrectionCount: input.consumesBudget
          ? state.selfCorrectionCount + 1
          : state.selfCorrectionCount,
      },
      effects: [
        {
          type: "emit",
          event: {
            type: "self_correct",
            data: {
              consumesBudget: input.consumesBudget,
              correctionCount: input.consumesBudget
                ? state.selfCorrectionCount + 1
                : state.selfCorrectionCount,
            },
          },
        },
      ],
    };
  }

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
      return errorResult(state, "step() called on done state — turn is already complete");
    default:
      return errorResult(state, `Unknown status: ${state.status}`);
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

    // Announce the permission boundary when it is new or has changed. The
    // reminder goes in as an ordinary user-role message at the TAIL of the
    // history, never into the assembled static prefix: prompt caches match on
    // a prefix, so describing a mid-session change up front would invalidate
    // the whole cached prefix on every switch. Unchanged boundaries cost
    // nothing — no message, no tokens.
    const announcements: Message[] = [];
    let announced = state._announcedPermission;
    let announcedConfig = state._announcedPermissionConfig;
    if (ctx.permissionConfig) {
      const fingerprint = permissionFingerprint(ctx.permissionConfig);
      if (fingerprint !== announced) {
        announcements.push({
          role: "user",
          content: buildPermissionReminder(ctx.permissionConfig, announcedConfig),
        });
        announced = fingerprint;
        announcedConfig = ctx.permissionConfig;
      }
    }

    const newState: ReducerState = {
      ...state,
      messages: [...state.messages, ...announcements, userMsg],
      status: "calling_model",
      iterationCount: 0,
      _announcedPermission: announced,
      _announcedPermissionConfig: announcedConfig,
    };
    const effects: Effect[] = [
      buildCallModelEffect(newState.messages, newState.pinnedMessageIds, ctx),
      {
        type: "emit",
        event: { type: "user_message", data: { content: input.content } },
      },
    ];
    return { state: newState, effects };
  }

  return errorResult(state, `idle: unexpected input type "${input.type}"`);
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
      newState = {
        ...newState,
        _accumulatedReasoning: newState._accumulatedReasoning + chunk.text,
      };
      effects.push({
        type: "emit",
        event: { type: "reasoning_delta", data: { text: chunk.text } },
      });
    } else if (chunk.type === "tool_use_delta") {
      const existing = newState._accumulatedToolCalls;
      const last = existing[existing.length - 1];

      // Truthiness check is intentional: providers send empty strings for
      // id/name in continuation chunks (standard OpenAI streaming pattern).
      if (chunk.toolCallId && chunk.toolCallName) {
        // New tool call starting
        newState = {
          ...newState,
          _accumulatedToolCalls: [
            ...existing,
            { id: chunk.toolCallId, name: chunk.toolCallName, argumentsText: chunk.argumentsDelta ?? "" },
          ],
        };
        effects.push({
          type: "emit",
          event: {
            type: "tool_use_delta",
            data: {
              phase: "start",
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolCallName,
              argumentsDelta: chunk.argumentsDelta ?? "",
            },
          },
        });
      } else if (last && chunk.argumentsDelta) {
        // Arguments delta for existing tool call
        newState = {
          ...newState,
          _accumulatedToolCalls: [
            ...existing.slice(0, -1),
            { ...last, argumentsText: last.argumentsText + chunk.argumentsDelta },
          ],
        };
        effects.push({
          type: "emit",
          event: {
            type: "tool_use_delta",
            data: {
              phase: "args",
              toolCallId: last.id,
              toolName: last.name,
              argumentsDelta: chunk.argumentsDelta,
            },
          },
        });
      }
    }

    return { state: newState, effects };
  }

  if (input.type === "model_done") {
    const newIterationCount = state.iterationCount + 1;
    const newTokensUsed =
      state.tokensUsed +
      (input.usage
        ? input.usage.inputTokens +
          input.usage.outputTokens +
          (input.usage.cacheReadTokens ?? 0) +
          (input.usage.cacheWriteTokens ?? 0)
        : 0);

    // Finalize the assistant message
    const assistantContent = buildAssistantContent(state);
    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: assistantContent,
      stopReason: input.stopReason,
      ...(ctx.model !== undefined ? { source: { modelId: ctx.model } } : {}),
      ...(input.meta !== undefined ? { modelMeta: input.meta } : {}),
    };

    const baseState: ReducerState = {
      ...state,
      messages: [...state.messages, assistantMsg],
      iterationCount: newIterationCount,
      tokensUsed: newTokensUsed,
      _accumulatedText: "",
      _accumulatedReasoning: "",
      _accumulatedToolCalls: [],
    };

    const emitEffect: Effect = {
      type: "emit",
      event: {
        type: "model_done",
        data: {
          stopReason: input.stopReason,
          usage: input.usage,
          // The Runner records this verbatim into the transcript's
          // assistant_message event; handing it over here avoids a second,
          // possibly divergent reassembly on the imperative side.
          message: assistantMsg,
        },
      },
    };

    // Runaway guard — applies to every path that would issue another model call.
    // Covers both the tool_use loop and max_tokens continuation.
    const limit = limitReached(baseState);

    // tool_use → extract pending tools, transition to executing_tools
    if (input.stopReason === "tool_use") {
      const toolCalls = extractToolCalls(assistantMsg);
      const newToolCallCount = baseState.toolCallCount + toolCalls.length;
      const baseWithToolCount = { ...baseState, toolCallCount: newToolCallCount };
      const limit2 = limitReached(baseWithToolCount);
      if (limit2) {
        return {
          state: { ...baseWithToolCount, pendingTools: [], status: "done" },
          effects: [
            emitEffect,
            { type: "emit", event: { type: "error", data: { error: limit2 } } },
            { type: "done" },
          ],
        };
      }

      // Loop / oscillation detection: check if these new tool calls
      // repeat a sequence of K identical failed calls.
      if (ctx.maxLoopCount !== undefined && ctx.maxLoopCount >= 2) {
        const loopResult = detectLoop(state.messages, assistantMsg, toolCalls, ctx.maxLoopCount);
        if (loopResult.detected) {
          const loopError = `Loop detected: tool "${loopResult.toolName}" has been called ${loopResult.consecutiveCount} times with identical input and returned errors`;
          return {
            state: { ...baseWithToolCount, pendingTools: [], status: "done" },
            effects: [
              emitEffect,
              { type: "emit", event: { type: "error", data: { error: loopError } } },
              { type: "done" },
            ],
          };
        }
      }

      return {
        state: { ...baseWithToolCount, pendingTools: toolCalls, status: "executing_tools" },
        effects: [
          emitEffect,
          ...toolCalls.map<Effect>((tc) => ({
            type: "emit",
            event: {
              type: "tool_use_complete",
              data: {
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.input,
              },
            },
          })),
        ],
      };
    }

    // max_tokens → continue or error
    if (input.stopReason === "max_tokens") {
      if (limit) {
        return {
          state: { ...baseState, status: "done" },
          effects: [
            emitEffect,
            { type: "emit", event: { type: "error", data: { error: limit } } },
            { type: "done" },
          ],
        };
      }
      // Ask model to continue
      return {
        state: { ...baseState, status: "calling_model" },
        effects: [
          emitEffect,
          buildCallModelEffect(baseState.messages, baseState.pinnedMessageIds, ctx),
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
      // Retries count against the same runaway guard as completed turns —
      // otherwise a persistently failing endpoint (bad baseURL, DNS failure)
      // retries forever with no backoff, spinning the host process.
      const retryState: ReducerState = {
        ...state,
        iterationCount: state.iterationCount + 1,
        _accumulatedText: "",
        _accumulatedReasoning: "",
        _accumulatedToolCalls: [],
      };
      const limit = limitReached(retryState);
      if (limit) {
        return {
          state: { ...retryState, status: "done" },
          effects: [
            { type: "emit", event: { type: "error", data: { error: input.error, retriable: true } } },
            { type: "emit", event: { type: "error", data: { error: limit } } },
            { type: "done" },
          ],
        };
      }
      return {
        state: retryState,
        effects: [
          { type: "emit", event: { type: "error", data: { error: input.error, retriable: true } } },
          buildCallModelEffect(retryState.messages, retryState.pinnedMessageIds, ctx),
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

  if (input.type === "user_message") {
    // Steering: queue for injection at next turn boundary
    const userMsg = { role: "user" as const, content: input.content };
    return {
      state: { ...state, queuedUserInputs: [...state.queuedUserInputs, userMsg] },
      effects: [{ type: "emit", event: { type: "steering_queued", data: { content: input.content } } }],
    };
  }

  return errorResult(state, `calling_model: unexpected input type "${input.type}"`);
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

    // Record file access from this result (pure, deterministic)
    const fileAccess = input.result.isError ? null : extractFileAccess(input.result.displayMetadata);
    const readFiles: ReadFileRecord[] = fileAccess
      ? recordFileAccess(state.readFiles, fileAccess)
      : state.readFiles;

    // Buffer the result by tool-call id
    const newBuffer = { ...state._toolResultBuffer, [input.toolCallId]: toolResultMsg };

    // Emit a tool_result observability event for every result as it arrives.
    // displayMetadata.durationMs (and other host annotations) flow through so
    // tracing sinks can show timing without re-querying the runtime.
    const matchingIndex = state.pendingTools.findIndex((t) => t.id === input.toolCallId);
    const matchingTool = matchingIndex >= 0 ? state.pendingTools[matchingIndex] : undefined;
    const resultEmit: Effect = {
      type: "emit",
      event: {
        type: "tool_result",
        data: {
          toolCallId: input.toolCallId,
          toolName: matchingTool?.name,
          isError: input.result.isError ?? false,
          durationMs: input.result.displayMetadata?.["durationMs"],
          // The result's own text and host annotations, so the transcript can
          // record what the tool actually produced rather than just that it ran.
          content: input.result.modelContent,
          displayMetadata: input.result.displayMetadata,
          // Results arrive in completion order but flush in pendingTools order
          // (see the allDone branch below). Carrying the index lets a reader
          // reconstruct the flushed order without replaying the reducer.
          orderInBatch: matchingIndex,
        },
      },
    };

    // Check if ALL pending tools have reported
    const allDone = state.pendingTools.every((t) => t.id in newBuffer);

    if (!allDone) {
      // More tools to finish — buffer and wait
      return {
        state: {
          ...state,
          _toolResultBuffer: newBuffer,
          readFiles,
        },
        effects: [resultEmit],
      };
    }

    // All tools done — flush in pendingTools order for deterministic replay
    const orderedResultMsgs = state.pendingTools
      .map((t) => newBuffer[t.id])
      .filter((msg): msg is ToolResultMessage => msg !== undefined);

    // Drain steering queue: inject queued user messages at the turn boundary
    const drainedMessages: Message[] = [
      ...state.messages,
      ...orderedResultMsgs,
      ...state.queuedUserInputs,
    ];

    const newState: ReducerState = {
      ...state,
      messages: drainedMessages,
      pendingTools: [],
      _toolResultBuffer: {},
      queuedUserInputs: [],
      readFiles,
      status: "calling_model",
    };

    return {
      state: newState,
      effects: [
        resultEmit,
        buildCallModelEffect(newState.messages, newState.pinnedMessageIds, ctx),
      ],
    };
  }

  if (input.type === "request_approval") {
    const tool = state.pendingTools.find((t) => t.id === input.toolCallId);
    if (!tool) {
      return errorResult(state, `request_approval: tool call "${input.toolCallId}" not found in pendingTools`);
    }
    const toolDef = ctx.tools.find((td) => td.name === tool.name);
    const riskTier = toolDef?.riskTier ?? "WRITE_HIGH";
    const remainingTools = state.pendingTools.filter((t) => t.id !== input.toolCallId);
    const newState: ReducerState = {
      ...state,
      pendingTools: remainingTools,
      pendingApprovalTool: tool,
      status: "waiting_for_approval",
    };
    return {
      state: newState,
      effects: [
        { type: "request_approval", toolCall: tool, riskTier },
        { type: "checkpoint", state: newState },
      ],
    };
  }

  if (input.type === "cancel") {
    return {
      state: { ...state, status: "cancelling", pendingTools: [], _toolResultBuffer: {} },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }

  if (input.type === "user_message") {
    // Steering: queue for injection at next turn boundary
    const userMsg = { role: "user" as const, content: input.content };
    return {
      state: { ...state, queuedUserInputs: [...state.queuedUserInputs, userMsg] },
      effects: [{ type: "emit", event: { type: "steering_queued", data: { content: input.content } } }],
    };
  }

  return errorResult(state, `executing_tools: unexpected input type "${input.type}"`);
}

/**
 * The tool result a denied call reports back to the MODEL.
 *
 * The reason matters to what the model does next. Told "the user denied
 * this", it asks a follow-up question — correct when a human clicked deny,
 * useless when the connection dropped and nobody is there to answer. The
 * fail-closed paths therefore say so, and say not to ask.
 *
 * `user` and an absent reason produce the identical original wording, so
 * recorded replays of user denials are unaffected.
 */
function denialMessageFor(toolName: string, reason?: ApprovalDenialReason): string {
  switch (reason) {
    case "connection-lost":
      return (
        `Tool "${toolName}" was denied automatically: the client connection dropped ` +
        `while the approval was pending, so it was refused rather than left running. ` +
        `Nobody is currently connected to answer — do not ask for confirmation. ` +
        `Stop and report that the request needs to be retried once reconnected.`
      );
    case "interrupted":
      return (
        `Tool "${toolName}" was denied automatically: the turn was interrupted while ` +
        `the approval was pending. This was not a judgement on the call itself. ` +
        `Stop the current line of work rather than asking for confirmation.`
      );
    default:
      return `Tool "${toolName}" was denied by the user.`;
  }
}

function handleWaitingForApproval(state: ReducerState, input: AgentInput, ctx: StepContext): StepResult {
  if (input.type === "approval_decision") {
    const approvedTool = state.pendingApprovalTool;
    if (!approvedTool || approvedTool.id !== input.toolCallId) {
      return errorResult(state, `approval_decision: tool call "${input.toolCallId}" not found in pending approval`);
    }

    if (input.decision === "allow") {
      return {
        state: {
          ...state,
          pendingTools: [...state.pendingTools, approvedTool],
          pendingApprovalTool: undefined,
          status: "executing_tools",
        },
        effects: [],
      };
    }

    // Denied — buffer the error result; it will be flushed in pendingTools
    // order alongside parallel tool results for deterministic replay.
    const denyResultMsg: ToolResultMessage = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: input.toolCallId,
          content: denialMessageFor(approvedTool.name, input.reason),
          isError: true,
        },
      ],
    };

    const newBuffer = { ...state._toolResultBuffer, [input.toolCallId]: denyResultMsg };

    // Put the tool back on the batch roster. `request_approval` took it out of
    // pendingTools (above), but pendingTools is also what the completion path
    // uses as the batch's *full* roster when it flushes — see
    // handleExecutingTools' `state.pendingTools.map(...)`. A denied tool left
    // off the roster has its buffered message silently dropped the moment a
    // sibling reports, and `_toolResultBuffer` is cleared right after, losing
    // it for good. The allow branch above restores the tool for the same
    // reason; a denial has to as well — it simply arrives already resolved.
    //
    // Appending (rather than restoring the original index, which the filtered
    // list no longer knows) mirrors what the allow branch does. Ordering among
    // a batch's results is not load-bearing — providers pair tool_result to
    // tool_use by id — and it stays deterministic under replay.
    const rosterWithDenied = [...state.pendingTools, approvedTool];

    // Flush only once every tool on the roster has resolved. Testing the
    // roster rather than "are there other pending tools" is what makes the
    // single-tool case still flush immediately: the denied tool is the whole
    // roster, and its result is already buffered.
    const allResolved = rosterWithDenied.every((t) => t.id in newBuffer);

    if (!allResolved) {
      return {
        state: {
          ...state,
          pendingTools: rosterWithDenied,
          _toolResultBuffer: newBuffer,
          pendingApprovalTool: undefined,
          status: "executing_tools",
        },
        effects: [],
      };
    }

    // Every tool in the batch has resolved — flush in roster order.
    const orderedResultMsgs = rosterWithDenied
      .map((t) => newBuffer[t.id])
      .filter((msg): msg is ToolResultMessage => msg !== undefined);

    // Drain steering queue at turn boundary
    const drainedMessages: Message[] = [
      ...state.messages,
      ...orderedResultMsgs,
      ...state.queuedUserInputs,
    ];

    return {
      state: {
        ...state,
        messages: drainedMessages,
        pendingTools: [],
        _toolResultBuffer: {},
        queuedUserInputs: [],
        pendingApprovalTool: undefined,
        status: "calling_model",
      },
      effects: [
        buildCallModelEffect(drainedMessages, state.pinnedMessageIds, ctx),
      ],
    };
  }

  if (input.type === "cancel") {
    return {
      state: { ...state, status: "cancelling", pendingTools: [] },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }

  return errorResult(state, `waiting_for_approval: unexpected input type "${input.type}"`);
}

function handleWaitingForInput(state: ReducerState, input: AgentInput): StepResult {
  if (input.type === "cancel") {
    return {
      state: { ...state, status: "cancelling" },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }
  return errorResult(state, `waiting_for_input: unexpected input type "${input.type}"`);
}

function handleCancelling(state: ReducerState, input: AgentInput): StepResult {
  if (input.type === "cancel") {
    return {
      state: { ...state, status: "done" },
      effects: [{ type: "done" }],
    };
  }
  return errorResult(state, `cancelling: unexpected input type "${input.type}"`);
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Return a StepResult that emits an error event and leaves state unchanged.
 * The reducer must NEVER throw — all error conditions are expressed as
 * error events + state preservation, so the Runner's main loop is never
 * interrupted by an unhandled exception.
 */
function errorResult(state: ReducerState, message: string): StepResult {
  return {
    state,
    effects: [
      { type: "emit", event: { type: "error", data: { error: message } } },
    ],
  };
}

/**
 * Runaway guard — returns an error message if the turn has hit its iteration
 * cap or token budget, otherwise null. Checked before issuing any further
 * model call (tool_use loop continuation or max_tokens continuation).
 */
function limitReached(state: ReducerState): string | null {
  if (state.iterationCount >= state.maxIterations) {
    return "Maximum iterations reached";
  }
  if (state.tokenBudget !== undefined && state.tokensUsed >= state.tokenBudget) {
    return "Token budget exceeded";
  }
  if (state.maxToolCalls !== undefined && state.toolCallCount >= state.maxToolCalls) {
    return "Tool call limit exceeded";
  }
  return null;
}

/** Build assistant content blocks from accumulated streaming data */
function buildAssistantContent(state: ReducerState): AssistantMessage["content"] {
  const content: AssistantMessage["content"] = [];

  // Reasoning leads the content: providers that require their thinking blocks
  // returned expect them ahead of the text and tool calls they produced.
  if (state._accumulatedReasoning) {
    content.push({ type: "reasoning", text: state._accumulatedReasoning });
  }

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

/**
 * Build a `call_model` effect with cache-friendly message ordering and
 * provider-cache breakpoints derived from ContextAssembler.
 *
 * Centralized so every site that issues a model call gets identical
 * static-prefix treatment (system / pinned messages first, breakpoints at
 * boundaries). Pure — no I/O, no random.
 */
function buildCallModelEffect(
  messages: Message[],
  pinnedMessageIds: string[] | undefined,
  ctx: StepContext,
): Effect {
  const assembled = assembleContext({
    messages,
    tools: ctx.tools,
    pinnedMessageIds,
    contextLayers: ctx.contextLayers,
  });
  return {
    type: "call_model",
    request: {
      messages: assembled.messages,
      tools: ctx.tools,
      model: ctx.model,
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      cacheBreakpoints: assembled.cacheBreakpoints,
      layerOrigins: assembled.layerOrigins,
    },
  };
}
