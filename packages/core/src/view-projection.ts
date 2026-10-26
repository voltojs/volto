/**
 * Projects a session's event log into the shapes a UI renders.
 *
 * `buildTurnRecords` is the only place in the repository that pairs tool
 * results back to their calls, orders a parallel batch, attaches approvals,
 * or splices a streaming partial into a step. Both views below are shallow
 * derivations of its output, so those rules cannot drift apart.
 *
 * Pure: no I/O, no clock, no randomness. Browser-safe.
 */

import type { ContentBlock, ToolResultBlock } from "./state.js";
import type {
  ApprovalDenialReason,
  TokenUsage,
  ContextReminderKind,
  TranscriptEvent,
  TranscriptEventMap,
  TurnEndReason,
} from "./ports.js";
import { extractBlockText } from "./text-extract.js";
import { totalUsageTokens } from "./pricing.js";

// ──────────────────────────────────────────────
// Intermediate layer
// ──────────────────────────────────────────────

export interface UserInputRecord {
  /** `queued` means steering — injected while the turn was already running. */
  origin: "direct" | "queued";
  content: string | ContentBlock[];
  time: number;
}

/** 一次模型调用的路由来源：宿主的 provider 配置 id + 模型 id。 */
export interface RouteSource {
  providerId?: string;
  modelId: string;
}

/**
 * 一轮对话的 token 账目：该轮每次模型调用的累加（spec 2026-09-26 D1）。
 * 只挂在该轮最后一条 assistant 消息上。
 */
export interface TurnUsage {
  /** 未缓存 prompt tokens（adapter 已归一化，见 openai/stream-normalize.ts）。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * inputTokens + outputTokens + cacheRead + cacheWrite，与 provider 自己报的
   * total 同口径（复用 pricing 的 totalUsageTokens，避免第二份公式）。
   */
  totalTokens: number;
  /** 该轮最后一次携带 source 的调用；整轮都没 source 时该键不存在。 */
  source?: RouteSource;
  /**
   * 该轮未上报 usage 的模型调用次数——它们的 token 不在上面的和里。
   * UI 用它出一行脚注，而不是把缺测当 0（D5）。
   */
  missingUsageCalls: number;
}

export interface AssistantRecord {
  content: ContentBlock[];
  reasoning?: string;
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
  usage?: TokenUsage;
  ttftMs?: number;
  durationMs: number;
  interrupted?: true;
  /** 产生这条消息的路由（assistant_message.source）。 */
  source?: RouteSource;
}

export interface PartialAssistant {
  text: string;
  reasoning: string;
  /** Calls whose arguments are still streaming in. */
  pendingCalls: Array<{ callId: string; name: string; argumentsDelta: string }>;
}

export interface ToolCallRecord {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  orderInBatch: number;
  startedAt: number;
  // ── Result half; all absent until the tool reports. ──
  /** String for plain-text results; a block array when the tool returned images. */
  content?: string | ToolResultBlock[];
  isError?: boolean;
  durationMs?: number;
  displayMetadata?: Record<string, unknown>;
  /**
   * Approval gating for this call. Present from the moment `approval_asked`
   * is recorded (risk tier alone); `decision` is filled in only when the
   * `approval_decision` event arrives — absent means still pending, never
   * "allowed". `reason` is present only when the gate supplied one.
   */
  approval?: {
    riskTier: string;
    decision?: "allow" | "deny";
    reason?: ApprovalDenialReason;
  };
  /** Set when this call delegated to a sub-agent; points at its own session. */
  childSessionId?: string;
}

export interface RetryRecord {
  attempt: number;
  delayMs: number;
  error: string;
  time: number;
}

export interface StepRecord {
  step: number;
  startedAt: number;
  endedAt?: number;
  headerHash: string;
  /** Present once the call completed; while streaming, see `partial`. */
  assistant?: AssistantRecord;
  /** Only ever on the last step of the last turn. */
  partial?: PartialAssistant;
  toolCalls: ToolCallRecord[];
  retries: RetryRecord[];
  error?: { message: string; errorKind?: string; retriable: boolean };
}

export interface TurnRecord {
  turn: number;
  startedAt: number;
  endedAt?: number;
  reason?: TurnEndReason;
  userInput: UserInputRecord[];
  steps: StepRecord[];
  error?: string;
  /**
   * A sub-agent dispatch announced by `subagent_started` whose `tool_call`
   * event has not been flushed yet — the runner buffers tool_call events to
   * batch end, so a running dispatch has no ToolCallRecord to carry the link.
   * Present only while that window is open; cleared once the flush lands and
   * the parking claim moves onto the record. At most one per turn (the
   * parking map's existing single-slot shape).
   */
  pendingSubagent?: { label: string; childSessionId: string; startedAt: number };
  /**
   * Usage of this turn's compaction summarization call, when the provider
   * reported one. Compaction is not a visible step, so it rides the turn
   * record directly; `summariseTurnUsage` folds it into the turn totals so
   * the cache-hit and cost cards account for the call.
   */
  compactionUsage?: TokenUsage;
}

