/**
 * step() — the pure functional reducer.
 * Takes (state, input) and returns { state, effects[] }.
 * Zero I/O, zero side effects, fully deterministic.
 */

import type { AgentState, AssistantMessage, ToolResultMessage, PendingToolCall, ReadFileRecord, Message, UserMessage, TodoItem, BackgroundTask, ContentBlock } from "./state.js";
import { normalizeToolResultContent } from "./state.js";
import type { ApprovalDenialReason, Clock, Id, ReasoningEffortId } from "./ports.js";
import type { AgentInput } from "./input.js";
import type { Effect } from "./effect.js";
import type { ToolDefinition, JSONSchema } from "./tool.js";
import type { ContextLayer } from "./context-assembler.js";
import type { PermissionConfig } from "./permission-policy.js";
import { userDenialMessage } from "./permission-policy.js";
import { renderImagePreservedMarker } from "./compaction-image-offload.js";
import { extractFileAccess, recordFileAccess } from "./file-gate.js";
import { formatTodoListForModel } from "./todo-format.js";
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
  /**
   * 宿主路由的 provider 配置 id（如 "deepseek-official"），**仅作溯源**：
   * reducer 把它写进 assistant_message.source，供 UI 展示「提供方」。
   * 适配器不得用它判定消息是否来自当前模型（见 providers/pi-ai/context.ts 的
   * isForeignSource —— 那里只比 modelId）。不设则 source 里没有该键。
   */
  providerId?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Loop-ladder threshold K: consecutive identical tool calls (same tool +
   * input) that trigger advisory reminders (repeat chains) or interventions
   * (error chains). The decision site requires K >= 2; `undefined` disables
   * the ladder entirely. The SDK's product default is 3 (see create-agent's
   * DEFAULT_MAX_LOOP_COUNT) — core itself stays mechanism-only, so a direct
   * Runner caller opts in explicitly.
   */
  maxLoopCount?: number;
  /**
   * Loop intervention budget per turn (spec 2026-10-16 D2). Default 2,
   * resolved at the decision site as `ctx.maxLoopInterventions ?? 2`;
   * `0` disables the intervention tier so the first >=K detection
   * hard-terminates the turn (today's behavior). Orthogonal to maxLoopCount.
   */
  maxLoopInterventions?: number;
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
  /**
   * Workflow-mode announcement channel (spec 2026-09-25). Pure data: the
   * reducer compares `key` against `state._announcedWorkflowMode` and, on a
   * change, injects `announce` as a tail system-reminder — never a static
   * prefix layer, so enter/exit cost zero prompt-cache invalidation. The host
   * owns the key vocabulary and the text (state-descriptive wording only).
   */
  workflowReminder?: { key?: string; announce: string };
  /**
   * Optional id source; when set, messages appended to state.messages get
   * id: ctx.id.next(). Absent → messages keep their construction-time id.
   */
  id?: Id;
  /**
   * Optional time source for startedAt stamps on BackgroundTask records.
   * Absent → startedAt falls back to 0 (deterministic; hosts that need real
   * timestamps inject a Clock).
   */
  clock?: Clock;
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
    // No step cap by default: the number of model calls is a property of the
    // task, not a budget. Long-horizon agents (DSH, Claude Code, Codex) run
    // until the model stops calling tools, and bound *resources* (tokens /
    // cost / wallclock) or detect no-progress instead. A host that wants a
    // hard stop passes maxIterations explicitly; hitting it terminates the
    // turn with an error that names the cap (never a silent "done").
    maxIterations: undefined,
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
    loopInterventionCount: 0,
    loopRemindedCount: 0,
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
 * `maxIterations`, and `queuedUserInputs` — an un-delivered steering queue
 * outlives the turn exactly like `messages`, D11) and clears: pending tools,
 * pending approval, iteration / token counters and the reducer's internal
 * streaming accumulators. The result is in `status: "idle"` and is ready to
 * receive a new user message (or a `steering_flush` that delivers the
 * preserved queue).
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
    loopInterventionCount: 0,
    loopRemindedCount: 0,
    _accumulatedText: "",
    _accumulatedReasoning: "",
    _accumulatedToolCalls: [],
    _toolResultBuffer: {},
    backgroundTasks: [],
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
  // Terminates the turn with a clear reason; no exception. Any tool call
  // still on the roster is paired before the teardown (limit tier), so the
  // history never ends on an un-paired tool_use block.
  if (input.type === "budget_exceeded" && state.status !== "done" && state.status !== "idle") {
    const interrupted = synthesizeInterruptedResults(state, ctx, "limit");
    return {
      state: {
        ...state,
        messages: [...state.messages, ...interrupted],
        pendingTools: [],
        pendingApprovalTool: undefined,
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
    const repairMsg = stamp({ id: "", role: "user" as const, content: input.repairPrompt }, ctx);
    const correctionCount = input.consumesBudget
      ? state.selfCorrectionCount + 1
      : state.selfCorrectionCount;
    return {
      state: {
        ...state,
        messages: [...state.messages, repairMsg],
        selfCorrectionCount: correctionCount,
      },
      effects: [
        {
          type: "emit",
          event: {
            type: "context_reminder",
            data: {
              kind: "self_correction",
              text: input.repairPrompt,
              displayMetadata: { consumesBudget: input.consumesBudget, correctionCount },
            },
          },
        },
      ],
    };
  }

  // Unified steering_edit / steering_remove handlers — queue mutations that
  // are accepted in ANY status (same cross-status placement as the
  // self_correct handler above, ahead of the status switch): the queue
  // outlives the turn, so a queued message stays editable/withdrawable even
  // in idle/done. Locate by id in queuedUserInputs; edit replaces content
  // IN PLACE (same id, same position, new UserMessage object); remove
  // hard-deletes (no tombstone). Delivery wins: an id no longer in the
  // queue — delivered, removed, or never queued — is an errorResult with
  // state untouched, so a message the model already saw can never be
  // mutated after the fact.
  if (input.type === "steering_edit") {
    const idx = state.queuedUserInputs.findIndex((m) => m.id === input.id);
    if (idx === -1) {
      return errorResult(state, `steering_edit: no queued message with id "${input.id}"`);
    }
    const queued = state.queuedUserInputs[idx]!;
    const next = [...state.queuedUserInputs];
    next[idx] = { ...queued, content: input.content };
    return {
      state: { ...state, queuedUserInputs: next },
      effects: [
        {
          type: "emit",
          event: { type: "steering_edited", data: { id: input.id, content: input.content } },
        },
      ],
    };
  }

  if (input.type === "steering_remove") {
    const idx = state.queuedUserInputs.findIndex((m) => m.id === input.id);
    if (idx === -1) {
      return errorResult(state, `steering_remove: no queued message with id "${input.id}"`);
    }
    return {
      state: {
        ...state,
        queuedUserInputs: state.queuedUserInputs.filter((_, i) => i !== idx),
      },
      effects: [
        { type: "emit", event: { type: "steering_removed", data: { id: input.id } } },
      ],
    };
  }

  // Unified loop ladder injection handlers — structurally isomorphic to the
  // self_correct handler above (append user message + context_reminder emit,
  // accepted in any status except done). Division of labor (spec 2026-10-16
  // D2): the RUNNER reads the ladder state (loopRemindedCount /
  // loopInterventionCount) and feeds these inputs AFTER the batch's
  // tool_results — the REDUCER only appends and books, never decides tiers.
  // loop_reminder consumes nothing and touches NO counter: the reminder dedup
  // field (loopRemindedCount) is written exclusively by the model_done
  // ladder branch, never by a handler.
  if (input.type === "loop_reminder" && state.status !== "done") {
    const repairMsg = stamp({ id: "", role: "user" as const, content: input.repairPrompt }, ctx);
    return {
      state: {
        ...state,
        messages: [...state.messages, repairMsg],
      },
      effects: [
        {
          type: "emit",
          event: {
            type: "context_reminder",
            data: {
              kind: "loop_reminder",
              text: input.repairPrompt,
              displayMetadata: {
                consumesBudget: input.consumesBudget,
                remindedCount: state.loopRemindedCount,
              },
            },
          },
        },
      ],
    };
  }

  if (input.type === "loop_intervention" && state.status !== "done") {
    const repairMsg = stamp({ id: "", role: "user" as const, content: input.repairPrompt }, ctx);
    const interventionCount = state.loopInterventionCount + 1;
    return {
      state: {
        ...state,
        messages: [...state.messages, repairMsg],
        loopInterventionCount: interventionCount,
      },
      effects: [
        {
          type: "emit",
          event: {
            type: "context_reminder",
            data: {
              kind: "loop_intervention",
              text: input.repairPrompt,
              displayMetadata: {
                consumesBudget: input.consumesBudget,
                interventionCount,
              },
            },
          },
        },
      ],
    };
  }

  // Unified tool_results_pruned handler — durable write-back of the Runner's
  // request-surface pruning into state.messages. Status-independent: it is a
  // pure message rewrite that never changes the turn's control flow.
  if (input.type === "tool_results_pruned") {
    const byId = new Map(input.entries.map((e) => [e.toolCallId, e]));
    const messages = state.messages.map((m) => {
      if (m.role !== "tool") return m;
      const nextContent = m.content.map((b) => {
        if (b.type !== "tool_result") return b;
        const hit = byId.get(b.toolUseId);
        if (!hit) return b;
        return { ...b, content: normalizeToolResultContent(hit.content) };
      });
      return { ...m, content: nextContent };
    });
    return {
      state: { ...state, messages },
      effects: [
        {
          type: "emit",
          event: {
            type: "tool_results_pruned",
            data: {
              // content is intentionally omitted from the event: the event
              // records that pruning happened, not the pruned text itself.
              entries: input.entries.map(
                ({
                  toolCallId,
                  charsBefore,
                  charsAfter,
                  savedTokens,
                  cacheResetTokens,
                  cacheResetEstimated,
                }) => ({
                  toolCallId,
                  charsBefore,
                  charsAfter,
                  ...(savedTokens !== undefined ? { savedTokens } : {}),
                  ...(cacheResetTokens !== undefined ? { cacheResetTokens } : {}),
                  ...(cacheResetEstimated !== undefined ? { cacheResetEstimated } : {}),
                }),
              ),
            },
          },
        },
      ],
    };
  }

  // Unified compaction_applied handler — durable write-back of a compaction
  // decision. Status-independent: a pure messages/pins rewrite. The summary
  // id comes from the caller (Runner stamps it via StepContext.id / Id port);
  // the reducer never invents one.
  if (input.type === "compaction_applied") {
    const replaced = new Set(input.replacedIds);
    const kept = state.messages.filter((m) => !replaced.has(m.id));
    const firstIdx = state.messages.findIndex((m) => replaced.has(m.id));
    // Preserved images (spec 2026-10-16 D5, v1.2): image ref blocks ride a
    // dedicated USER-role message inserted right after the summary — system
    // content is text-only on every provider's wire, so images inside the
    // summary message never reach the model (Task 3's wire witness). Markers
    // verbatim, one immediately before each image block.
    const preservedImages = (input.preservedImages ?? []).filter(
      (b): b is Extract<ContentBlock, { type: "image" }> =>
        b.type === "image" && b.source.type === "ref",
    );
    // D5 v1.2: the summary is ALWAYS the plain string this handler has
    // always produced. The v1.0 block-array summary path is gone.
    //
    // USER role, not system: the ContextAssembler places every system message
    // before the static context layers and tool schemas, so a system summary
    // is hoisted ahead of AGENTS.md / the skill catalogue and invalidates the
    // whole provider prefix cache on every compaction. As a user message the
    // summary stays after the static prefix.
    const summaryMsg: Message = {
      id: input.summaryId,
      role: "user",
      content: `[Earlier conversation summary]\n${input.summaryText}`,
    };
    const imagesMsg: Message | undefined =
      preservedImages.length === 0
        ? undefined
        : {
            id: `${input.summaryId}-images`,
            role: "user",
            content: preservedImages.flatMap<ContentBlock>((image) => [
              {
                type: "text",
                text: renderImagePreservedMarker({
                  ...(image.width !== undefined ? { width: image.width } : {}),
                  ...(image.height !== undefined ? { height: image.height } : {}),
                  mediaType: image.source.mediaType,
                }),
              },
              image,
            ]),
          };
    // Insert at the earliest replaced position among the KEPT order: count
    // non-replaced messages before the first replaced index. The images
    // carrier sits immediately after the summary (insertAt + 1).
    const insertAt =
      firstIdx === -1
        ? 0
        : state.messages.slice(0, firstIdx).filter((m) => !replaced.has(m.id)).length;
    const messages = [
      ...kept.slice(0, insertAt),
      summaryMsg,
      ...(imagesMsg !== undefined ? [imagesMsg] : []),
      ...kept.slice(insertAt),
    ];
    // Defensive: the summary id and its images carrier are fresh ids, but a
    // stale pin must never survive on either (same dropped-id discipline as
    // the replaced set).
    const freshIds = new Set([input.summaryId, `${input.summaryId}-images`]);
    const pinnedMessageIds = (state.pinnedMessageIds ?? []).filter(
      (id) => !replaced.has(id) && !freshIds.has(id),
    );
    return {
      state: { ...state, messages, pinnedMessageIds },
      effects: [
        {
          type: "emit",
          event: {
            type: "compaction",
            data: {
              replacedCount: input.replacedIds.length,
              summaryText: input.summaryText,
              replacedIds: input.replacedIds,
              summaryId: input.summaryId,
              // The summarizer's own call usage: without it the turn's
              // cache-hit / cost totals silently omit the compaction call.
              ...(input.usage !== undefined ? { usage: input.usage } : {}),
              // Durable replay needs the carrier's shape, not its bytes:
              // ref metadata only (spec 2026-10-16 D5 v1.2). The projection
              // rebuilds the `${summaryId}-images` user-role carrier from
              // this list; events without it replay exactly as before.
              ...(preservedImages.length > 0
                ? {
                    preservedImages: preservedImages.map((image) => ({
                      id: image.source.id,
                      mediaType: image.source.mediaType,
                      ...(image.width !== undefined ? { width: image.width } : {}),
                      ...(image.height !== undefined ? { height: image.height } : {}),
                    })),
                  }
                : {}),
            },
          },
        },
      ],
    };
  }

  // Unified background_task_started handler — records a detached sub-agent
  // dispatch in serializable state. Status-independent: the dispatch can be
  // fed at any point the Runner spawns a task, and recording it never
  // changes the turn's control flow.
  if (input.type === "background_task_started") {
    const task: BackgroundTask = {
      id: input.taskId,
      ...(input.subagentType !== undefined ? { subagentType: input.subagentType } : {}),
      status: "running",
      startedAt: ctx.clock?.now() ?? 0,
    };
    return {
      state: {
        ...state,
        backgroundTasks: [...(state.backgroundTasks ?? []), task],
      },
      effects: [],
    };
  }

  // Unified background_task_completed handler — collection of a detached
  // sub-agent's result. The result travels back as a user-role message so it
  // is part of the canonical history and survives replay/checkpoint. Fed at
  // the turn boundary (status "done"): the injection pushes the turn back to
  // calling_model so the loop continues with the collected information.
  if (input.type === "background_task_completed") {
    // Worded as a collection notice, not a fresh user request: the model should
    // fold the result into what it already said instead of restating everything.
    const text = `[background task ${input.taskId} finished]\n${input.text}`;
    const notice = stamp({ id: "", role: "user" as const, content: text }, ctx);
    const backgroundTasks = (state.backgroundTasks ?? []).map((t) =>
      t.id === input.taskId ? { ...t, status: "collected" as const } : t,
    );
    const reminder: Effect = {
      type: "emit",
      event: {
        type: "context_reminder",
        data: {
          kind: "background_task",
          text,
          displayMetadata: {
            taskId: input.taskId,
            isError: input.isError ?? false,
            ...(input.childSessionId === undefined ? {} : { childSessionId: input.childSessionId }),
          },
        },
      },
    };

    if (state.status === "done") {
      const newState: ReducerState = {
        ...state,
        backgroundTasks,
        messages: [...state.messages, notice],
        status: "calling_model",
      };
      return {
        state: newState,
        effects: [
          reminder,
          buildCallModelEffect(newState.messages, newState.pinnedMessageIds, ctx, newState.todos),
        ],
      };
    }

    return {
      state: {
        ...state,
        backgroundTasks,
        messages: [...state.messages, notice],
      },
      effects: [reminder],
    };
  }

  // Unified file_changed handler — the host/SDK injects debounced FileWatcher
  // batches as this input. Cross-status by design (same shape as self_correct):
  // idle wakes a new turn; active states queue the notice for the next turn
  // boundary without interrupting the in-flight model call or pending tools;
  // cancelling/done drop with an observable emit. The reducer never throws.
  if (input.type === "file_changed") {
    return handleFileChanged(state, input, ctx);
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
      return handleWaitingForInput(state, input, ctx);
    case "cancelling":
      return handleCancelling(state, input, ctx);
    case "done":
      // D4: user_message is never rejected — even a completed turn queues it
      // for the host-side auto-run. Every other input keeps the rejection.
      if (input.type === "user_message") {
        return queueUserMessage(state, input, ctx);
      }
      return errorResult(state, "step() called on done state — turn is already complete");
    default:
      return errorResult(state, `Unknown status: ${state.status}`);
  }
}

// ──────────────────────────────────────────────
// Status handlers
// ──────────────────────────────────────────────

function handleIdle(state: ReducerState, input: AgentInput, ctx: StepContext): StepResult {
  if (input.type === "steering_flush") {
    // D11 — the gateway's turn-boundary auto-run delivers the whole queue
    // as this turn's opening input. Only idle accepts it; the queued
    // messages keep their ORIGINAL ids (never re-stamped) and are realized
    // by `steering_delivered` — there is NO user_message emit, the content
    // already reached the transcript as `steering_queued`.
    if (state.queuedUserInputs.length === 0) {
      return errorResult(state, "steering_flush: no queued messages");
    }
    const flushed = appendQueuedAndClear(state, state.messages);
    const newState: ReducerState = {
      ...flushed.state,
      status: "calling_model",
      iterationCount: 0,
    };
    return {
      state: newState,
      effects: [
        ...flushed.delivered,
        buildCallModelEffect(newState.messages, newState.pinnedMessageIds, ctx, newState.todos),
      ],
    };
  }

  if (input.type === "user_message") {
    const userMsg: UserMessage = {
      id: "",
      role: "user",
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
    const emittedReminders: Effect[] = [];
    if (ctx.permissionConfig) {
      const fingerprint = permissionFingerprint(ctx.permissionConfig);
      if (fingerprint !== announced) {
        const reminderText = buildPermissionReminder(ctx.permissionConfig, announcedConfig);
        announcements.push(stamp({ id: "", role: "user" as const, content: reminderText }, ctx));
        emittedReminders.push({
          type: "emit",
          event: { type: "context_reminder", data: { kind: "permission_boundary", text: reminderText } },
        });
        announced = fingerprint;
        announcedConfig = ctx.permissionConfig;
      }
    }

    // Announce workflow-mode changes exactly like the permission boundary
    // above: tail, user-role, never the static prefix (prompt caches match
    // on a prefix — see the comment above). The fingerprint lives in
    // AgentState so hosts can seed it across rebuilds; mode switches go
    // through rebuild, and the exit transition dies without the seed.
    let announcedWorkflow = state._announcedWorkflowMode;
    if (ctx.workflowReminder && ctx.workflowReminder.key !== announcedWorkflow) {
      const workflowText = ctx.workflowReminder.announce;
      announcements.push(
        stamp(
          {
            id: "",
            role: "user" as const,
            content: `<system-reminder>\n${workflowText}\n</system-reminder>`,
          },
          ctx,
        ),
      );
      emittedReminders.push({
        type: "emit",
        event: {
          type: "context_reminder",
          data: { kind: "workflow_mode", text: workflowText },
        },
      });
      announcedWorkflow = ctx.workflowReminder.key;
    }

    // D11b — a queue that survived into idle is older than the opening
    // message: flush it first ([...olderQueue, newUserMsg]) and announce
    // only the flushed older entries with steering_delivered. The new
    // message is the turn input — never queued, so it gets no delivered
    // event of its own.
    const flushed = appendQueuedAndClear(state, [...state.messages, ...announcements]);
    const newState: ReducerState = {
      ...flushed.state,
      messages: [...flushed.state.messages, stamp(userMsg, ctx)],
      status: "calling_model",
      iterationCount: 0,
      _announcedPermission: announced,
      _announcedPermissionConfig: announcedConfig,
      _announcedWorkflowMode: announcedWorkflow,
    };
    const effects: Effect[] = [
      ...flushed.delivered,
      buildCallModelEffect(newState.messages, newState.pinnedMessageIds, ctx, newState.todos),
      ...emittedReminders,
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
    const assistantMsg: AssistantMessage = stamp(
      {
        id: "",
        role: "assistant",
        content: assistantContent,
        stopReason: input.stopReason,
        ...(ctx.model !== undefined
          ? {
              source: {
                ...(ctx.providerId !== undefined ? { providerId: ctx.providerId } : {}),
                modelId: ctx.model,
              },
            }
          : {}),
        ...(input.meta !== undefined ? { modelMeta: input.meta } : {}),
      },
      ctx,
    );

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
        // The assistant message just appended carries the new tool_use
        // blocks and none of them will ever execute — pair them (limit tier)
        // before the teardown, or the next request is malformed.
        const interrupted = synthesizeInterruptedResults(
          { ...baseWithToolCount, pendingTools: toolCalls },
          ctx,
          "limit",
        );
        return {
          state: {
            ...baseWithToolCount,
            messages: [...baseWithToolCount.messages, ...interrupted],
            pendingTools: [],
            status: "done",
          },
          effects: [
            emitEffect,
            { type: "emit", event: { type: "error", data: { error: limit2 } } },
            { type: "done" },
          ],
        };
      }

      // Control-flow state for the tool_use path: the ladder below may book a
      // reminder mark into it; every other path passes through byte-identical
      // to before (the common return builds pendingTools + status).
      let execState: ReducerState = baseWithToolCount;

      // Loop detection → three-tier ladder (spec 2026-10-16 D2 / D4).
      //
      // Division of labor — THIS branch books, the RUNNER (Task 3) fires:
      //  - Hard termination only when an error chain reaches K and the
      //    intervention budget is exhausted (done+error byte-identical to the
      //    pre-ladder path).
      //  - Reminder-tier dedup bookkeeping in state.loopRemindedCount
      //    (monotonic; the Runner reads it to decide whether a count tier
      //    already has its once-only reminder).
      //  - Nothing is injected here: every other case falls through to the
      //    normal executing_tools return, and the Runner feeds
      //    loop_reminder / loop_intervention AFTER the batch's tool_results
      //    (same delayed-injection pattern as self_correct). Intervention
      //    budget accounting (+1) lives in the loop_intervention handler.
      //
      // detectLoop only reports counts >= its threshold, so the K-1 tier is
      // invisible to a K-threshold probe: probe K first (byte-identical
      // detection and counts vs. the pre-ladder path, including the K+1 cap
      // on deep chains → the termination message stays byte-identical), and
      // when nothing reached K, probe K-1 for the reminder tier. The probe is
      // gated by `k >= 3`: K=2 has no reminder tier (spec §9.2) — the guard
      // keeps count == K-1 == 1 from ever marking.
      if (ctx.maxLoopCount !== undefined && ctx.maxLoopCount >= 2) {
        const k = ctx.maxLoopCount;
        let loopResult = detectLoop(state.messages, assistantMsg, toolCalls, k);
        if (!loopResult.detected && k >= 3) {
          loopResult = detectLoop(state.messages, assistantMsg, toolCalls, k - 1);
        }
        if (loopResult.detected) {
          const consecutiveCount = loopResult.consecutiveCount;
          if (loopResult.kind === "error-loop" && consecutiveCount >= k) {
            // Intervention tier (>= K). Budget exhausted → hard termination
            // (the pre-ladder done+error path, byte-identical). Budget
            // remains → proceed with NO state change here: the Runner feeds
            // loop_intervention and its handler books the +1.
            const maxLoopInterventions = ctx.maxLoopInterventions ?? 2;
            if (state.loopInterventionCount >= maxLoopInterventions) {
              const loopError = `Loop detected: tool "${loopResult.toolName}" has been called ${consecutiveCount} times with identical input and returned errors`;
              // Same pairing rule as the runaway guard above: the new calls
              // in the just-finalized assistant message will never execute,
              // so answer them (limit tier) before the teardown.
              const interrupted = synthesizeInterruptedResults(
                { ...baseWithToolCount, pendingTools: toolCalls },
                ctx,
                "limit",
              );
              return {
                state: {
                  ...baseWithToolCount,
                  messages: [...baseWithToolCount.messages, ...interrupted],
                  pendingTools: [],
                  status: "done",
                },
                effects: [
                  emitEffect,
                  { type: "emit", event: { type: "error", data: { error: loopError } } },
                  { type: "done" },
                ],
              };
            }
          } else if (
            state.loopRemindedCount < consecutiveCount &&
            ((loopResult.kind === "repeat" && consecutiveCount >= k) ||
              (loopResult.kind === "error-loop" && k >= 3 && consecutiveCount === k - 1))
          ) {
            // Reminder tier: repeat chains (F-027 — never intervened, never
            // terminated) reaching K, or the error chain at exactly K-1. The
            // `loopRemindedCount < consecutiveCount` guard makes each count
            // tier once-only and keeps the field monotonic. Control flow
            // unchanged — the batch executes as usual.
            execState = { ...execState, loopRemindedCount: consecutiveCount };
          }
        }
      }

      return {
        state: { ...execState, pendingTools: toolCalls, status: "executing_tools" },
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
          buildCallModelEffect(baseState.messages, baseState.pinnedMessageIds, ctx, baseState.todos),
        ],
      };
    }

    // end_turn or pure text → continue the turn when steering is queued,
    // otherwise done. A non-empty queue means the user steered mid-answer:
    // draining it here (same turn, not a new one) is what makes the model
    // actually answer the late message. Mirrors the turn-boundary drains in
    // handleExecutingTools / handleWaitingForApproval: [...messages,
    // ...queuedUserInputs], clear the queue, emit steering_delivered with the
    // drained ids before the re-issued call_model.
    //
    // The runaway guard wins first — this branch also issues a model call,
    // so it must terminate exactly like the max_tokens limit path above:
    // done + error, and the queue stays untouched for the host's auto-flush
    // under a fresh budget (spec scenario G).
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
    if (state.queuedUserInputs.length > 0) {
      const flushed = appendQueuedAndClear(baseState, baseState.messages);
      const continuedState: ReducerState = {
        ...flushed.state,
        status: "calling_model",
      };
      return {
        state: continuedState,
        effects: [
          emitEffect,
          ...flushed.delivered,
          buildCallModelEffect(continuedState.messages, baseState.pinnedMessageIds, ctx, baseState.todos),
        ],
      };
    }

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
          buildCallModelEffect(retryState.messages, retryState.pinnedMessageIds, ctx, retryState.todos),
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
    return queueUserMessage(state, input, ctx);
  }

  return errorResult(state, `calling_model: unexpected input type "${input.type}"`);
}

