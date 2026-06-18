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
  Clock,
  PolicyEngine,
  Telemetry,
  Validator,
  MemoryStore,
} from "@agent-core/core";
import {
  step,
  createInitialState,
  filterVisibleTools,
  routeToolCall,
  evaluatePermission,
  decideCompaction,
  classifyError,
  annotateUntrusted,
  decideSelfCorrect,
  assembleContext,
} from "@agent-core/core";
import type { StepContext, ReducerState } from "@agent-core/core";
import type { Hook } from "@agent-core/core";
import { runHookPipeline } from "@agent-core/core";

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
  /**
   * Cache breakpoints — message indices where provider-side prompt cache
   * should be anchored. Passed through to ModelRequest for provider translation.
   */
  cacheBreakpoints?: number[];
  /**
   * Clock for checkpoint timestamps. Inject a seeded Clock for deterministic
   * runner-level replay; defaults to wall-clock (Date.now) when omitted.
   */
  clock?: Clock;
  /**
   * External policy engine for authorization decisions.
   * When provided, evaluated alongside core PermissionPolicy (most restrictive wins).
   * Fail-closed: if PolicyEngine evaluation throws, decision defaults to "deny".
   */
  policyEngine?: PolicyEngine;
  /**
   * Structured telemetry (OTel-style).
   * Runner instruments turn / model / tool call span boundaries.
   * Defaults to undefined (no-op); SDK resolves defaultTelemetry.
   */
  telemetry?: Telemetry;
  /**
   * Per-model pricing table for cost metrics.
   * Key: model name; value: cost per million tokens (input/output).
   * When provided, Runner records `cost_usd` metric on model call spans.
   */
  pricing?: Record<string, { inputPer1M: number; outputPer1M: number }>;
  /**
   * Structured audit sink for approval decisions and high-risk tool executions.
   * When provided, Runner records audit entries for HITL decisions and
   * WRITE_HIGH/IRREVERSIBLE tool executions.
   */
  auditSink?: AuditSink;
  /**
   * Lifecycle hooks — called at session:start/end, turn:start/end,
   * preToolUse (after permission, before executor), postToolUse (after result).
   * preToolUse hooks can deny (→ normalized tool_result isError) or modify input.
   * postToolUse hooks can modify tool result before it's fed to the reducer.
   */
  hooks?: Hook[];
  /**
   * Validators run against tool results after execution. If any validator fails
   * and the self-correction budget allows, the Runner injects a repair prompt
   * as a user_message so the model can retry. Empty array = no self-correction.
   */
  validators?: Validator[];
  /**
   * Maximum self-corrections per turn. When a validator fails and this budget
   * remains, the Runner injects a repair prompt and loops. When exhausted, the
   * budget-exhausted error is included in the final result.
   * Default 0 = self-correction disabled.
   */
  selfCorrectionMax?: number;
  /**
   * Retry policy for retriable model errors. Exponential backoff with
   * circuit breaker. Undefined = no retries (backward compat).
   */
  retryPolicy?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    circuitBreakerThreshold?: number;
  };
  /**
   * RAG pipeline — when configured, queries MemoryStore before each model call
   * and injects retrieved fragments into the message array without breaking
   * the static prefix cache.
   */
  rag?: {
    memoryStore: MemoryStore;
    topK?: number;
    queryBuilder?: (messages: Message[]) => string;
  };
}

export interface Runner {
  run(initialInput: AgentInput): Promise<ReducerState>;
  getState(): ReducerState;
  /** Resume from a checkpoint with an approval decision */
  resume(sessionId: string, decision: "allow" | "deny"): Promise<ReducerState>;
}

/** Structured audit entry for approval decisions and high-risk tool executions. */
export interface AuditEntry {
  kind: "approval" | "high_risk_exec";
  toolName: string;
  riskTier?: string;
  decision?: "allow" | "deny";
  timestamp: number;
  isError?: boolean;
  sessionId?: string;
}

/** Sink for audit entries — records structured audit data. */
export interface AuditSink {
  record(entry: AuditEntry): void;
}