// ──────────────────────────────────────────────
// buildTurnRecords
// ──────────────────────────────────────────────

interface MutableStep extends StepRecord {
  toolCalls: ToolCallRecord[];
  retries: RetryRecord[];
}

interface MutableTurn extends TurnRecord {
  userInput: UserInputRecord[];
  steps: MutableStep[];
}

function newTurn(turn: number, startedAt: number): MutableTurn {
  return { turn, startedAt, userInput: [], steps: [] };
}

function newStep(step: number, startedAt: number, headerHash: string): MutableStep {
  return { step, startedAt, headerHash, toolCalls: [], retries: [] };
}

/**
 * Groups a session's events into turns and steps.
 *
 * A `subagent_started` is linked to the tool call that spawned it even when
 * the on-disk order is inverted — the SDK appends the bracket straight to the
 * store while the parent runner flushes its buffered `tool_call` at batch
 * end — by parking the start on its turn until a same-named call arrives.
 *
 * `prev` is a pure optimisation: closed turns (those with an `endedAt`) whose
 * shape is unchanged keep their previous object identity, so a React consumer
 * memoising per row re-renders only the turn still in flight. Passing a `prev`
 * from a different session cannot corrupt the result — identity is reused only
 * when the turn number and end time match and a cheap structural watermark
 * agrees: same user-input count, same step count, and same tool-call count on
 * the last step. A log extended after the turn closed (e.g. a pre-fix resume
 * appending past a paused turn's bracket) keeps its end time but fails the
 * watermark, so it is rebuilt instead of served stale from `prev`.
 */
