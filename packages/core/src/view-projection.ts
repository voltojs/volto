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
import { extractFileChange } from "./file-change.js";
import type { FileChange } from "./file-change.js";
import type {
  ApprovalDenialReason,
  TokenUsage,
  ContextReminderKind,
  TranscriptEvent,
  TranscriptEventMap,
  TurnEndReason,
  UserMessageSource,
  VerificationSummary,
} from "./ports.js";
import { extractBlockText } from "./text-extract.js";
import { totalUsageTokens } from "./pricing.js";
// D12 termination pairing — same wording source as transcript-projection.ts,
// so every projection renders byte-identical interruption text.
import { interruptionMessageFor } from "./reducer.js";

// ──────────────────────────────────────────────
// Intermediate layer
// ──────────────────────────────────────────────

export interface UserInputRecord {
  /** `queued` means steering — injected while the turn was already running. */
  origin: "direct" | "queued";
  content: string | ContentBlock[];
  time: number;
  /** Non-human provenance; absent for a plain human message. */
  source?: UserMessageSource;
  /**
   * Realization anchor (Task 6): set when a `steering_delivered` event
   * realized this queued input in its own turn — the input renders
   * immediately before the step with this number, i.e. the model call its
   * drain fed. Absent means no delivery event ever named it: the legacy
   * rules apply (the time heuristic in `toConversationView`, or turn start
   * for direct inputs).
   */
  deliveredBeforeStep?: number;
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
  /** Aggregate cache-reporting status; absent for old transcripts. */
  cacheReporting?: "reported" | "not-reported" | "unsupported";
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
  /**
   * Dispatch-supplied task title (`task` tool's `title`). Absent on sessions
   * recorded before the field existed — consumers fall back to deriving one
   * from `args.message`.
   */
  subagentTitle?: string;
  /** Tools the definition / allowlist named that the child could not get. */
  subagentDroppedTools?: string[];
  /** Capabilities the definition named that the parent does not grant. */
  subagentDroppedCapabilities?: string[];
  /** Permission axes narrowed below what the definition asked for (F-023). */
  subagentDowngrades?: Array<{ field: string; requested: string; effective: string }>;
  /** Pre-minted dispatch identity, shared with the subagent_started/finished bracket. */
  taskId?: string;
  /** True when this dispatch ran detached. */
  background?: true;
  /** Acceptance verdict for a verified dispatch; absent on old logs and unverified dispatches. */
  verification?: VerificationSummary;
  /** Subagent type recorded by the start bracket, when it named one. */
  subagentType?: string;
  /** Child session a collected result points at (task_output), without upgrading this row. */
  relatedSessionId?: string;
  /** A routing tier that could not resolve and fell back to the parent model. */
  subagentModelTierUnresolved?: {
    tierId: string;
    target?: { providerId: string; modelId: string };
  };
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
  pendingSubagent?: {
    label: string;
    childSessionId: string;
    startedAt: number;
    /** Dispatch-supplied title, when the session records one. */
    title?: string;
  };
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
 * Pure: read an acceptance verdict out of untrusted persisted metadata (a
 * tool result's displayMetadata or a finish bracket). Anything malformed
 * yields undefined — old logs and truncated payloads project no field
 * rather than half a verdict.
 */
function asVerificationSummary(value: unknown): VerificationSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw["status"];
  const attempts = raw["attempts"];
  const failures = raw["failures"];
  if (status !== "passed" && status !== "failed" && status !== "error") return undefined;
  if (typeof attempts !== "number") return undefined;
  if (!Array.isArray(failures)) return undefined;
  const reasons: string[] = [];
  for (const entry of failures) {
    if (typeof entry !== "string") return undefined;
    reasons.push(entry);
  }
  const verifierError = raw["verifierError"];
  return {
    status,
    attempts,
    failures: reasons,
    ...(typeof verifierError === "string" ? { verifierError } : {}),
  };
}

/**
 * Watermark count: calls carrying a verdict. A late `subagent_finished`
 * stamps one onto a closed turn without changing any length, so identity
 * reuse must compare this too. Computed on demand — no TurnRecord field.
 */
function verifiedCallCount(turn: TurnRecord): number {
  let count = 0;
  for (const step of turn.steps) {
    for (const call of step.toolCalls) {
      if (call.verification !== undefined) count += 1;
    }
  }
  return count;
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
 * agrees: same user-input count, same step count, same tool-call count on
 * the last step, and same verified-call count (a late subagent_finished
 * verdict stamps a closed turn's call without changing any length). A log
 * extended after the turn closed (e.g. a pre-fix resume
 * appending past a paused turn's bracket) keeps its end time but fails the
 * watermark, so it is rebuilt instead of served stale from `prev`.
 */
export function buildTurnRecords(
  events: readonly TranscriptEvent[],
  prev?: readonly TurnRecord[],
): TurnRecord[] {
  const turns: MutableTurn[] = [];
  let current: MutableTurn | undefined;

  /**
   * Queued steering inputs by id (FIFO per id), pending realization
   * (Task 6). Ids are stamped unique in production; a legacy log can carry
   * several unstamped entries under `""`, so each id maps to a FIFO list —
   * the first entry is the reducer's findIndex match.
   */
  const queuedInputs = new Map<string, Array<{ record: UserInputRecord; turn: MutableTurn }>>();
  /**
   * Records realized by a `steering_delivered` in their own turn, waiting
   * for the model call their drain fed — the next step created in that turn
   * anchors them (every drain re-issues call_model).
   */
  const pendingDeliveryAnchors = new Map<number, UserInputRecord[]>();
  /**
   * Per-turn opening bookkeeping for cross-turn realizations: the record the
   * turn's `user_message` opened with, and the last entry moved into that
   * opening (FIFO stacking ahead of it).
   */
  const turnOpenings = new Map<number, { userMessage?: UserInputRecord; lastMoved?: UserInputRecord }>();

  const registerQueuedInput = (id: string, record: UserInputRecord, turn: MutableTurn): void => {
    const list = queuedInputs.get(id);
    const item = { record, turn };
    if (list) list.push(item);
    else queuedInputs.set(id, [item]);
  };
  const firstQueuedInput = (id: string): { record: UserInputRecord; turn: MutableTurn } | undefined =>
    queuedInputs.get(id)?.[0];
  const claimQueuedInput = (id: string): { record: UserInputRecord; turn: MutableTurn } | undefined => {
    const list = queuedInputs.get(id);
    const item = list?.shift();
    if (list !== undefined && list.length === 0) queuedInputs.delete(id);
    return item;
  };

  /** Anchors every pending realized input on the step their drain fed. */
  const resolveDeliveryAnchors = (turn: MutableTurn, stepNo: number): void => {
    const pending = pendingDeliveryAnchors.get(turn.turn);
    if (!pending || pending.length === 0) return;
    for (const record of pending) record.deliveredBeforeStep = stepNo;
    pendingDeliveryAnchors.delete(turn.turn);
  };

  /** The step an event belongs to, created on demand for out-of-order logs. */
  const stepFor = (turn: MutableTurn, step: number | undefined, time: number): MutableStep | undefined => {
    if (step === undefined) return undefined;
    let found = turn.steps.find((s) => s.step === step);
    if (!found) {
      found = newStep(step, time, "");
      turn.steps.push(found);
      resolveDeliveryAnchors(turn, step);
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
   * Find the dispatch call whose recorded result names this taskId. Only a
   * `task` call may be upgraded: a `task_output` result carries the same
   * taskId but is a collection row, not a delegation.
   */
  const findCallByTaskId = (turn: MutableTurn, taskId: string): ToolCallRecord | undefined => {
    for (const step of turn.steps) {
      for (const call of step.toolCalls) {
        if (call.name === "task" && call.displayMetadata?.["taskId"] === taskId) return call;
      }
    }
    return undefined;
  };

  /** The most recent unlinked `task` call; used only when an errored result
   *  has no taskId metadata to join on. */
  const lastUnlinkedTaskCall = (turn: MutableTurn): ToolCallRecord | undefined =>
    lastUnlinkedCall(turn, "task") ?? undefined;

  /**
   * The first *running* `task` call in log order (no result yet). A finished
   * call is never eligible: giving a new start to an old failed dispatch makes
   * the card point at the wrong child. A later tool_result carrying the same
   * taskId is still the authoritative join and corrects a provisional claim.
   */
  const firstRunningTaskCall = (turn: MutableTurn): ToolCallRecord | undefined => {
    for (const step of turn.steps) {
      for (const call of step.toolCalls) {
        if (
          call.name === "task"
          && call.childSessionId === undefined
          && call.content === undefined
        ) {
          return call;
        }
      }
    }
    return undefined;
  };

  /** Copy one start bracket's identity onto its call. */
  const applyStart = (
    call: ToolCallRecord,
    data: TranscriptEventMap["subagent_started"],
  ): void => {
    call.childSessionId = data.childSessionId;
    if (data.title !== undefined) call.subagentTitle = data.title;
    if (data.taskId !== undefined) call.taskId = data.taskId;
    if (data.background === true) call.background = true;
    if (data.subagentType !== undefined) call.subagentType = data.subagentType;
  };

  /** Drop a provisional start link that a later taskId join proved wrong. */
  const clearStart = (call: ToolCallRecord): void => {
    delete call.childSessionId;
    delete call.taskId;
    delete call.background;
    delete call.subagentType;
    delete call.subagentTitle;
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
  /**
   * New dispatches keyed by their pre-minted taskId. Unlike the legacy
   * per-turn slot above, this map keeps parallel fan-out distinct: the
   * matching tool_result carries the same taskId in displayMetadata, so the
   * pairing never depends on event order or a label that differs from the
   * tool name.
   */
  const pendingStartsByTaskId = new Map<string, TranscriptEvent<"subagent_started">>();
  /** Every start bracket, including one already shown live on a call. */
  const startedByTaskId = new Map<string, TranscriptEvent<"subagent_started">>();
  /** Dispatches that already emitted their finish bracket. */
  const finishedTaskIds = new Set<string>();
  /** Unresolved model tiers, keyed by child session and applied after linking. */
  const tierByChild = new Map<
    string,
    { tierId: string; target?: { providerId: string; modelId: string } }
  >();
  // Dispatch disclosures, keyed by the child session they belong to. They are
  // collected here and applied in a second pass because their ordering in the
  // log relative to the tool_call they describe is not guaranteed (the SDK
  // writes the start bracket while the runner buffers tool_call events).
  const dropsByChild = new Map<
    string,
    { tools: string[]; capabilities: string[] }
  >();
  const downgradesByChild = new Map<
    string,
    Array<{ field: string; requested: string; effective: string }>
  >();

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
        // D12 termination pairing (the mirror transcript-projection.ts does
        // on turn_end): a turn killed with results still missing (Stop,
        // safety limit) synthesizes the interrupted placeholder for every
        // unresolved call — otherwise the conversation view spins forever.
        // Same tier rule and wording source as the reducer's synthesis; a
        // turn that ended with results in place finds nothing to touch.
        const tier = data.reason === "cancelled" ? "cancel" : "limit";
        for (const step of turn.steps) {
          for (const call of step.toolCalls) {
            if (call.content !== undefined) continue;
            call.content = interruptionMessageFor(call.name, tier);
            call.isError = true;
          }
        }
        break;
      }

      case "user_message": {
        const data = event.data as TranscriptEventMap["user_message"];
        const turn = turnFor(event);
        const record: UserInputRecord = {
          origin: "direct",
          content: data.content,
          time: event.time,
          ...(data.source === undefined ? {} : { source: data.source }),
        };
        turn.userInput.push(record);
        const opening = turnOpenings.get(turn.turn) ?? {};
        opening.userMessage = record;
        turnOpenings.set(turn.turn, opening);
        break;
      }

      case "steering_queued": {
        const data = event.data as TranscriptEventMap["steering_queued"];
        const turn = turnFor(event);
        const record: UserInputRecord = { origin: "queued", content: data.content, time: event.time };
        turn.userInput.push(record);
        // Legacy events carry no id: they have no realization signal and
        // keep the pre-feature placement rules.
        const id: unknown = (data as { id?: unknown }).id;
        if (typeof id === "string") registerQueuedInput(id, record, turn);
        break;
      }

      case "steering_edited": {
        const data = event.data as TranscriptEventMap["steering_edited"];
        // Same id, same position, new content — mirrors the reducer's
        // in-place queue edit. Delivery wins: an id no longer queued is a
        // no-op.
        const target = firstQueuedInput(data.id);
        if (target) target.record.content = data.content;
        break;
      }

      case "steering_removed": {
        const data = event.data as TranscriptEventMap["steering_removed"];
        // Hard delete — no residue anywhere: the record leaves its turn's
        // userInput entirely.
        const target = claimQueuedInput(data.id);
        if (target) {
          const at = target.turn.userInput.indexOf(target.record);
          if (at >= 0) target.turn.userInput.splice(at, 1);
        }
        break;
      }

      case "steering_delivered": {
        const data = event.data as TranscriptEventMap["steering_delivered"];
        const delivering = turnFor(event);
        for (const id of data.ids) {
          const target = claimQueuedInput(id);
          if (!target) continue;
          if (target.turn === delivering) {
            // Realized in its own turn: it renders at the delivery point —
            // immediately before the model call its drain fed.
            const pending = pendingDeliveryAnchors.get(delivering.turn) ?? [];
            pending.push(target.record);
            pendingDeliveryAnchors.set(delivering.turn, pending);
            continue;
          }
          // Cross-turn realization: removed from its own turn and dropped
          // into the delivering turn's OPENING — ahead of that turn's
          // user_message record — as a direct input. The reducer renders
          // [...olderQueue, newUserMsg] even though the durable log records
          // the opening input first (D11b), and a steering_flush turn opens
          // with no user_message at all (D11).
          const at = target.turn.userInput.indexOf(target.record);
          if (at >= 0) target.turn.userInput.splice(at, 1);
          target.record.origin = "direct";
          const opening = turnOpenings.get(delivering.turn) ?? {};
          let insertAt = 0;
          if (opening.lastMoved !== undefined) {
            const idx = delivering.userInput.indexOf(opening.lastMoved);
            insertAt = idx === -1 ? 0 : idx + 1;
          } else if (opening.userMessage !== undefined) {
            const idx = delivering.userInput.indexOf(opening.userMessage);
            insertAt = idx === -1 ? 0 : idx;
          }
          delivering.userInput.splice(insertAt, 0, target.record);
          opening.lastMoved = target.record;
          turnOpenings.set(delivering.turn, opening);
        }
        break;
      }

      case "model_call_start": {
        const data = event.data as TranscriptEventMap["model_call_start"];
        const turn = turnFor(event);
        const step = newStep(event.step ?? turn.steps.length + 1, event.time, data.headerHash);
        turn.steps.push(step);
        resolveDeliveryAnchors(turn, step.step);
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
          applyStart(call, pending.data);
          pendingSubagents.delete(turn.turn);
        }
        // A start parked before its call flushed: with a single candidate the
        // pairing is unambiguous, so show it live instead of waiting for the
        // result. Parallel fan-out leaves multiple candidates for the result
        // join to resolve deterministically.
        if (data.name === "task" && call.childSessionId === undefined && pendingStartsByTaskId.size === 1) {
          const [taskId, start] = pendingStartsByTaskId.entries().next().value!;
          applyStart(call, start.data);
          pendingStartsByTaskId.delete(taskId);
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
        if (data.displayMetadata !== undefined) {
          call.displayMetadata = data.displayMetadata;
          const taskId = data.displayMetadata["taskId"];
          if (typeof taskId === "string") {
            call.taskId = taskId;
            // Only a dispatch call owns the start bracket. A task_output
            // result carries the same taskId, but is a collection row.
            const start = call.name === "task"
              ? startedByTaskId.get(taskId) ?? pendingStartsByTaskId.get(taskId)
              : undefined;
            if (start !== undefined) {
              // The result is authoritative: if a live claim had attached this
              // task's child to a different call, drop that provisional link
              // and let that call's own result re-link it.
              for (const otherStep of turn.steps) {
                for (const other of otherStep.toolCalls) {
                  if (other.callId !== call.callId && other.childSessionId === start.data.childSessionId) {
                    clearStart(other);
                  }
                }
              }
              applyStart(call, start.data);
              pendingStartsByTaskId.delete(taskId);
            }
          }
          const related = data.displayMetadata["relatedSessionId"];
          if (typeof related === "string") call.relatedSessionId = related;
          // A sync dispatch's verdict rides its result envelope's metadata.
          const verification = asVerificationSummary(data.displayMetadata["verification"]);
          if (verification !== undefined) call.verification = verification;
        }
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

      case "subagent_tools_dropped": {
        const data = event.data as TranscriptEventMap["subagent_tools_dropped"];
        if (data.childSessionId !== undefined) {
          const prev = dropsByChild.get(data.childSessionId);
          dropsByChild.set(data.childSessionId, {
            tools: [...(prev?.tools ?? []), ...data.droppedTools],
            capabilities: [...(prev?.capabilities ?? []), ...data.droppedCapabilities],
          });
        }
        break;
      }

      case "subagent_permission_downgraded": {
        const data = event.data as TranscriptEventMap["subagent_permission_downgraded"];
        if (data.childSessionId !== undefined) {
          const prev = downgradesByChild.get(data.childSessionId) ?? [];
          downgradesByChild.set(data.childSessionId, [...prev, ...data.downgrades]);
        }
        break;
      }

      case "subagent_finished": {
        const data = event.data as TranscriptEventMap["subagent_finished"];
        if (data.taskId !== undefined) {
          finishedTaskIds.add(data.taskId);
          const pending = startedByTaskId.get(data.taskId);
          if (pending !== undefined) {
            const turn = turnFor(event);
            // Success results normally consumed the start already; this path exists
            // for an errored result, whose task tool result carries no
            // displayMetadata. Close the start on the call if it is on disk now.
            const call = findCallByTaskId(turn, data.taskId)
              ?? turn.steps.flatMap((step) => step.toolCalls)
                .find((candidate) => candidate.childSessionId === pending.data.childSessionId)
              ?? lastUnlinkedTaskCall(turn);
            if (call !== undefined) {
              applyStart(call, pending.data);
              pendingStartsByTaskId.delete(data.taskId);
            }
          }
        }
        // A background dispatch's verdict arrives after its turn closed.
        // Stamp it onto the owning turn's dispatch call — taskId join first,
        // childSessionId fallback. A truncated log with no linkable call is
        // silently ignored; the lookup never opens a turn shell.
        const verdict = asVerificationSummary(data.verification);
        if (verdict !== undefined) {
          const turn = turns.find((candidate) => candidate.turn === (event.turn ?? 0));
          if (turn !== undefined) {
            const call =
              (data.taskId !== undefined ? findCallByTaskId(turn, data.taskId) : undefined)
              ?? turn.steps.flatMap((step) => step.toolCalls)
                .find((candidate) => candidate.name === "task" && candidate.childSessionId === data.childSessionId);
            if (call !== undefined) {
              call.verification = verdict;
              if (data.isError === true) call.isError = true;
              if (typeof data.durationMs === "number") call.durationMs = data.durationMs;
            }
          }
        }
        break;
      }

      case "subagent_started": {
        const data = event.data as TranscriptEventMap["subagent_started"];
        const turn = turnFor(event);
        if (data.taskId !== undefined) {
          startedByTaskId.set(data.taskId, event as TranscriptEvent<"subagent_started">);
          // Deterministic path: a result that already landed names the call;
          // otherwise a live claim keeps the running card visible, and the
          // first unclaimed task call in log order is the dispatch it belongs
          // to. A later tool_result with this taskId remains authoritative.
          const call = findCallByTaskId(turn, data.taskId);
          if (call !== undefined) {
            applyStart(call, data);
          } else {
            const live = firstRunningTaskCall(turn);
            if (live !== undefined) applyStart(live, data);
            else pendingStartsByTaskId.set(data.taskId, event as TranscriptEvent<"subagent_started">);
          }
          break;
        }
        // Legacy path (log written before taskId): prefer the unlinked call
        // this label names; fall back to the most recent unlinked call; with
        // nothing linkable, park it until the call arrives.
        const call = lastUnlinkedCall(turn, data.label) ?? lastUnlinkedCall(turn);
        if (call) {
          applyStart(call, data);
          pendingSubagents.delete(turn.turn);
        } else {
          // The whole event is parked, not just its data: the dispatch start
          // time the surfaced `pendingSubagent` needs lives on the envelope.
          pendingSubagents.set(turn.turn, event as TranscriptEvent<"subagent_started">);
        }
        break;
      }

      case "subagent_model_tier_unresolved": {
        const data = event.data as TranscriptEventMap["subagent_model_tier_unresolved"];
        if (data.childSessionId !== undefined) {
          tierByChild.set(data.childSessionId, {
            tierId: data.tierId,
            ...(data.target !== undefined ? { target: data.target } : {}),
          });
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
        // context_reminder, budget_exceeded.
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
        ...(pending.data.title !== undefined ? { title: pending.data.title } : {}),
      };
    }
  }

  // A taskId start still parked at the end is either waiting for its result
  // (the call exists already) or a dispatch whose call never flushed. Claim
  // the former; surface the latter as the turn's in-flight subagent.
  for (const [taskId, pending] of pendingStartsByTaskId) {
    const turn = turns.find((candidate) => candidate.turn === (pending.turn ?? 0));
    if (turn === undefined) continue;
    const call = findCallByTaskId(turn, taskId)
      ?? (finishedTaskIds.has(taskId) ? lastUnlinkedTaskCall(turn) : undefined);
    if (call !== undefined) {
      applyStart(call, pending.data);
      continue;
    }
    turn.pendingSubagent = {
      label: pending.data.label,
      childSessionId: pending.data.childSessionId,
      startedAt: pending.time,
      ...(pending.data.title !== undefined ? { title: pending.data.title } : {}),
    };
  }

  for (const turn of turns) {
    for (const step of turn.steps) {
      for (const call of step.toolCalls) {
        if (call.childSessionId === undefined) continue;
        const tier = tierByChild.get(call.childSessionId);
        if (tier !== undefined) call.subagentModelTierUnresolved = tier;
      }
    }
  }

  for (const turn of turns) {
    turn.steps.sort((a, b) => a.step - b.step);
    for (const step of turn.steps) {
      step.toolCalls.sort((a, b) => a.orderInBatch - b.orderInBatch);
    }
  }

  // Apply the dispatch disclosures now that every call carries its child
  // session link. A call keeps the arrays empty-free: absent means "nothing
  // was dropped", which is different from an empty list nobody should render.
  if (dropsByChild.size > 0 || downgradesByChild.size > 0) {
    for (const turn of turns) {
      for (const step of turn.steps) {
        for (const call of step.toolCalls) {
          const childId = call.childSessionId;
          if (childId === undefined) continue;
          const drops = dropsByChild.get(childId);
          if (drops !== undefined) {
            if (drops.tools.length > 0) call.subagentDroppedTools = drops.tools;
            if (drops.capabilities.length > 0) call.subagentDroppedCapabilities = drops.capabilities;
          }
          const downgrades = downgradesByChild.get(childId);
          if (downgrades !== undefined) call.subagentDowngrades = downgrades;
        }
      }
    }
  }

  if (!prev) return turns;

  // Reuse identity for closed turns whose shape is unchanged, so a memoising
  // consumer re-renders only the turn still in flight. Turn number, end time
  // and the structural watermark below must all agree: events appended after
  // a turn_end (a pre-fix resume-shaped log) keep the same end time but grow
  // one of these lengths, and lengths are cheap to compare while content is
  // not. A late subagent_finished verdict is the one in-place growth a closed
  // turn legitimately sees — it changes no length, so the verified-call count
  // joins the watermark. Other same-length content growth (e.g. a tool_result
  // filling a call without adding a step) stays undetected — unreachable from
  // current write-side shapes (post-pause turns keep endedAt undefined) and
  // acceptable as defense-in-depth.
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
        turn.steps[turn.steps.length - 1]?.toolCalls.length &&
      verifiedCallCount(before) === verifiedCallCount(turn)
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
  /**
   * The edit this call made, when it wrote one file. Captured by the tool into
   * `displayMetadata.fileChange` and persisted with the `tool_result` event, so
   * the diff is exact per edit and survives reloads and replays.
   */
  fileChange?: FileChange;
  /** Set when this call delegated to a sub-agent; points at its own session. */
  childSessionId?: string;
  /** Dispatch-supplied task title, when the session records one. */
  subagentTitle?: string;
  /** Tools the dispatch named that the child could not get. */
  subagentDroppedTools?: string[];
  /** Permission axes narrowed below what the definition asked for. */
  subagentDowngrades?: Array<{ field: string; requested: string; effective: string }>;
  /** Acceptance verdict for a verified dispatch; absent on old logs and unverified dispatches. */
  verification?: VerificationSummary;
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

/**
 * A chat-feed rendering unit: the model's answer, or the activity that
 * produced it.
 *
 * Purely derived from `ConversationBlock[]` — the ordered block sequence
 * stays the source of truth (a tool call lands where it actually happened,
 * per the view-projection consolidation spec §3.1). This only decides which
 * visual layer each block belongs to, so a UI can separate "what the model
 * said" from "what it ran" without inventing a second durable shape.
 */
export type ConversationSegment =
  | { kind: "answer"; blocks: Array<Extract<ConversationBlock, { type: "text" | "image" }>> }
  | {
      kind: "activity";
      blocks: Array<Extract<ConversationBlock, { type: "reasoning" | "tool_call" }>>;
    };

function segmentKindOf(block: ConversationBlock): ConversationSegment["kind"] {
  return block.type === "text" || block.type === "image" ? "answer" : "activity";
}

/**
 * Groups blocks into adjacent same-kind segments, preserving order.
 *
 * Consecutive activity blocks coalesce; an answer block closes the current
 * activity segment, and vice versa. Never reorders: an answer that resumed
 * after a tool call stays after it.
 */
export function groupConversationBlocks(
  blocks: readonly ConversationBlock[],
): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  for (const block of blocks) {
    const kind = segmentKindOf(block);
    const current = segments[segments.length - 1];
    if (current !== undefined && current.kind === kind) {
      (current.blocks as ConversationBlock[]).push(block);
      continue;
    }
    if (kind === "answer") {
      segments.push({ kind: "answer", blocks: [block as Extract<ConversationBlock, { type: "text" | "image" }>] });
    } else {
      segments.push({
        kind: "activity",
        blocks: [block as Extract<ConversationBlock, { type: "reasoning" | "tool_call" }>],
      });
    }
  }
  return segments;
}

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
 * The optional `fileChange` slice of a conversation tool call. Kept as a
 * spreadable object so the call stays structurally identical for every tool
 * that did not write a file, and so the (large) diff text is only attached
 * when the tool actually reported a change.
 */
function fileChangeFields(displayMetadata: Record<string, unknown> | undefined): {
  fileChange?: FileChange;
} {
  const change = extractFileChange(displayMetadata);
  return change === null ? {} : { fileChange: change };
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
  let cacheReporting: "reported" | "not-reported" | "unsupported" | undefined;
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
    cacheReporting = mergeCacheReporting(cacheReporting, usage.cacheReporting);
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
    cacheReporting = mergeCacheReporting(cacheReporting, compactionUsage.cacheReporting);
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
    ...(cacheReporting !== undefined ? { cacheReporting } : {}),
  };
}

/** Worst state wins: unsupported > not-reported > reported. */
function mergeCacheReporting(
  current: "reported" | "not-reported" | "unsupported" | undefined,
  next: "reported" | "not-reported" | "unsupported" | undefined,
): "reported" | "not-reported" | "unsupported" | undefined {
  if (next === undefined) return current;
  if (current === undefined) return next;
  const rank = { reported: 0, "not-reported": 1, unsupported: 2 } as const;
  return rank[next] > rank[current] ? next : current;
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
 * A queued (steering) input named by a `steering_delivered` event renders at
 * its delivery point — immediately before the model call its drain fed (the
 * reducer drains the queue after a batch's results and before the next model
 * call, `[...results, ...queuedUserInputs]`, so that is where the model
 * actually saw it). An input no delivery event ever named — a legacy log, or
 * a turn that ended before the queue drained — falls back to the structural
 * rule: before the first step whose `startedAt` is greater than the input's
 * `time`, or, with no such step (the turn ended before the queue drained),
 * at the end of the turn. Ordering by raw event time instead would show the
 * user a history the model never saw.
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
                  ...fileChangeFields(call?.displayMetadata),
                  ...(call?.childSessionId !== undefined ? { childSessionId: call.childSessionId } : {}),
                  ...(call?.subagentTitle !== undefined ? { subagentTitle: call.subagentTitle } : {}),
                  ...(call?.subagentDroppedTools !== undefined
                    ? { subagentDroppedTools: call.subagentDroppedTools }
                    : {}),
                  ...(call?.subagentDowngrades !== undefined
                    ? { subagentDowngrades: call.subagentDowngrades }
                    : {}),
                  ...(call?.verification !== undefined ? { verification: call.verification } : {}),
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
                  ...(turn.pendingSubagent.title !== undefined
                    ? { subagentTitle: turn.pendingSubagent.title }
                    : {}),
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

    // Steering slots between steps. A realized (delivered) input renders at
    // its delivery point — immediately before the step its drain fed — while
    // an input no steering_delivered ever named keeps the legacy rule: before
    // the first step that started after it was queued. Ids stay the ordinal
    // among queued inputs, so repositioning never makes them drift.
    const pending = queued.map((input, i) => ({ input, id: `${turn.turn}:q${i}` }));
    const emitPending = (keep: (input: UserInputRecord) => boolean): void => {
      for (let i = 0; i < pending.length; ) {
        const next = pending[i]!;
        if (keep(next.input)) {
          pending.splice(i, 1);
          emitUser(next.input, next.id);
        } else {
          i += 1;
        }
      }
    };
    for (const step of turn.steps) {
      emitPending((input) => input.deliveredBeforeStep === step.step);
      emitPending((input) => input.deliveredBeforeStep === undefined && input.time < step.startedAt);
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
  /** A sub-agent row's child session, or a background reminder's linked child. */
  childSessionId?: string;
  /** Dispatch-supplied task title, when the session records one. */
  subagentTitle?: string;
  /** `subagent_type` the dispatch named, when it named one. */
  subagentType?: string;
  /** Tools the dispatch named that the child could not get. */
  subagentDroppedTools?: string[];
  /** Capabilities the dispatch named that the parent does not grant. */
  subagentDroppedCapabilities?: string[];
  /** Permission axes narrowed below what the definition asked for. */
  subagentDowngrades?: Array<{ field: string; requested: string; effective: string }>;
  /** Set only on `kind:"reminder"` rows — which dynamic injection produced this. */
  reminderKind?: ContextReminderKind;
  /** Non-human provenance on a user row (parent dispatch / host continuation). */
  messageSource?: UserMessageSource;
  /** Dispatch identity on a subagent or background-reminder row. */
  taskId?: string;
  /** True when the subagent row ran detached. */
  background?: true;
  /** Collected child session on a tool row (task_output), without upgrading its kind. */
  relatedSessionId?: string;
  /** A routing tier that could not resolve for this dispatch. */
  subagentModelTierUnresolved?: {
    tierId: string;
    target?: { providerId: string; modelId: string };
  };
}

/** One-line trajectory summary for a delegation: its title, else its type. */
function delegationSummary(call: ToolCallRecord): string {
  if (call.subagentTitle !== undefined && call.subagentTitle !== "") {
    return summarise(call.subagentTitle, 120);
  }
  const declared = call.input["title"];
  if (typeof declared === "string" && declared !== "") return summarise(declared, 120);
  const type = call.input["subagent_type"];
  if (typeof type === "string" && type !== "") return type;
  const message = call.input["message"];
  if (typeof message === "string") return summarise(message.split("\n")[0] ?? "", 120);
  return "task";
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
          ...(typeof data.displayMetadata?.["taskId"] === "string"
            ? { taskId: data.displayMetadata["taskId"] }
            : {}),
          ...(typeof data.displayMetadata?.["childSessionId"] === "string"
            ? { childSessionId: data.displayMetadata["childSessionId"] }
            : {}),
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
        ...(input.source === undefined ? {} : { messageSource: input.source }),
        ...(input.source?.kind === "subagent-task" ? { taskId: input.source.taskId } : {}),
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
          // A delegation reads as its task, not as a JSON blob: the row is a
          // whole job, and the full args stay available in `inputDetail`.
          summary:
            call.childSessionId !== undefined
              ? delegationSummary(call)
              : `${call.name}(${summarise(JSON.stringify(call.input), 60)})`,
          startedAt: call.startedAt,
          ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
          ...(call.isError !== undefined ? { isError: call.isError } : {}),
          inputDetail: JSON.stringify(call.input, null, 2),
          // A sub-agent row links out rather than inlining: the child is its
          // own session file, and recursing would pull a whole task tree into
          // memory for one row.
          ...(call.childSessionId !== undefined
            ? {
                childSessionId: call.childSessionId,
                ...(call.subagentTitle !== undefined
                  ? { subagentTitle: call.subagentTitle }
                  : {}),
                ...(call.subagentType !== undefined
                  ? { subagentType: call.subagentType }
                  : typeof call.input["subagent_type"] === "string"
                    ? { subagentType: call.input["subagent_type"] }
                    : {}),
                ...(call.taskId !== undefined ? { taskId: call.taskId } : {}),
                ...(call.background === true ? { background: true as const } : {}),
                ...(call.subagentDroppedTools !== undefined
                  ? { subagentDroppedTools: call.subagentDroppedTools }
                  : {}),
                ...(call.subagentDroppedCapabilities !== undefined
                  ? { subagentDroppedCapabilities: call.subagentDroppedCapabilities }
                  : {}),
                ...(call.subagentDowngrades !== undefined
                  ? { subagentDowngrades: call.subagentDowngrades }
                  : {}),
                ...(call.subagentModelTierUnresolved !== undefined
                  ? { subagentModelTierUnresolved: call.subagentModelTierUnresolved }
                  : {}),
              }
            : {
                ...(call.content !== undefined ? { outputDetail: toolResultText(call.content) } : {}),
                ...(call.relatedSessionId !== undefined
                  ? { relatedSessionId: call.relatedSessionId }
                  : {}),
                ...(call.taskId !== undefined ? { taskId: call.taskId } : {}),
              }),
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

  // A failed background task's completion notice has no childSessionId: the
  // registry normalizes the rejection before the child outcome is available,
  // but both events share taskId. Backfill from the dispatch row so the
  // failure is still navigable.
  for (const row of rows) {
    if (row.kind !== "reminder" || row.childSessionId !== undefined || row.taskId === undefined) {
      continue;
    }
    const dispatch = rows.find(
      (candidate) =>
        candidate.kind === "subagent"
        && candidate.taskId === row.taskId
        && candidate.childSessionId !== undefined,
    );
    if (dispatch?.childSessionId !== undefined) row.childSessionId = dispatch.childSessionId;
  }

  rows.sort((a, b) => a.startedAt - b.startedAt);
  return { rows: rows.map((row, i) => ({ ...row, index: i + 1 })) };
}