/** No-op audit sink — entries are discarded. */
export const defaultAuditSink: AuditSink = {
  record(): void {},
};

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

  let state: ReducerState = {
    ...(opts.initialState ?? createInitialState()),
    selfCorrectionCount: 0,
    maxSelfCorrections: opts.selfCorrectionMax,
  };
  let cancelled = false;
  // Tool call ids that have already cleared an HITL "ask" (decision = allow).
  const approvedToolCallIds = new Set<string>();
  // M8 Phase 4: wallclock and cost tracking for the current turn
  let turnStartTime = 0;
  let cumulativeCost = 0;
  // M12 Phase 1: track whether this turn encountered any model/tool error
  let turnHadError = false;
  // M12 Phase 4: checkpoint history sequence counter
  let checkpointSeq = 0;
  // Retry state for retriable model errors
  let consecutiveModelErrors = 0;

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

  /**
   * Check wallclock and cost budget limits at the Runner level.
   * Feeds a budget_exceeded input if limits are breached.
   * Returns true if a budget_exceeded was fed (caller should break/return).
   */
  function checkBudgetLimits(): boolean {
    if (state.status === "done" || state.status === "idle") return false;

    if (turnStartTime > 0 && state.maxWallclockMs !== undefined) {
      const elapsed = Date.now() - turnStartTime;
      if (elapsed > state.maxWallclockMs) {
        forwardEmit(feed({ type: "budget_exceeded", reason: "Wallclock limit exceeded" }));
        return true;
      }
    }

    if (state.maxCostDollars !== undefined && cumulativeCost > state.maxCostDollars) {
      forwardEmit(feed({ type: "budget_exceeded", reason: "Cost budget exceeded" }));
      return true;
    }

    return false;
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
    let messages = await applyCompaction(state.messages);

    // RAG pipeline: query memory store and inject retrieved fragments
    if (opts.rag) {
      const { memoryStore, topK = 5, queryBuilder } = opts.rag;
      const queryText = queryBuilder
        ? queryBuilder(messages)
        : extractLastUserMessage(messages);
      if (queryText) {
        try {
          const fragments = await memoryStore.query(queryText, topK);
          if (fragments.length > 0) {
            const ragText = fragments
              .map((f, i) => `[${i + 1}] ${f.text}`)
              .join("\n\n");
            const ragMessage: Message = {
              role: "user",
              content: `# Retrieved Context\n\n${ragText}`,
            };
            // Inject after the last system message (preserving static prefix)
            let insertIndex = 0;
            for (let i = 0; i < messages.length; i++) {
              if (messages[i]!.role === "system") insertIndex = i + 1;
              else break;
            }
            messages = [...messages.slice(0, insertIndex), ragMessage, ...messages.slice(insertIndex)];
          }
        } catch {
          // Memory query failure is non-fatal — proceed without RAG
        }
      }
    }

    // ContextAssembler: cache-friendly ordering + breakpoint computation.
    // Same pure function the reducer uses for its `call_model` effect, so
    // host-side compaction/RAG additions still get a stable static prefix
    // and provider-cache breakpoints. Explicit `opts.cacheBreakpoints`
    // (legacy / advanced override) wins when provided.
    const assembled = assembleContext({
      messages,
      tools: stepContext.tools,
      pinnedMessageIds: state.pinnedMessageIds,
    });
    const finalMessages = assembled.messages;
    const finalCacheBreakpoints = opts.cacheBreakpoints ?? assembled.cacheBreakpoints;

    const req = {
      messages: finalMessages,
      tools: stepContext.tools,
      model: stepContext.model,
      maxTokens: stepContext.maxTokens,
      temperature: stepContext.temperature,
      responseFormat: stepContext.responseFormat,
      cacheBreakpoints: finalCacheBreakpoints,
      abortSignal: opts.abortSignal,
    };

    const modelSpan = opts.telemetry?.startSpan("model_call", { model: stepContext.model });
    const modelSpanStartedAt = opts.clock?.now() ?? Date.now();
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
    let capturedUsage: { inputTokens: number; outputTokens: number } | undefined;
    let receivedTerminal = false; // true after done or error event is fed
    let modelError = false;

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
          // Accumulate cost: use dollar pricing when available, else token count fallback
          if (opts.pricing && stepContext.model) {
            const entry = opts.pricing[stepContext.model];
            if (entry) {
              cumulativeCost += (event.inputTokens * entry.inputPer1M + event.outputTokens * entry.outputPer1M) / 1_000_000;
            } else {
              cumulativeCost += event.inputTokens + event.outputTokens;
            }
          } else {
            cumulativeCost += event.inputTokens + event.outputTokens;
          }
          // Check cost budget immediately after accumulation
          if (state.maxCostDollars !== undefined && cumulativeCost > state.maxCostDollars) {
            forwardEmit(feed({ type: "budget_exceeded", reason: "Cost budget exceeded" }));
            return;
          }
          continue;
        }

        // Mark terminal events (done or error)
        if (event.type === "done" || event.type === "error") {
          receivedTerminal = true;
        }

        // Convert and feed model events
        for (const input of modelEventToInputs(event, lastUsage)) {
          if (event.type === "done") {
            capturedUsage = lastUsage;
            lastUsage = undefined;
          }
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
        consecutiveModelErrors = 0;
        forwardEmit(feed({ type: "model_done", stopReason: "end_turn", usage: lastUsage }));
      }
    } catch (err: unknown) {
      modelError = true;
      turnHadError = true;
      if (getStatus() === "calling_model") {
        const error = err instanceof Error ? err.message : String(err);
        const classification = classifyError(err);

        // Retry logic: exponential backoff with circuit breaker
        if (classification.retriable && opts.retryPolicy) {
          const { maxRetries = 3, baseDelayMs = 500, maxDelayMs = 30_000, circuitBreakerThreshold = 5 } = opts.retryPolicy;
          consecutiveModelErrors++;

          if (consecutiveModelErrors <= maxRetries && consecutiveModelErrors < circuitBreakerThreshold) {
            const delay = Math.min(baseDelayMs * Math.pow(2, consecutiveModelErrors - 1), maxDelayMs);
            opts.eventSink?.emit({ type: "model_retry", data: { attempt: consecutiveModelErrors, delayMs: delay, error } });
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);
              if (opts.abortSignal) {
                opts.abortSignal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
              }
            });
            if (cancelled || getStatus() !== "calling_model") return;
            // Retry: do not feed model_error, just return to let the loop call runModelStream again
            return;
          }
          // Circuit breaker tripped or max retries exhausted — feed error as non-retriable
          forwardEmit(feed({ type: "model_error", error: `${error} (retried ${consecutiveModelErrors} times)`, retriable: false, errorKind: classification.kind }));
          return;
        }

        // No retry policy or non-retriable: feed error to reducer.
        // When no retryPolicy, mark retriable errors as non-retriable to prevent
        // the reducer from infinitely re-issuing model calls.
        forwardEmit(feed({ type: "model_error", error, retriable: opts.retryPolicy ? classification.retriable : false, errorKind: classification.kind }));
      }
    } finally {
      const endTime = opts.clock?.now() ?? Date.now();
      const usageData = capturedUsage ?? lastUsage;
      if (modelSpan) {
        if (modelError) modelSpan.setAttribute("error", true);
        if (usageData) {
          modelSpan.setAttribute("inputTokens", usageData.inputTokens);
          modelSpan.setAttribute("outputTokens", usageData.outputTokens);
        }
        modelSpan.end();
      }
      if (opts.telemetry) {
        const attrs: Record<string, unknown> = { model: stepContext.model };
        // Latency
        if (modelSpanStartedAt > 0) {
          opts.telemetry.metric("latency_ms", endTime - modelSpanStartedAt, attrs);
        }
        // Token counts (use capturedUsage since lastUsage is reset after done event)
        if (usageData) {
          opts.telemetry.metric("tokens", usageData.inputTokens, { ...attrs, kind: "input" });
          opts.telemetry.metric("tokens", usageData.outputTokens, { ...attrs, kind: "output" });
          // Cost
          if (opts.pricing && stepContext.model) {
            const entry = opts.pricing[stepContext.model];
            if (entry) {
              const cost = (usageData.inputTokens * entry.inputPer1M + usageData.outputTokens * entry.outputPer1M) / 1_000_000;
              opts.telemetry.metric("cost_usd", cost, attrs);
            }
          }
        }
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

    const toolDef = visibleTools.find((t) => t.name === toolCall.name);

    // M13: preToolUse hook — after permission, before executor
    const preOutcome = await runHookPipeline(opts.hooks ?? [], "preToolUse", {
      sessionId: opts.sessionId,
      toolCall: { id: toolCall.id, name: toolCall.name, input: toolCall.input },
    });
    if (preOutcome.action === "deny") {
      return {
        modelContent: `Tool "${toolCall.name}" denied by hook: ${preOutcome.reason}`,
        isError: true,
      };
    }
    const effectiveCall = preOutcome.action === "modify" && preOutcome.patch.input
      ? { ...toolCall, input: preOutcome.patch.input }
      : toolCall;

    const toolSpan = opts.telemetry?.startSpan("tool_execute", {
      toolName: toolCall.name,
      riskTier: toolDef?.riskTier,
    });
    const toolSpanStartedAt = opts.clock?.now() ?? Date.now();
    try {
      const result = await opts.toolExecutor(effectiveCall, { readFiles: state.readFiles, abortSignal: opts.abortSignal });

      // M13: postToolUse hook — can modify result before feeding to reducer
      const postOutcome = await runHookPipeline(opts.hooks ?? [], "postToolUse", {
        sessionId: opts.sessionId,
        toolCall: { id: effectiveCall.id, name: effectiveCall.name, input: effectiveCall.input },
        toolResult: result,
      });
      const finalResult = postOutcome.action === "modify" && postOutcome.patch.result
        ? { ...result, ...postOutcome.patch.result }
        : result;

      if (toolSpan && finalResult.isError) toolSpan.setAttribute("error", true);
      return finalResult;
    } catch (err: unknown) {
      turnHadError = true;
      if (toolSpan) toolSpan.setAttribute("error", true);
      const error = err instanceof Error ? err.message : String(err);
      return {
        modelContent: `Tool execution error: ${error}`,
        isError: true,
      };
    } finally {
      const toolEnd = opts.clock?.now() ?? Date.now();
      toolSpan?.end();
      if (opts.telemetry) {
        opts.telemetry.metric("latency_ms", toolEnd - toolSpanStartedAt, {
          toolName: toolCall.name,
          riskTier: toolDef?.riskTier,
        });
      }
    }
  }

  // ── Main loop ────────────────────────────────

  /**
   * Run the agent loop until the turn completes.
   * Handles: model calls → tool execution → model calls → ... → done.
   */
  async function runLoop(): Promise<void> {
    // Initialize wallclock tracking at the start of each turn
    if (turnStartTime === 0) turnStartTime = Date.now();

    const turnSpan = opts.telemetry?.startSpan("turn", { sessionId: opts.sessionId });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const status = getStatus();

      // Budget check: wallclock / cost exceeded → feed budget_exceeded
      if (status !== "done" && status !== "idle" && checkBudgetLimits()) continue;

      // Short-circuit: if cancellation fired, transition to cancelling before
      // dispatching any new model call or tool execution. Avoids initiating a
      // wasted model request after abort.
      if (cancelled && status !== "cancelling" && status !== "done") {
        forwardEmit(feed({ type: "cancel", reason: "abort" }));
        continue;
      }

      if (status === "calling_model") {
        // M13: turn:start hook
        await runHookPipeline(opts.hooks ?? [], "turn:start", {
          sessionId: opts.sessionId,
        });
        await runModelStream();
        // Check budget after model call completes — cost may have been
        // updated during streaming but status may already be "done",
        // skipping the top-of-loop budget check.
        if (getStatus() !== "done" && getStatus() !== "idle") {
          if (checkBudgetLimits()) continue;
        }
        continue;
      }

      if (status === "executing_tools") {
        const pending = [...state.pendingTools];

        // ── Permission classification ─────────────
        // Partition into: parallelBatch (allow) vs approvalQueue (ask)
        const parallelBatch: PendingToolCall[] = [];
        const approvalQueue: PendingToolCall[] = [];

        for (const toolCall of pending) {
          if (cancelled) {
            forwardEmit(feed({ type: "cancel", reason: "abort" }));
            break;
          }

          if (opts.permissionConfig && !approvedToolCallIds.has(toolCall.id)) {
            const toolDef = visibleTools.find((t) => t.name === toolCall.name);
            if (toolDef) {
              const toolCaps = new Set(toolDef.requires ?? []);
              let permDecision = evaluatePermission(
                opts.permissionConfig,
                toolCall.name,
                toolDef.riskTier,
                toolCaps,
              );

              // Combine with external PolicyEngine (most restrictive wins)
              if (opts.policyEngine && permDecision !== "deny") {
                try {
                  const externalDecision = await opts.policyEngine.evaluate({
                    action: toolCall.name,
                    context: { riskTier: toolDef.riskTier },
                  });
                  permDecision = mostRestrictive(permDecision, externalDecision);
                } catch {
                  // Fail-closed: PolicyEngine failure → deny
                  permDecision = "deny";
                }
              }

              if (permDecision === "deny") {
                forwardEmit(feed({
                  type: "tool_result",
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  result: { modelContent: `Tool "${toolCall.name}" denied by permission policy`, isError: true },
                }));
                if (getStatus() !== "executing_tools") break;
                continue;
              }
              if (permDecision === "ask") {
                approvalQueue.push(toolCall);
                continue;
              }
            }
          }

          parallelBatch.push(toolCall);
        }

        // ── Approval tools: sequential through existing HITL flow ──
        for (const toolCall of approvalQueue) {
          if (cancelled || getStatus() !== "executing_tools") break;

          const effects = feed({ type: "request_approval", toolCallId: toolCall.id });
          forwardEmit(effects);
          await interpretEffects(effects);
          if (getStatus() !== "executing_tools") break;
        }

        // ── Parallel batch: execute all allow tools concurrently ──
        if (parallelBatch.length > 0 && getStatus() === "executing_tools" && !cancelled) {
          const results = await Promise.all(
            parallelBatch.map(async (toolCall) => {
              const result = await executeTool(toolCall);
              approvedToolCallIds.delete(toolCall.id);
              return { toolCall, result };
            }),
          );

          // Defer self-correction injection until ALL tool_results have been
          // fed. Injecting mid-batch would interleave a `user` repair message
          // between sibling parallel results, breaking turn-boundary ordering.
          const pendingSelfCorrects: Array<{ repairPrompt: string; consumesBudget: boolean }> = [];

          // Feed results one at a time — the reducer buffers and flushes
          // in pendingTools order for deterministic replay.
          for (const { toolCall, result } of results) {
            if (cancelled) break;

            const pendingEvents = result.displayMetadata?.pendingEvents as
              | Array<{ type: string; data: Record<string, unknown> }>
              | undefined;
            if (pendingEvents && opts.eventSink) {
              for (const evt of pendingEvents) {
                opts.eventSink.emit(evt);
              }
            }

            // Annotate untrusted content from web/MCP tools
            const isExternal = toolCall.name.startsWith("web_") || toolCall.name.startsWith("mcp__");
            const annotatedResult = isExternal && !result.isError
              ? { ...result, modelContent: annotateUntrusted(result.modelContent) }
              : result;

            forwardEmit(feed({
              type: "tool_result",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: {
                ...annotatedResult,
                ...(annotatedResult.isError ? { errorKind: classifyError(annotatedResult.modelContent).kind } : {}),
              },
            }));
            // Audit: record high-risk tool execution
            if (opts.auditSink) {
              const tDef = visibleTools.find((t) => t.name === toolCall.name);
              if (tDef && (tDef.riskTier === "WRITE_HIGH" || tDef.riskTier === "IRREVERSIBLE")) {
                opts.auditSink.record({
                  kind: "high_risk_exec",
                  toolName: toolCall.name,
                  riskTier: tDef.riskTier,
                  isError: result.isError,
                  timestamp: opts.clock?.now() ?? Date.now(),
                  sessionId: opts.sessionId,
                });
              }
            }

            // Self-correction: validate tool result and queue repair prompt
            // for post-batch injection. We must use the projected budget
            // (state.selfCorrectionCount + already-queued consumers) so that
            // multiple failures within the same batch see consistent budget
            // accounting BEFORE any input is fed.
            if (opts.validators && opts.validators.length > 0 && !result.isError) {
              for (const validator of opts.validators) {
                const vr = validator.validate(toolCall.name, result.modelContent);
                if (!vr.passed) {
                  const projectedCount =
                    state.selfCorrectionCount +
                    pendingSelfCorrects.filter((p) => p.consumesBudget).length;
                  const decision = decideSelfCorrect(
                    vr,
                    projectedCount,
                    state.maxSelfCorrections ?? 0,
                  );
                  if (decision.repairPrompt) {
                    pendingSelfCorrects.push({
                      repairPrompt: decision.repairPrompt,
                      consumesBudget: decision.shouldCorrect,
                    });
                  }
                  break;
                }
              }
            }

            if (getStatus() !== "executing_tools") break;
          }

          // Flush queued self-correct inputs — they go through the reducer
          // so the repair prompt becomes part of the canonical message
          // history (replay-safe) and the counter bump is observable.
          for (const sc of pendingSelfCorrects) {
            if (cancelled || getStatus() === "done") break;
            forwardEmit(feed({
              type: "self_correct",
              repairPrompt: sc.repairPrompt,
              consumesBudget: sc.consumesBudget,
            }));
          }
        }

        // Post-batch: if cancelled during parallel execution, transition
        if (cancelled && getStatus() !== "cancelling" && getStatus() !== "done") {
          forwardEmit(feed({ type: "cancel", reason: "abort" }));
        }

        continue;
      }

      // Terminal states: done, cancelling, waiting_for_*
      if (status === "cancelling" && cancelled) {
        forwardEmit(feed({ type: "cancel" }));
        continue;
      }

      // done, waiting_for_input, waiting_for_approval — stop
      break;
    }

    // M13: turn:end hook
    await runHookPipeline(opts.hooks ?? [], "turn:end", {
      sessionId: opts.sessionId,
    });

    if (turnSpan) {
      turnSpan.setAttribute("status", state.status);
      if (turnHadError) turnSpan.setAttribute("error", true);
      turnSpan.end();
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
        const now = opts.clock?.now() ?? Date.now();
        // Save canonical single-key checkpoint (for resume)
        await opts.sessionStore.save({
          id: opts.sessionId,
          state: e.state,
          createdAt: now,
        });
        // M12: Append checkpoint history (key = sessionId#seq)
        checkpointSeq++;
        await opts.sessionStore.save({
          id: `${opts.sessionId}#${checkpointSeq}`,
          state: e.state,
          createdAt: now,
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
        // Audit: record approval decision
        if (opts.auditSink) {
          opts.auditSink.record({
            kind: "approval",
            toolName: e.toolCall.name,
            riskTier: e.riskTier,
            decision,
            timestamp: opts.clock?.now() ?? Date.now(),
            sessionId: opts.sessionId,
          });
        }
      }
    }
  }

  return {
    async run(initialInput: AgentInput): Promise<ReducerState> {
      try {
        // Reset budget tracking for this turn
        turnStartTime = Date.now();
        cumulativeCost = 0;
        turnHadError = false;
        // M13: session:start hook
        await runHookPipeline(opts.hooks ?? [], "session:start", {
          sessionId: opts.sessionId,
        });
        forwardEmit(feed(initialInput));
        await runLoop();
        return state;
      } finally {
        // M13: session:end hook
        await runHookPipeline(opts.hooks ?? [], "session:end", {
          sessionId: opts.sessionId,
        });
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

/** Most restrictive permission: deny > ask > allow */
function mostRestrictive(
  a: "allow" | "deny" | "ask",
  b: "allow" | "deny" | "ask",
): "allow" | "deny" | "ask" {
  const rank = { deny: 3, ask: 2, allow: 1 };
  return rank[a] >= rank[b] ? a : b;
}

/** Extract the text content of the last user message for RAG query building */
function extractLastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      return typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join(" ");
    }
  }
  return "";
}

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