export function buildTurnRecords(
  events: readonly TranscriptEvent[],
  prev?: readonly TurnRecord[],
): TurnRecord[] {
  const turns: MutableTurn[] = [];
  let current: MutableTurn | undefined;

  /** The step an event belongs to, created on demand for out-of-order logs. */
  const stepFor = (turn: MutableTurn, step: number | undefined, time: number): MutableStep | undefined => {
    if (step === undefined) return undefined;
    let found = turn.steps.find((s) => s.step === step);
    if (!found) {
      found = newStep(step, time, "");
      turn.steps.push(found);
    }
    return found;
  };

  /** The turn an event belongs to, opened on demand when turn_start is missing. */
  const turnFor = (event: TranscriptEvent): MutableTurn => {
    const n = event.turn ?? 0;
    if (current && current.turn === n) return current;
    const existing = turns.find((t) => t.turn === n);
    if (existing) {
      current = existing;
      return existing;
    }
    const created = newTurn(n, event.time);
    turns.push(created);
    current = created;
    return created;
  };

  /** Finds a call across the whole turn — a result may arrive in a later step. */
  const findCall = (turn: MutableTurn, callId: string): ToolCallRecord | undefined => {
    for (let i = turn.steps.length - 1; i >= 0; i--) {
      const hit = turn.steps[i]!.toolCalls.find((c) => c.callId === callId);
      if (hit) return hit;
    }
    return undefined;
  };

  /**
   * The most recent call still missing a childSessionId — the one that just
   * delegated. With a `label`, only a name-matching call qualifies (the
   * sub-agent's label is the tool name that spawned it); without one, any
   * unlinked call — the pre-existing in-order shape.
   */
  const lastUnlinkedCall = (turn: MutableTurn, label?: string): ToolCallRecord | undefined => {
    for (let i = turn.steps.length - 1; i >= 0; i--) {
      const calls = turn.steps[i]!.toolCalls;
      for (let j = calls.length - 1; j >= 0; j--) {
        const call = calls[j]!;
        if (call.childSessionId === undefined && (label === undefined || call.name === label)) {
          return call;
        }
      }
    }
    return undefined;
  };

  /**
   * `subagent_started` events parked because their tool call had not been
   * flushed yet, keyed by turn number. The SDK appends the bracket straight
   * to the store while the parent runner flushes its buffered `tool_call` at
   * batch end, so the on-disk order can be inverted; a parked start is
   * claimed by the first same-named call that arrives, and one that never is
   * surfaces on its turn record as `pendingSubagent` (the dispatch is still
   * running — the conversation view links the block from there).
   */
  const pendingSubagents = new Map<number, TranscriptEvent<"subagent_started">>();

  for (const event of events) {
    switch (event.type) {
      case "turn_start": {
        const data = event.data as TranscriptEventMap["turn_start"];
        // A stray out-of-order event (e.g. the SDK's directly-appended
        // subagent_started) may have opened this turn's shell already — adopt it
        // instead of emitting a duplicate record whose context rows double up.
        const shell = turns.find((t) => t.turn === data.turn && t.endedAt === undefined);
        if (shell) {
          current = shell;
          break;
        }
        const created = newTurn(data.turn, event.time);
        turns.push(created);
        current = created;
        break;
      }

      case "turn_end": {
        const data = event.data as TranscriptEventMap["turn_end"];
        const turn = turnFor(event);
        turn.endedAt = event.time;
        turn.reason = data.reason;
        if (data.error !== undefined) turn.error = data.error;
        break;
      }

      case "user_message": {
        const data = event.data as TranscriptEventMap["user_message"];
        turnFor(event).userInput.push({ origin: "direct", content: data.content, time: event.time });
        break;
      }

      case "steering_queued": {
        const data = event.data as TranscriptEventMap["steering_queued"];
        turnFor(event).userInput.push({ origin: "queued", content: data.content, time: event.time });
        break;
      }

      case "model_call_start": {
        const data = event.data as TranscriptEventMap["model_call_start"];
        const turn = turnFor(event);
        const step = newStep(event.step ?? turn.steps.length + 1, event.time, data.headerHash);
        turn.steps.push(step);
        break;
      }

      case "assistant_message": {
        const data = event.data as TranscriptEventMap["assistant_message"];
        const step = stepFor(turnFor(event), event.step, event.time);
        if (!step) break;
        step.endedAt = event.time;
        const reasoningText = data.content
          .filter((b): b is Extract<ContentBlock, { type: "reasoning" }> => b.type === "reasoning")
          .map((b) => b.text)
          .join("");
        step.assistant = {
          content: data.content,
          ...(reasoningText ? { reasoning: reasoningText } : {}),
          ...(data.stopReason !== undefined ? { stopReason: data.stopReason } : {}),
          ...(data.usage !== undefined ? { usage: data.usage } : {}),
          ...(data.source !== undefined ? { source: data.source } : {}),
          ...(data.ttftMs !== undefined ? { ttftMs: data.ttftMs } : {}),
          durationMs: data.durationMs,
          ...(data.interrupted !== undefined ? { interrupted: data.interrupted } : {}),
        };
        // The authoritative message supersedes whatever was streaming.
        delete step.partial;
        break;
      }

      case "tool_call": {
        const data = event.data as TranscriptEventMap["tool_call"];
        const turn = turnFor(event);
        const step = stepFor(turn, event.step, event.time);
        if (!step) break;
        const call: ToolCallRecord = {
          callId: data.callId,
          name: data.name,
          input: data.input,
          // Real order arrives with the result; until then keep insertion order.
          orderInBatch: step.toolCalls.length,
          startedAt: event.time,
        };
        step.toolCalls.push(call);
        // Claim a subagent_started that was parked because it hit the store
        // before this buffered flush. Only a name match may claim it — a
        // parked start whose call never arrives simply stays parked.
        const pending = pendingSubagents.get(turn.turn);
        if (pending && data.name === pending.data.label && call.childSessionId === undefined) {
          call.childSessionId = pending.data.childSessionId;
          pendingSubagents.delete(turn.turn);
        }
        break;
      }

      case "tool_result": {
        const data = event.data as TranscriptEventMap["tool_result"];
        const turn = turnFor(event);
        const call = findCall(turn, data.callId);
        if (!call) break;
        call.orderInBatch = data.orderInBatch;
        call.content = data.content;
        call.isError = data.isError;
        if (data.durationMs !== undefined) call.durationMs = data.durationMs;
        if (data.displayMetadata !== undefined) call.displayMetadata = data.displayMetadata;
        break;
      }

      case "approval_asked": {
        const data = event.data as TranscriptEventMap["approval_asked"];
        const call = findCall(turnFor(event), data.callId);
        // riskTier only — a decision has not been made yet. Writing a
        // provisional decision here would render a pending approval as if it
        // had been allowed; `approval_decision` fills `decision` in later.
        if (call) call.approval = { riskTier: data.riskTier };
        break;
      }

      case "approval_decision": {
        const data = event.data as TranscriptEventMap["approval_decision"];
        const call = findCall(turnFor(event), data.callId);
        if (call && call.approval) {
          call.approval = {
            ...call.approval,
            decision: data.decision,
            ...(data.reason !== undefined ? { reason: data.reason } : {}),
          };
        }
        break;
      }

      case "model_retry": {
        const data = event.data as TranscriptEventMap["model_retry"];
        const step = stepFor(turnFor(event), event.step, event.time);
        step?.retries.push({ attempt: data.attempt, delayMs: data.delayMs, error: data.error, time: event.time });
        break;
      }

      case "model_error": {
        const data = event.data as TranscriptEventMap["model_error"];
        const step = stepFor(turnFor(event), event.step, event.time);
        if (step) {
          step.error = { message: data.error, errorKind: data.errorKind, retriable: data.retriable };
        }
        break;
      }

      case "subagent_started": {
        const data = event.data as TranscriptEventMap["subagent_started"];
        const turn = turnFor(event);
        // The SDK appends this event straight to the store while the parent
        // runner flushes its buffered tool_call at batch end, so it may
        // precede its call on disk. Prefer the unlinked call this label
        // names; fall back to the in-order behaviour (most recent unlinked
        // call); with nothing linkable, park it until the call arrives.
        const call = lastUnlinkedCall(turn, data.label) ?? lastUnlinkedCall(turn);
        if (call) {
          call.childSessionId = data.childSessionId;
          pendingSubagents.delete(turn.turn);
        } else {
          // The whole event is parked, not just its data: the dispatch start
          // time the surfaced `pendingSubagent` needs lives on the envelope.
          pendingSubagents.set(turn.turn, event as TranscriptEvent<"subagent_started">);
        }
        break;
      }

      case "error": {
        const data = event.data as TranscriptEventMap["error"];
        turnFor(event).error = data.message;
        break;
      }

      case "compaction": {
        // Log-only for the conversation feed, but its summarization usage is
        // part of the turn's real cost — carry it onto the turn record.
        const data = event.data as TranscriptEventMap["compaction"];
        if (data.usage !== undefined) {
          turnFor(event).compactionUsage = data.usage;
        }
        break;
      }

      default:
        // Log-only: session_meta, request_header, context_assembled,
        // context_reminder, budget_exceeded, subagent_finished.
        // They carry audit detail the trajectory view reads straight off the
        // event list, and structurally never enter a TurnRecord — which is
        // why toConversationView (built from TurnRecord[], not raw events)
        // can never render one. Do not add a case here for context_reminder;
        // that would break the "never leaks into chat" guarantee.
        break;
    }
  }

  // A start still parked when the log ends is a dispatch in flight — its
  // tool_call is buffered until batch end, so no ToolCallRecord carries the
  // link yet. Surface it on the turn for the conversation view; the claim in
  // the tool_call case above already removed it once the flush landed.
  for (const [turnNo, pending] of pendingSubagents) {
    const turn = turns.find((t) => t.turn === turnNo);
    if (turn) {
      turn.pendingSubagent = {
        label: pending.data.label,
        childSessionId: pending.data.childSessionId,
        startedAt: pending.time,
      };
    }
  }

  for (const turn of turns) {
    turn.steps.sort((a, b) => a.step - b.step);
    for (const step of turn.steps) {
      step.toolCalls.sort((a, b) => a.orderInBatch - b.orderInBatch);
    }
  }

  if (!prev) return turns;

  // Reuse identity for closed turns whose shape is unchanged, so a memoising
  // consumer re-renders only the turn still in flight. Turn number, end time
  // and the structural watermark below must all agree: events appended after
  // a turn_end (a pre-fix resume-shaped log) keep the same end time but grow
  // one of these lengths, and lengths are cheap to compare while content is
  // not. The watermark compares only lengths, so same-length in-place content
  // growth on the last step (e.g. a tool_result filling a call without adding
  // a step) is not detected — unreachable from current write-side shapes
  // (post-pause turns keep endedAt undefined) and acceptable as
  // defense-in-depth.
  return turns.map((turn, i) => {
    const before = prev[i];
    if (
      before !== undefined &&
      before.turn === turn.turn &&
      before.endedAt !== undefined &&
      before.endedAt === turn.endedAt &&
      before.userInput.length === turn.userInput.length &&
      before.steps.length === turn.steps.length &&
      before.steps[before.steps.length - 1]?.toolCalls.length ===
        turn.steps[turn.steps.length - 1]?.toolCalls.length
    ) {
      return before;
    }
    return turn;
  });
}