function handleExecutingTools(state: ReducerState, input: AgentInput, ctx: StepContext): StepResult {
  if (input.type === "tool_result") {
    const toolResultMsg: ToolResultMessage = stamp(
      {
        id: "",
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: input.toolCallId,
            content: normalizeToolResultContent(input.result.modelContent),
            ...(input.result.isError ? { isError: true } : {}),
          },
        ],
      },
      ctx,
    );

    // Record file access from this result (pure, deterministic)
    const fileAccess = input.result.isError ? null : extractFileAccess(input.result.displayMetadata);
    const readFiles: ReadFileRecord[] = fileAccess
      ? recordFileAccess(state.readFiles, fileAccess)
      : state.readFiles;

    // Apply ToolResult.statePatch (v1: todos only). Pure; replay-safe.
    // isError results must not mutate standing state. Parallel patches in
    // one batch resolve last-write-wins (whole-list replace semantics).
    let todos = state.todos;
    const todoEmit: Effect[] = [];
    if (!input.result.isError && input.result.statePatch?.todos !== undefined) {
      todos = input.result.statePatch.todos;
      const counts = {
        pending: todos.filter((t) => t.status === "pending").length,
        inProgress: todos.filter((t) => t.status === "in_progress").length,
        completed: todos.filter((t) => t.status === "completed").length,
      };
      todoEmit.push(
        {
          type: "emit",
          event: { type: "todoListUpdated", data: { todos, counts } },
        },
        {
          type: "emit",
          event: {
            type: "context_reminder",
            data: {
              kind: "todo_list",
              text: formatTodoListForModel(todos),
              displayMetadata: { counts },
            },
          },
        },
      );
    }

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
          // Structured blocks (including image refs) pass through unchanged —
          // joining text here would drop attachment ids permanently.
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
          todos,
        },
        effects: [resultEmit, ...todoEmit],
      };
    }

    // All tools done — flush in pendingTools order for deterministic replay
    const orderedResultMsgs = state.pendingTools
      .map((t) => newBuffer[t.id])
      .filter((msg): msg is ToolResultMessage => msg !== undefined);

    // Drain steering queue: inject queued user messages at the turn boundary.
    // The delivered signal names every drained id (FIFO) so projections can
    // finalize the queued entries; an empty queue drains nothing, so it
    // emits nothing. Shared drain primitive (D11).
    const flushed = appendQueuedAndClear(state, [...state.messages, ...orderedResultMsgs]);

    const newState: ReducerState = {
      ...flushed.state,
      pendingTools: [],
      _toolResultBuffer: {},
      readFiles,
      todos,
      status: "calling_model",
    };

    return {
      state: newState,
      effects: [
        resultEmit,
        ...todoEmit,
        ...flushed.delivered,
        buildCallModelEffect(newState.messages, newState.pinnedMessageIds, ctx, newState.todos),
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
    // Pair every pending tool_use before the teardown (cancel tier): the
    // already-buffered real results are kept, the missing ones synthesized.
    return {
      state: {
        ...state,
        messages: [...state.messages, ...synthesizeInterruptedResults(state, ctx, "cancel")],
        status: "cancelling",
        pendingTools: [],
        _toolResultBuffer: {},
      },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }

  if (input.type === "user_message") {
    // Steering: queue for injection at next turn boundary
    return queueUserMessage(state, input, ctx);
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
 * `user` and an absent reason share one wording — `userDenialMessage` — which
 * transcript-projection.ts synthesizes too, so a resumed session's history
 * matches the live one byte for byte.
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
      return userDenialMessage(toolName);
  }
}

/**
 * The tool result an interrupted call reports back to the MODEL.
 *
 * Every termination path that clears the tool roster pairs each un-fulfilled
 * `tool_use` with an `isError: true` tool_result — providers reject a request
 * whose tail assistant message carries un-paired `tool_use` entries outright.
 * The tier wording says what happened without attributing judgement:
 * "cancel" for a user-initiated abort, "limit" for a safety-limit teardown
 * (budget / iteration cap / loop hard-kill).
 *
 * Exported because transcript-projection.ts synthesizes the same text from
 * `turn_end`, so a resumed session's history matches the live one byte for
 * byte — same sharing rule as `userDenialMessage` above.
 */
export function interruptionMessageFor(toolName: string, tier: "cancel" | "limit"): string {
  switch (tier) {
    case "cancel":
      return (
        `Tool "${toolName}" was interrupted: the user cancelled the turn before it finished. ` +
        `The call was not judged either way.`
      );
    case "limit":
      return `Tool "${toolName}" was interrupted: the turn was terminated by a safety limit before it finished.`;
  }
}

/**
 * Pair every tool_use on the roster when a termination path tears the batch
 * down: an id whose result already arrived (`_toolResultBuffer`) keeps that
 * real result — flushing it is more truthful than replacing it — and every
 * missing one is synthesized with the tier's wording and `isError: true`.
 * Roster order (`pendingTools`, then `pendingApprovalTool`), matching the
 * flush order of a completed batch.
 *
 * Idempotent by construction: once the roster is cleared the walk is empty,
 * so the cancelling → done hop never double-synthesizes.
 */
function synthesizeInterruptedResults(
  state: ReducerState,
  ctx: StepContext,
  tier: "cancel" | "limit",
): ToolResultMessage[] {
  const roster = [
    ...state.pendingTools,
    ...(state.pendingApprovalTool !== undefined ? [state.pendingApprovalTool] : []),
  ];
  return roster.map((tool) => {
    const buffered = state._toolResultBuffer[tool.id];
    if (buffered !== undefined) return buffered;
    return stamp(
      {
        id: "",
        role: "tool" as const,
        content: [
          {
            type: "tool_result",
            toolUseId: tool.id,
            content: normalizeToolResultContent(interruptionMessageFor(tool.name, tier)),
            isError: true,
          },
        ],
      },
      ctx,
    );
  });
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
    const denyResultMsg: ToolResultMessage = stamp(
      {
        id: "",
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: input.toolCallId,
            content: normalizeToolResultContent(denialMessageFor(approvedTool.name, input.reason)),
            isError: true,
          },
        ],
      },
      ctx,
    );

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

    // Drain steering queue at turn boundary; same non-empty rule as the
    // tool-batch flush in handleExecutingTools. Shared drain primitive (D11).
    const flushed = appendQueuedAndClear(state, [...state.messages, ...orderedResultMsgs]);

    return {
      state: {
        ...flushed.state,
        pendingTools: [],
        _toolResultBuffer: {},
        pendingApprovalTool: undefined,
        status: "calling_model",
      },
      effects: [
        ...flushed.delivered,
        buildCallModelEffect(flushed.state.messages, state.pinnedMessageIds, ctx, state.todos),
      ],
    };
  }

  if (input.type === "cancel") {
    // Pair every pending tool_use before the teardown (cancel tier) — the
    // approval-pending call is on the roster too and must be answered.
    // Clearing the whole roster keeps the cancelling → done hop from
    // synthesizing a second time.
    return {
      state: {
        ...state,
        messages: [...state.messages, ...synthesizeInterruptedResults(state, ctx, "cancel")],
        status: "cancelling",
        pendingTools: [],
        pendingApprovalTool: undefined,
        _toolResultBuffer: {},
      },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }

  if (input.type === "user_message") {
    // D4: user_message is never rejected — it queues while the approval is
    // pending and rides into the drain when the decision resolves the batch.
    return queueUserMessage(state, input, ctx);
  }

  return errorResult(state, `waiting_for_approval: unexpected input type "${input.type}"`);
}

