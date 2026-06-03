/**
 * Runner — thin effect interpreter for the agent core loop.
 *
 * Drives the step(state, input, ctx) → { state, effects[] } cycle,
 * interpreting each Effect by calling the corresponding port adapter.
 * All I/O happens here; the core reducer stays pure.
 */

import type {
  AgentInput,
  Effect,
  ModelPort,
  EventSink,
  PendingToolCall,
  ModelEvent,
  ToolResult,
  Clock,
} from "@agent-core/core";
import { step, createInitialState, filterVisibleTools, routeToolCall } from "@agent-core/core";
import type { StepContext, ReducerState } from "@agent-core/core";

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

export type ToolExecutor = (call: PendingToolCall) => Promise<ToolResult>;

export interface RunnerOptions {
  modelPort: ModelPort;
  stepContext: StepContext;
  eventSink?: EventSink;
  toolExecutor?: ToolExecutor;
  abortSignal?: AbortSignal;
  initialState?: ReducerState;
  availableCapabilities?: Set<string>;
  clock?: Clock;
}

export interface Runner {
  run(initialInput: AgentInput): Promise<ReducerState>;
  getState(): ReducerState;
}

// ──────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────

export function createRunner(opts: RunnerOptions): Runner {
  let state: ReducerState = opts.initialState ?? createInitialState();
  let cancelled = false;

  const availableCapabilities = opts.availableCapabilities ?? new Set<string>();
  const visibleTools = filterVisibleTools(opts.stepContext.tools, availableCapabilities);
  const stepContext: StepContext = {
    ...opts.stepContext,
    tools: visibleTools,
  };

  const clock: Clock = opts.clock ?? { now: Date.now };

  const onAbort = (): void => { cancelled = true; };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      cancelled = true;
    } else {
      opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  /** Feed an input to the pure reducer, update state, return effects. */
  function feed(input: AgentInput): Effect[] {
    const result = step(state, input, stepContext);
    state = result.state;
    return result.effects;
  }

  /** Forward emit effects to EventSink. */
  function forwardEmit(effects: Effect[]): void {
    for (const e of effects) {
      if (e.type === "emit") opts.eventSink?.emit(e.event);
    }
  }

  function cleanup(): void {
    if (opts.abortSignal) {
      opts.abortSignal.removeEventListener("abort", onAbort);
    }
  }

  function getStatus(): string {
    return state.status;
  }

  function updateReadFileRecord(path: string): void {
    const existing = state.readFiles.find((entry) => entry.path === path);
    if (existing) {
      state = {
        ...state,
        readFiles: state.readFiles.map((entry) =>
          entry.path === path ? { ...entry, version: entry.version + 1, readAt: clock.now() } : entry,
        ),
      };
      return;
    }

    state = {
      ...state,
      readFiles: [...state.readFiles, { path, version: 1, readAt: clock.now() }],
    };
  }

  // ── Model streaming ──────────────────────────

  /**
   * Stream from ModelPort, feed chunks to the reducer.
   * Returns when the stream is consumed or the agent leaves calling_model status.
   *
   * Key behavior: if the stream ends and the reducer never received a done/error
   * event (e.g. empty stream), synthesizes a model_done(end_turn).
   * If a retriable error occurs and the reducer stays in calling_model,
   * returns without synthesizing — the main loop will call runModelStream again.
   */
  async function runModelStream(): Promise<void> {
    const req = {
      messages: state.messages,
      tools: stepContext.tools,
      model: stepContext.model,
      maxTokens: stepContext.maxTokens,
      temperature: stepContext.temperature,
      abortSignal: opts.abortSignal,
    };

    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
    let receivedTerminal = false; // true after done or error event is fed

    try {
      const stream = opts.modelPort.stream(req);

      for await (const event of stream) {
        if (cancelled && getStatus() !== "cancelling" && getStatus() !== "done") {
          forwardEmit(feed({ type: "cancel", reason: "abort" }));
          return;
        }

        // Track usage separately (attach to the next done event)
        if (event.type === "usage") {
          lastUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
          continue;
        }

        // Mark terminal events (done or error)
        if (event.type === "done" || event.type === "error") {
          receivedTerminal = true;
        }

        // Convert and feed model events
        for (const input of modelEventToInputs(event, lastUsage)) {
          if (event.type === "done") lastUsage = undefined;
          forwardEmit(feed(input));
        }

        // After processing events, check if we should stop streaming
        const status = getStatus();
        if (status !== "calling_model") {
          return;
        }
      }

      // Stream ended. Only synthesize model_done if the reducer never
      // received a done or error event (e.g. the stream was empty or
      // only contained usage events).
      if (!receivedTerminal && getStatus() === "calling_model") {
        forwardEmit(feed({ type: "model_done", stopReason: "end_turn", usage: lastUsage }));
      }
    } catch (err: unknown) {
      if (getStatus() === "calling_model") {
        const error = err instanceof Error ? err.message : String(err);
        forwardEmit(feed({ type: "model_error", error, retriable: false }));
      }
    }
  }

  // ── Tool execution ───────────────────────────

  async function executeTool(toolCall: PendingToolCall): Promise<ToolResult> {
    const { result: routingResult } = routeToolCall(visibleTools, availableCapabilities, toolCall);
    if (routingResult) {
      return routingResult;
    }

    if (!opts.toolExecutor) {
      return {
        modelContent: `Tool "${toolCall.name}" is not available: no tool executor configured.`,
        isError: true,
      };
    }
    try {
      const toolResult = await opts.toolExecutor(toolCall);
      const readFileMeta = toolResult.displayMetadata?.readFile as { path?: string } | undefined;
      if (readFileMeta?.path && !toolResult.isError) {
        updateReadFileRecord(readFileMeta.path);
      }

      return toolResult;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        modelContent: `Tool execution error: ${error}`,
        isError: true,
      };
    }
  }

  // ── Main loop ────────────────────────────────

  /**
   * Run the agent loop until the turn completes.
   * Handles: model calls → tool execution → model calls → ... → done.
   */
  async function runLoop(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const status = getStatus();

      // Short-circuit: if cancellation fired, transition to cancelling before
      // dispatching any new model call or tool execution. Avoids initiating a
      // wasted model request after abort.
      if (cancelled && status !== "cancelling" && status !== "done") {
        forwardEmit(feed({ type: "cancel", reason: "abort" }));
        continue;
      }

      if (status === "calling_model") {
        await runModelStream();
        continue;
      }

      if (status === "executing_tools") {
        const pending = [...state.pendingTools];
        for (const toolCall of pending) {
          if (cancelled) {
            forwardEmit(feed({ type: "cancel", reason: "abort" }));
            return;
          }

          const result = await executeTool(toolCall);
          forwardEmit(feed({
            type: "tool_result",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result,
          }));

          const afterTool = getStatus();
          if (afterTool !== "executing_tools") break;
        }
        continue;
      }

      // Terminal states: done, cancelling, waiting_for_*
      if (status === "cancelling" && cancelled) {
        forwardEmit(feed({ type: "cancel" }));
        continue;
      }

      // done, waiting_for_input, waiting_for_approval — stop
      return;
    }
  }

  return {
    async run(initialInput: AgentInput): Promise<ReducerState> {
      try {
        forwardEmit(feed(initialInput));
        await runLoop();
        return state;
      } finally {
        cleanup();
      }
    },

    getState(): ReducerState {
      return state;
    },
  };
}

// ──────────────────────────────────────────────
// ModelEvent → AgentInput conversion
// ──────────────────────────────────────────────

function modelEventToInputs(
  event: ModelEvent,
  pendingUsage?: { inputTokens: number; outputTokens: number },
): AgentInput[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "model_chunk", chunk: { type: "text_delta", text: event.text } }];
    case "reasoning_delta":
      return [{ type: "model_chunk", chunk: { type: "reasoning_delta", text: event.text } }];
    case "tool_use_start":
      return [
        {
          type: "model_chunk",
          chunk: {
            type: "tool_use_delta",
            toolCallId: event.toolCallId,
            toolCallName: event.toolName,
          },
        },
      ];
    case "tool_use_delta":
      return [
        {
          type: "model_chunk",
          chunk: {
            type: "tool_use_delta",
            toolCallId: event.toolCallId,
            argumentsDelta: event.argumentsDelta,
          },
        },
      ];
    case "usage":
      return [];
    case "done":
      return [
        {
          type: "model_done",
          stopReason: event.stopReason,
          usage: pendingUsage,
        },
      ];
    case "error":
      return [
        {
          type: "model_error",
          error: event.error,
          retriable: event.retriable,
        },
      ];
    default:
      return [];
  }
}