// ──────────────────────────────────────────────
// ConversationView
// ──────────────────────────────────────────────

export interface ConversationToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** The tool's real output — not a metadata summary. */
  result?: string;
  isError?: boolean;
  durationMs?: number;
  /** Set when this call delegated to a sub-agent; points at its own session. */
  childSessionId?: string;
  /** When the call started (the subagent_started bracket's dispatch time). */
  startedAt?: number;
  /**
   * Approval gating outcome for this call, when it went through a gate.
   * Carried so a UI can tell a user denial from a fail-closed one after a
   * reconnect, when the live `ApprovalCard` is already gone.
   */
  approval?: { decision?: "allow" | "deny"; reason?: ApprovalDenialReason };
}

export type ConversationBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ConversationToolCall }
  | { type: "reasoning"; text: string }
  /**
   * An image attached to a user message. Ref-only: the UI resolves
   * `attachmentId` against the attachment endpoint. Base64 must never enter
   * this projection — the view crosses process boundaries and is rebuilt
   * from the durable log on every cold load.
   */
  | {
      type: "image";
      attachmentId: string;
      mediaType?: string;
      width?: number;
      height?: number;
    };

export interface ConversationMessage {
  /** Stable across incremental rebuilds — never an array index. */
  id: string;
  role: "user" | "assistant";
  blocks: ConversationBlock[];
  /** All text segments concatenated, for copy-to-clipboard. */
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  /**
   * 仅出现在该轮的**最后一条** assistant 消息上，且仅当该轮至少一次调用
   * 上报了 usage；整轮无上报 → 该字段不存在（不编造 0 tok）。
   */
  turnUsage?: TurnUsage;
}

