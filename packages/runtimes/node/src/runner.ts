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
  ReadFileRecord,
  PermissionConfig,
  SessionStore,
  ApprovalGate,
  CompactionConfig,
  Message,
} from "@agent-core/core";
import {
  step,
  createInitialState,
  filterVisibleTools,
  routeToolCall,
  evaluatePermission,
  decideCompaction,
} from "@agent-core/core";
import type { StepContext, ReducerState } from "@agent-core/core";

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

/**
 * Tool executor. Receives the call plus a read-only view of serializable gate
 * state (readFiles) so write-class tools can enforce read-before-edit/staleness
 * before performing any side effect.
 */
export interface ToolExecutorContext {
  readFiles: ReadFileRecord[];
  /** Abort signal from the Runner, for forwarding to cancellable ports (e.g. Network) */
  abortSignal?: AbortSignal;
}
export type ToolExecutor = (call: PendingToolCall, ctx: ToolExecutorContext) => Promise<ToolResult>;

export interface RunnerOptions {
  modelPort: ModelPort;
  stepContext: StepContext;
  eventSink?: EventSink;
  toolExecutor?: ToolExecutor;
  abortSignal?: AbortSignal;
  initialState?: ReducerState;
  availableCapabilities?: Set<string>;
  /** Permission policy — if set, tools are checked before execution */
  permissionConfig?: PermissionConfig;
  /** Session store for checkpoint/resume persistence */
  sessionStore?: SessionStore;
  /** Session ID for checkpoint persistence */
  sessionId?: string;
  /** Approval gate for HITL interaction (auto-allow or interactive) */
  approvalGate?: ApprovalGate;
  /** Compaction config — enables automatic context compression when messages grow large */
  compaction?: CompactionConfig;
}

export interface Runner {
  run(initialInput: AgentInput): Promise<ReducerState>;
  getState(): ReducerState;
  /** Resume from a checkpoint with an approval decision */
  resume(sessionId: string, decision: "allow" | "deny"): Promise<ReducerState>;
}

// ──────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────