function handleWaitingForInput(state: ReducerState, input: AgentInput, ctx: StepContext): StepResult {
  if (input.type === "cancel") {
    return {
      state: { ...state, status: "cancelling" },
      effects: [{ type: "emit", event: { type: "cancelled", data: { reason: input.reason } } }],
    };
  }

  if (input.type === "user_message") {
    // D4: queue instead of erroring — the suspended state must not swallow
    // user input; the queue drains at the next turn boundary.
    return queueUserMessage(state, input, ctx);
  }

  return errorResult(state, `waiting_for_input: unexpected input type "${input.type}"`);
}

function handleCancelling(state: ReducerState, input: AgentInput, ctx: StepContext): StepResult {
  if (input.type === "cancel") {
    return {
      state: { ...state, status: "done" },
      effects: [{ type: "done" }],
    };
  }

  if (input.type === "user_message") {
    // D4: queue instead of erroring — a message racing the turn teardown is
    // kept for the host-side auto-run rather than dropped.
    return queueUserMessage(state, input, ctx);
  }

  return errorResult(state, `cancelling: unexpected input type "${input.type}"`);
}

/**
 * Format a FileChangedInput batch as the model-visible user notice.
 * Pure and deterministic — no clock, no random, no I/O. An empty batch still
 * produces the header line so the model learns the watch fired (debounce/glob
 * may legitimately filter every event out of a batch).
 */