export interface ConversationView {
  messages: ConversationMessage[];
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" | "structured" }> =>
        b.type === "text" || b.type === "structured",
    )
    .map((b) => b.text)
    .join("");
}

/** Flatten a tool result into display text; image blocks become placeholders. */
function toolResultText(content: string | ToolResultBlock[]): string {
  if (typeof content === "string") return content;
  return content.map(extractBlockText).join("\n");
}

/**
 * 把一轮的全部模型调用汇总成 TurnUsage（spec 2026-09-26 §3.2）。
 *
 * 一次调用都没上报 → undefined：UI 必须什么都不显示，而不是一个编造的
 * `0 tok`（D5）。没上报的调用计入 missingUsageCalls，而不是按 0 累加——
 * 卡片据此声明缺口。source 取该轮最后一次携带它的调用（通常是产出最终
 * 答复的那次）。
 */
function summariseTurnUsage(turn: TurnRecord): TurnUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reported = 0;
  let missingUsageCalls = 0;
  let source: RouteSource | undefined;

  for (const step of turn.steps) {
    const assistant = step.assistant;
    if (assistant?.source !== undefined) source = assistant.source;
    const usage = assistant?.usage;
    if (usage === undefined) {
      missingUsageCalls += 1;
      continue;
    }
    reported += 1;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
    cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  }

  // Compaction is a real model call but not a step: fold its usage into the
  // turn totals (reported, so it is not listed as a missing call).
  const compactionUsage = turn.compactionUsage;
  if (compactionUsage !== undefined) {
    reported += 1;
    inputTokens += compactionUsage.inputTokens;
    outputTokens += compactionUsage.outputTokens;
    cacheReadTokens += compactionUsage.cacheReadTokens ?? 0;
    cacheWriteTokens += compactionUsage.cacheWriteTokens ?? 0;
  }

  if (reported === 0) return undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: totalUsageTokens({
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }),
    ...(source !== undefined ? { source } : {}),
    missingUsageCalls,
  };
}

/**
 * Map user-facing content blocks into the conversation feed. Text and image
 * refs ride through; other block kinds are not user-message payload.
 */
function userConversationBlocks(content: string | ContentBlock[]): ConversationBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  const blocks: ConversationBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text) blocks.push({ type: "text", text: block.text });
    } else if (block.type === "structured") {
      // A structured block has no dedicated chat shape; its REQUIRED text
      // projection is the single degradation exit, so render that.
      if (block.text) blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push({
        type: "image",
        attachmentId: block.source.id,
        mediaType: block.source.mediaType,
        ...(block.width !== undefined ? { width: block.width } : {}),
        ...(block.height !== undefined ? { height: block.height } : {}),
      });
    }
  }
  return blocks;
}

/**
 * Derives the chat feed.
 *
 * System scaffolding never appears. A tool result is folded into the
 * assistant block that called it rather than becoming its own entry, so a
 * call renders where it actually happened in the reply.
 *
 * A queued (steering) input renders before the first step whose `startedAt`
 * is greater than the input's `time` — the reducer drains the queue after a
 * batch's results and before the next model call
 * (`[...results, ...queuedUserInputs]`), so that is where the model actually
 * saw it. Ordering by raw event time instead would show the user a history
 * the model never saw. A queued input with no such step (the turn ended
 * before the queue drained) stays at the end of the turn.
 */