export function createRunner(opts: RunnerOptions): Runner {
  // Validate: permissionConfig requires approvalGate (otherwise "ask" decisions hang)
  if (opts.permissionConfig && !opts.approvalGate) {
    throw new Error(
      "permissionConfig requires an approvalGate to handle 'ask' decisions. " +
      "Configure an ApprovalGate or remove permissionConfig.",
    );
  }

  let state: ReducerState = opts.initialState ?? createInitialState();
  let cancelled = false;
  // Tool call ids that have already cleared an HITL "ask" (decision = allow).
  // The permission gate must NOT re-evaluate these when the approved tool is
  // re-queued into executing_tools, otherwise it would re-prompt forever.
  const approvedToolCallIds = new Set<string>();

  const availableCapabilities = opts.availableCapabilities ?? new Set<string>();
  const visibleTools = filterVisibleTools(opts.stepContext.tools, availableCapabilities);
  const stepContext: StepContext = {
    ...opts.stepContext,
    tools: visibleTools,
  };

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

  // ── Compaction ──────────────────────────────

  /**
   * Apply context compaction before a model call.
   * If the message history exceeds the token threshold, issues a summarization
   * call to the model and replaces compressible messages with the summary.
   * Returns the messages to use for the main request.
   */
  async function applyCompaction(messages: Message[]): Promise<Message[]> {
    if (!opts.compaction) return messages;

    const decision = decideCompaction(messages, {
      tokenizer: opts.compaction.tokenizer,
      maxTokens: opts.compaction.maxTokens,
      recentKeepCount: opts.compaction.recentKeepCount ?? 4,
    });

    if (!decision.shouldCompact || !decision.summaryPrompt) return messages;

    // Issue a summarization model call
    try {
      const summaryEvents = opts.modelPort.stream({
        messages: [
          { role: "user", content: decision.summaryPrompt },
        ],
        tools: [],
        model: stepContext.model,
        maxTokens: 1024,
        abortSignal: opts.abortSignal,
      });

      let summaryText = "";
      for await (const event of summaryEvents) {
        if (event.type === "text_delta") summaryText += event.text;
        if (event.type === "error") {
          // Compaction failed — proceed with uncompressed messages
          return messages;
        }
        if (event.type === "done") break;
      }

      if (!summaryText) return messages;

      // Re-order: [...system, summary, ...non-system preserved (recent)].
      // The summary represents *earlier* dropped messages, so it must sit
      // before the recent kept messages — appending it would make the model
      // read it as the newest user input. Role is `system` so it does not
      // masquerade as a fresh user turn (providers tolerant of mid-history
      // system messages handle this cleanly; the prefix keeps it self-
      // labelling even when downgraded).
      const systemMessages = decision.preservedMessages.filter(
        (m) => m.role === "system",
      );
      const nonSystemPreserved = decision.preservedMessages.filter(
        (m) => m.role !== "system",
      );
      const summaryMsg: Message = {
        role: "system",
        content: `[Earlier conversation summary]\n${summaryText}`,
      };

      return [...systemMessages, summaryMsg, ...nonSystemPreserved];
    } catch {
      // Compaction failed — proceed with uncompressed messages
      return messages;
    }
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
    // Apply compaction before building the main request
    const messages = await applyCompaction(state.messages);

    const req = {
      messages,
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
      // Pass a read-only view of gate state; recording of reads/writes back into
      // state.readFiles happens purely in the reducer from the result metadata.
      return await opts.toolExecutor(toolCall, { readFiles: state.readFiles, abortSignal: opts.abortSignal });
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

          // Permission check before execution. Tools that already cleared an
          // HITL "ask" (approvedToolCallIds) bypass the gate so the approved
          // tool actually runs instead of being re-prompted.
          if (opts.permissionConfig && !approvedToolCallIds.has(toolCall.id)) {
            const toolDef = visibleTools.find((t) => t.name === toolCall.name);
            if (toolDef) {
              const permDecision = evaluatePermission(opts.permissionConfig, toolCall.name, toolDef.riskTier);
              if (permDecision === "deny") {
                forwardEmit(feed({
                  type: "tool_result",
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  result: { modelContent: `Tool "${toolCall.name}" denied by permission policy`, isError: true },
                }));
                const afterPerm = getStatus();
                if (afterPerm !== "executing_tools") break;
                continue;
              }
              if (permDecision === "ask") {
                // Transition to waiting_for_approval + checkpoint, then resolve
                // the approval (auto/interactive) in-process. interpretEffects
                // feeds the approval_decision back into the reducer, which moves
                // the tool back to executing_tools (allow) or to calling_model
                // (deny). Break the inner loop so the outer while re-dispatches
                // on the freshly updated status — this is what closes the loop.
                const effects = feed({ type: "request_approval", toolCallId: toolCall.id });
                forwardEmit(effects);
                await interpretEffects(effects);
                break;
              }
            }
          }

          const result = await executeTool(toolCall);
          // Approval is single-use: consume it so the Set stays bounded and a
          // recycled tool-call id can never bypass the gate on a later call.
          approvedToolCallIds.delete(toolCall.id);

          // Emit any pendingEvents declared by the tool in displayMetadata.
          // This routes events through the effect channel (tool → Runner → EventSink),
          // keeping tools side-effect-free and fully replayable.
          const pendingEvents = result.displayMetadata?.pendingEvents as
            | Array<{ type: string; data: Record<string, unknown> }>
            | undefined;
          if (pendingEvents && opts.eventSink) {
            for (const evt of pendingEvents) {
              opts.eventSink.emit(evt);
            }
          }

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

  /**
   * Interpret effects that require I/O (checkpoint, request_approval).
   * Checkpoints are persisted FIRST (durable before any approval interaction),
   * so a gate that throws / defers cannot lose the snapshot needed for resume.
   */
  async function interpretEffects(effects: Effect[]): Promise<void> {
    for (const e of effects) {
      if (e.type === "checkpoint" && opts.sessionStore && opts.sessionId) {
        await opts.sessionStore.save({
          id: opts.sessionId,
          state: e.state,
          createdAt: Date.now(),
        });
      }
    }
    for (const e of effects) {
      if (e.type === "request_approval" && opts.approvalGate) {
        const decision = await opts.approvalGate.ask(e.toolCall, e.riskTier);
        if (decision === "allow") approvedToolCallIds.add(e.toolCall.id);
        forwardEmit(feed({
          type: "approval_decision",
          toolCallId: e.toolCall.id,
          decision,
        }));
      }
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

    async resume(resumeSessionId: string, decision: "allow" | "deny"): Promise<ReducerState> {
      if (!opts.sessionStore) {
        throw new Error("Cannot resume: no sessionStore configured");
      }
      const snapshot = await opts.sessionStore.load(resumeSessionId);
      if (!snapshot) {
        throw new Error(`Session not found: ${resumeSessionId}`);
      }
      state = snapshot.state as ReducerState;
      if (state.status !== "waiting_for_approval") {
        throw new Error(
          `Cannot resume session ${resumeSessionId}: expected status "waiting_for_approval" but got "${state.status}"`,
        );
      }
      if (!state.pendingApprovalTool) {
        throw new Error(
          `Cannot resume session ${resumeSessionId}: checkpoint missing pendingApprovalTool (corrupted or stale)`,
        );
      }
      const approvedId = state.pendingApprovalTool.id;
      // Pre-authorize the re-queued tool so runLoop's permission gate does not
      // re-prompt for the decision the user already gave on resume.
      if (decision === "allow") approvedToolCallIds.add(approvedId);
      forwardEmit(feed({
        type: "approval_decision",
        toolCallId: approvedId,
        decision,
      }));
      await runLoop();
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