export function formatFileChangedNotice(input: {
  watchId: string;
  events: ReadonlyArray<{ type: string; path: string }>;
}): string {
  const lines = input.events.map((e) => `- ${e.type} ${e.path}`);
  return [`File watch "${input.watchId}" reported ${input.events.length} change(s):`, ...lines].join(
    "\n",
  );
}

/**
 * Reducer handling for a debounced FileWatcher batch.
 *
 * - idle: append the notice as a user message and wake a new model call.
 * - active/busy: append only — the message rides into the next call_model;
 *   never interrupt an in-flight model call or pending tool roster.
 * - cancelling / done: drop with an observable warning emit; never throw.
 */
function handleFileChanged(
  state: ReducerState,
  input: Extract<AgentInput, { type: "file_changed" }>,
  ctx: StepContext,
): StepResult {
  const notice = formatFileChangedNotice(input);
  const fileChangedEmit: Effect = {
    type: "emit",
    event: {
      type: "file_changed",
      data: { watchId: input.watchId, events: input.events },
    },
  };

  if (state.status === "idle") {
    const noticeMsg = stamp({ id: "", role: "user" as const, content: notice }, ctx);
    const newState: ReducerState = {
      ...state,
      messages: [...state.messages, noticeMsg],
      status: "calling_model",
      iterationCount: 0,
    };
    return {
      state: newState,
      effects: [
        buildCallModelEffect(newState.messages, newState.pinnedMessageIds, ctx, newState.todos),
        fileChangedEmit,
      ],
    };
  }

  if (
    state.status === "calling_model" ||
    state.status === "executing_tools" ||
    state.status === "waiting_for_approval" ||
    state.status === "waiting_for_input"
  ) {
    // Same steering-queue pattern as user_message: a turn may have an
    // assistant tool_use awaiting its tool_result, and providers like
    // Anthropic reject a request where a user message splits that pair.
    // Queuing defers the notice to the turn boundary (drained alongside
    // queuedUserInputs once every pending tool result has flushed) instead
    // of appending it into messages mid-turn.
    //
    // Deliberately NOT announced as steering_queued: the notice is an input
    // the model must see, not a user-authored message the UI may edit or
    // retract. The drain still names its id in steering_delivered, and every
    // fold treats an unknown delivered id as a no-op — so no fake queued
    // event is needed to "balance" the delivery.
    const noticeMsg = stamp({ id: "", role: "user" as const, content: notice }, ctx);
    return {
      state: { ...state, queuedUserInputs: [...state.queuedUserInputs, noticeMsg] },
      effects: [fileChangedEmit],
    };
  }

  // cancelling / done — drop with an observable warning; never throw.
  return {
    state,
    effects: [
      {
        type: "emit",
        event: {
          type: "error",
          data: {
            error: `file_changed dropped: agent status is "${state.status}" (watchId=${input.watchId})`,
          },
        },
      },
    ],
  };
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Stamp a newly-appended message with a stable id from the optional Id port.
 * Existing messages are never re-stamped. When no port is supplied the
 * construction-time id is left untouched (hosts that skip the port must
 * supply ids themselves, or accept empty placeholders).
 */
function stamp<T extends Message>(msg: T, ctx: StepContext): T {
  if (!ctx.id) return msg;
  return { ...msg, id: ctx.id.next() };
}

/**
 * D11 — the shared queue-drain primitive behind every flush / turn-boundary
 * drain site (idle user_message flush, steering_flush, tool-batch flush,
 * approval-batch flush, end_turn continuation). Appends the queued user
 * inputs to `messages` in FIFO order — ORIGINAL ids preserved, delivery
 * never re-stamps — and returns the state with `queuedUserInputs` cleared,
 * plus the delivered ids and the matching `steering_delivered` emit. An
 * empty queue drains nothing: `ids` and `delivered` are empty (drains emit
 * nothing) and `messages` passes through untouched.
 */
function appendQueuedAndClear(
  state: ReducerState,
  messages: readonly Message[],
): { state: ReducerState; ids: string[]; delivered: Effect[] } {
  const ids = state.queuedUserInputs.map((m) => m.id);
  return {
    state: {
      ...state,
      messages: [...messages, ...state.queuedUserInputs],
      queuedUserInputs: [],
    },
    ids,
    delivered:
      ids.length > 0
        ? [{ type: "emit", event: { type: "steering_delivered", data: { ids } } }]
        : [],
  };
}

/**
 * D4 — the single queue site for user messages. Every status except idle
 * routes `user_message` here: the message is stamped with its id (Id port),
 * appended to `queuedUserInputs` (FIFO), and announced with `steering_queued`
 * so projections can match the queued entry to its later delivery. Never
 * rejects, never changes status, never touches anything else in state.
 */
function queueUserMessage(
  state: ReducerState,
  input: Extract<AgentInput, { type: "user_message" }>,
  ctx: StepContext,
): StepResult {
  const userMsg = stamp({ id: "", role: "user" as const, content: input.content }, ctx);
  return {
    state: { ...state, queuedUserInputs: [...state.queuedUserInputs, userMsg] },
    effects: [
      {
        type: "emit",
        event: { type: "steering_queued", data: { id: userMsg.id, content: input.content } },
      },
    ],
  };
}

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
  // undefined = no step cap (see createInitialState). Only an explicitly
  // configured number bounds the inner loop.
  if (state.maxIterations !== undefined && state.iterationCount >= state.maxIterations) {
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
 * boundaries) and re-injects the standing todo list from AgentState.
 * Pure — no I/O, no random.
 */
function buildCallModelEffect(
  messages: Message[],
  pinnedMessageIds: string[] | undefined,
  ctx: StepContext,
  todos?: readonly TodoItem[],
): Effect {
  const assembled = assembleContext({
    messages,
    tools: ctx.tools,
    pinnedMessageIds,
    contextLayers: ctx.contextLayers,
    todos,
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