export function toConversationView(records: readonly TurnRecord[]): ConversationView {
  const messages: ConversationMessage[] = [];

  for (const turn of records) {
    const turnStart = messages.length;
    const direct = turn.userInput.filter((u) => u.origin === "direct");
    const queued = turn.userInput.filter((u) => u.origin === "queued");

    const emitUser = (input: UserInputRecord, id: string): void => {
      const text = textOf(input.content);
      messages.push({
        id,
        role: "user",
        blocks: userConversationBlocks(input.content),
        content: text,
        timestamp: input.time,
      });
    };

    const emitStep = (step: StepRecord): void => {
      const blocks: ConversationBlock[] = [];
      const assistant = step.assistant;

      const reasoning = assistant?.reasoning ?? (step.partial?.reasoning || undefined);
      if (reasoning) blocks.push({ type: "reasoning", text: reasoning });

      if (assistant) {
        let buffer = "";
        const flush = (): void => {
          if (buffer) {
            blocks.push({ type: "text", text: buffer });
            buffer = "";
          }
        };
        for (const block of assistant.content) {
          if (block.type === "text") {
            buffer += block.text;
          } else if (block.type === "structured") {
            // Structured rides the text buffer via its required projection.
            buffer += block.text;
          } else if (block.type === "tool_use") {
            flush();
            const call = step.toolCalls.find((c) => c.callId === block.id);
            if (call !== undefined) {
              blocks.push({
                type: "tool_call",
                call: {
                  id: block.id,
                  name: block.name,
                  args: block.input,
                  ...(call?.content !== undefined ? { result: toolResultText(call.content) } : {}),
                  ...(call?.isError !== undefined ? { isError: call.isError } : {}),
                  ...(call?.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
                  ...(call?.childSessionId !== undefined ? { childSessionId: call.childSessionId } : {}),
                  ...(call?.startedAt !== undefined ? { startedAt: call.startedAt } : {}),
                  ...(call?.approval !== undefined
                    ? {
                        approval: {
                          ...(call.approval.decision !== undefined
                            ? { decision: call.approval.decision }
                            : {}),
                          ...(call.approval.reason !== undefined
                            ? { reason: call.approval.reason }
                            : {}),
                        },
                      }
                    : {}),
                },
              });
            } else if (turn.pendingSubagent !== undefined && turn.pendingSubagent.label === block.name) {
              // The dispatch is still running: its buffered tool_call has not
              // flushed, so no record matches — link the block from the parked
              // start, whose time is the real dispatch start.
              blocks.push({
                type: "tool_call",
                call: {
                  id: block.id,
                  name: block.name,
                  args: block.input,
                  childSessionId: turn.pendingSubagent.childSessionId,
                  startedAt: turn.pendingSubagent.startedAt,
                },
              });
            } else {
              blocks.push({
                type: "tool_call",
                call: { id: block.id, name: block.name, args: block.input },
              });
            }
          }
          // Image blocks have no chat representation yet.
        }
        flush();
      } else if (step.partial?.text) {
        blocks.push({ type: "text", text: step.partial.text });
      }

      const content = assistant ? textOf(assistant.content) : (step.partial?.text ?? "");
      messages.push({
        id: `${turn.turn}:${step.step}`,
        role: "assistant",
        blocks,
        content,
        timestamp: step.startedAt,
        ...(step.partial !== undefined ? { isStreaming: true } : {}),
      });
    };

    direct.forEach((input, i) => emitUser(input, `${turn.turn}:u${i}`));

    // Steering slots between steps: each queued input is emitted before the
    // first step that started after it was queued. Ids stay the ordinal among
    // queued inputs, so repositioning never makes them drift.
    const pending = queued.map((input, i) => ({ input, id: `${turn.turn}:q${i}` }));
    for (const step of turn.steps) {
      while (pending[0] && pending[0].input.time < step.startedAt) {
        const next = pending.shift()!;
        emitUser(next.input, next.id);
      }
      emitStep(step);
    }
    for (const leftover of pending) emitUser(leftover.input, leftover.id);

    // 本轮账目属于"这一轮"，不属于某一次模型调用：挂到该轮最后一条
    // assistant 消息上，让 UI 在这轮最终回复下方渲染（spec §3.2）。流式期间
    // 也照样挂——是否显示由渲染器的 isStreaming 门控决定，投影不做展示决策。
    const turnUsage = summariseTurnUsage(turn);
    if (turnUsage !== undefined) {
      for (let i = messages.length - 1; i >= turnStart; i--) {
        const candidate = messages[i]!;
        if (candidate.role !== "assistant") continue;
        messages[i] = { ...candidate, turnUsage };
        break;
      }
    }
  }

  return { messages };
}

// ──────────────────────────────────────────────
// Streaming partial
// ──────────────────────────────────────────────

/**
 * A streaming increment. Never persisted — its only job is to give the UI a
 * typewriter effect between `model_call_start` and `assistant_message`.
 * Losing one is self-healing: the authoritative event replaces the partial
 * wholesale when it lands.
 */
export type TranscriptDelta =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_use"; callId: string; name?: string; argumentsDelta: string };

function emptyPartial(): PartialAssistant {
  return { text: "", reasoning: "", pendingCalls: [] };
}

/**
 * Folds one delta into the open step — the last step of the last turn that
 * has started but not yet produced its `assistant_message`. A no-op when no
 * such step exists, so a delta arriving after the turn closed is harmless.
 *
 * Only the turn and step being written are new objects; every earlier turn
 * keeps its identity so a memoising consumer does not re-render the history.
 */
export function applyPartial(
  records: readonly TurnRecord[],
  delta: TranscriptDelta,
): TurnRecord[] {
  const turnIndex = records.length - 1;
  const turn = records[turnIndex];
  if (!turn || turn.endedAt !== undefined) return records as TurnRecord[];

  const stepIndex = turn.steps.length - 1;
  const step = turn.steps[stepIndex];
  if (!step || step.assistant !== undefined) return records as TurnRecord[];

  const previous = step.partial ?? emptyPartial();
  let partial: PartialAssistant;

  if (delta.kind === "text") {
    partial = { ...previous, text: previous.text + delta.text };
  } else if (delta.kind === "reasoning") {
    partial = { ...previous, reasoning: previous.reasoning + delta.text };
  } else {
    const calls = [...previous.pendingCalls];
    const existing = calls.findIndex((c) => c.callId === delta.callId);
    if (existing >= 0) {
      calls[existing] = {
        ...calls[existing]!,
        argumentsDelta: calls[existing]!.argumentsDelta + delta.argumentsDelta,
        ...(delta.name !== undefined ? { name: delta.name } : {}),
      };
    } else {
      calls.push({ callId: delta.callId, name: delta.name ?? "", argumentsDelta: delta.argumentsDelta });
    }
    partial = { ...previous, pendingCalls: calls };
  }

  const nextSteps = [...turn.steps];
  nextSteps[stepIndex] = { ...step, partial };
  const nextTurns = [...records];
  nextTurns[turnIndex] = { ...turn, steps: nextSteps };
  return nextTurns;
}

// ──────────────────────────────────────────────
// TrajectoryView
// ──────────────────────────────────────────────

export interface TrajectoryRow {
  /** 1-based, rendered as `#N`. */
  index: number;
  /** Stable across incremental rebuilds — never an array index. */
  id: string;
  kind: "user" | "context" | "assistant" | "tool" | "subagent" | "compaction" | "error" | "reminder";
  turn: number;
  step?: number;
  /** Single-line, non-Markdown summary; the UI ellipsises overflow. */
  summary: string;
  startedAt: number;
  durationMs?: number;
  isError?: boolean;
  inputDetail?: string;
  outputDetail?: string;
  thinkingDetail?: string;
  /** The model-visible tool schema as it stood at call time. */
  schemaDetail?: string;
  metrics?: { ttftMs?: number; durationMs: number; usage?: TokenUsage };
  /** Present on a sub-agent row; the child's own session, read separately. */
  childSessionId?: string;
  /** Set only on `kind:"reminder"` rows — which dynamic injection produced this. */
  reminderKind?: ContextReminderKind;
}

export interface TrajectoryView {
  rows: TrajectoryRow[];
}

/** First line, trimmed to `max` characters, for a one-line row summary. */
function summarise(text: string, max = 120): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/**
 * Derives the audit ledger.
 *
 * Takes the raw `events` alongside the records because a few rows are pure
 * log detail that never enters a turn record — `request_header` (the prompt
 * and tool catalogue as sent), `compaction`, and `context_reminder`. Their
 * detail would otherwise have to be duplicated into `TurnRecord`, widening it
 * for one consumer.
 */
export function toTrajectoryView(
  records: readonly TurnRecord[],
  events: readonly TranscriptEvent[],
): TrajectoryView {
  const rows: TrajectoryRow[] = [];

  const headersByHash = new Map<string, TranscriptEventMap["request_header"]>();
  for (const event of events) {
    if (event.type === "request_header") {
      const data = event.data as TranscriptEventMap["request_header"];
      headersByHash.set(data.hash, data);
    }
  }

  const contextEvents = events.filter(
    (e) => e.type === "request_header" || e.type === "compaction" || e.type === "context_reminder",
  );

  // One context row per static-prefix hash. An unchanged prefix riding into
  // later turns (or re-recorded by a resumed Runner) must not repeat the
  // identical row; a genuinely changed prefix hashes differently and still
  // gets its own.
  const seenContextHashes = new Set<string>();

  for (const turn of records) {
    for (const event of contextEvents) {
      if ((event.turn ?? 0) !== turn.turn) continue;
      if (event.type === "request_header") {
        const data = event.data as TranscriptEventMap["request_header"];
        if (seenContextHashes.has(data.hash)) continue;
        seenContextHashes.add(data.hash);
        rows.push({
          index: 0,
          id: `${turn.turn}:header:${event.seq}`,
          kind: "context",
          turn: turn.turn,
          summary: `system prompt (${data.systemLayers.length} layers), ${data.tools.length} tools`,
          startedAt: event.time,
          inputDetail: data.systemLayers
            .map((l) => `<<<layer id="${l.id}" bytes="${new TextEncoder().encode(l.text).length}">>>\n${l.text}`)
            .join("\n\n"),
          schemaDetail: JSON.stringify(data.tools, null, 2),
        });
      } else if (event.type === "compaction") {
        const data = event.data as TranscriptEventMap["compaction"];
        rows.push({
          index: 0,
          id: `${turn.turn}:compaction:${event.seq}`,
          kind: "compaction",
          turn: turn.turn,
          summary: `compacted ${data.replacedCount} messages`,
          startedAt: event.time,
          outputDetail: data.summaryText,
        });
      } else if (event.type === "context_reminder") {
        const data = event.data as TranscriptEventMap["context_reminder"];
        rows.push({
          index: 0,
          id: `${turn.turn}:reminder:${event.seq}`,
          kind: "reminder",
          reminderKind: data.kind,
          turn: turn.turn,
          summary: summarise(data.text),
          startedAt: event.time,
          outputDetail: data.text,
        });
      }
    }

    turn.userInput.forEach((input, i) => {
      const text = textOf(input.content);
      rows.push({
        index: 0,
        id: `${turn.turn}:${input.origin === "queued" ? "q" : "u"}${i}`,
        kind: "user",
        turn: turn.turn,
        summary: summarise(text),
        startedAt: input.time,
        inputDetail: text,
      });
    });

    for (const step of turn.steps) {
      const assistant = step.assistant;
      const header = headersByHash.get(step.headerHash);
      const outputText = assistant ? textOf(assistant.content) : (step.partial?.text ?? "");
      // The authoritative message is the tool-call source of truth here: a
      // batch that died mid-flight can leave tool_call events unflushed while
      // the assistant_message's tool_use blocks are already durable.
      const emittedToolCalls = assistant ? assistant.content.filter((b) => b.type === "tool_use").length : 0;

      rows.push({
        index: 0,
        id: `${turn.turn}:${step.step}`,
        kind: "assistant",
        turn: turn.turn,
        step: step.step,
        // A step whose only payload is tool calls (reasoning models narrate
        // via the reasoning block, not text) still happened — lead with its
        // reasoning, then what it did, instead of the "(no text)" dead end.
        summary:
          summarise(outputText) ||
          (step.error
            ? step.error.message
            : summarise(assistant?.reasoning ?? "") ||
              (emittedToolCalls > 0
                ? emittedToolCalls === 1
                  ? "1 tool call"
                  : `${emittedToolCalls} tool calls`
                : "(no text)")),
        startedAt: step.startedAt,
        ...(assistant !== undefined ? { durationMs: assistant.durationMs } : {}),
        ...(step.error !== undefined ? { isError: true } : {}),
        ...(outputText ? { outputDetail: outputText } : {}),
        ...(assistant?.reasoning !== undefined ? { thinkingDetail: assistant.reasoning } : {}),
        ...(assistant !== undefined
          ? {
              metrics: {
                ...(assistant.ttftMs !== undefined ? { ttftMs: assistant.ttftMs } : {}),
                durationMs: assistant.durationMs,
                ...(assistant.usage !== undefined ? { usage: assistant.usage } : {}),
              },
            }
          : {}),
      });

      for (const call of step.toolCalls) {
        rows.push({
          index: 0,
          id: call.callId,
          kind: call.childSessionId !== undefined ? "subagent" : "tool",
          turn: turn.turn,
          step: step.step,
          summary: `${call.name}(${summarise(JSON.stringify(call.input), 60)})`,
          startedAt: call.startedAt,
          ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
          ...(call.isError !== undefined ? { isError: call.isError } : {}),
          inputDetail: JSON.stringify(call.input, null, 2),
          // A sub-agent row links out rather than inlining: the child is its
          // own session file, and recursing would pull a whole task tree into
          // memory for one row.
          ...(call.childSessionId !== undefined
            ? { childSessionId: call.childSessionId }
            : call.content !== undefined
              ? { outputDetail: toolResultText(call.content) }
              : {}),
          ...(header !== undefined
            ? { schemaDetail: JSON.stringify(header.tools.filter((t) => t.name === call.name), null, 2) }
            : {}),
        });
      }
    }

    if (turn.error !== undefined) {
      rows.push({
        index: 0,
        id: `${turn.turn}:error`,
        kind: "error",
        turn: turn.turn,
        summary: summarise(turn.error),
        startedAt: turn.endedAt ?? turn.startedAt,
        isError: true,
        outputDetail: turn.error,
      });
    }
  }

  rows.sort((a, b) => a.startedAt - b.startedAt);
  return { rows: rows.map((row, i) => ({ ...row, index: i + 1 })) };
}
