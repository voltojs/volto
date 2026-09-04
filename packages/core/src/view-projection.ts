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

import type { ContentBlock } from "./state.js";
import type {
  TokenUsage,
  TranscriptEvent,
  TranscriptEventMap,
  TurnEndReason,
} from "./ports.js";

// ──────────────────────────────────────────────
// Intermediate layer
// ──────────────────────────────────────────────

export interface UserInputRecord {
  /** `queued` means steering — injected while the turn was already running. */
  origin: "direct" | "queued";
  content: string | ContentBlock[];
  time: number;
}

export interface AssistantRecord {
  content: ContentBlock[];
  reasoning?: string;
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
  usage?: TokenUsage;
  ttftMs?: number;
  durationMs: number;
  interrupted?: true;
}

export interface PartialAssistant {
  text: string;
  reasoning: string;
  /** Calls whose arguments are still streaming in. */
  pendingCalls: Array<{ callId: string; name: string; argumentsDelta: string }>;
  firstDeltaAt?: number;
}

export interface ToolCallRecord {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  orderInBatch: number;
  startedAt: number;
  // ── Result half; all absent until the tool reports. ──
  content?: string;
  isError?: boolean;
  durationMs?: number;
  displayMetadata?: Record<string, unknown>;
  approval?: { riskTier: string; decision: "allow" | "deny" };
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
 * `prev` is a pure optimisation: closed turns (those with an `endedAt`) whose
 * shape is unchanged keep their previous object identity, so a React consumer
 * memoising per row re-renders only the turn still in flight. Passing a `prev`
 * from a different session cannot corrupt the result — identity is reused only
 * when the turn number and end time both match.
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

  /** The most recent call still missing a childSessionId — the one that just delegated. */
  const lastUnlinkedCall = (turn: MutableTurn): ToolCallRecord | undefined => {
    for (let i = turn.steps.length - 1; i >= 0; i--) {
      const calls = turn.steps[i]!.toolCalls;
      for (let j = calls.length - 1; j >= 0; j--) {
        if (calls[j]!.childSessionId === undefined) return calls[j];
      }
    }
    return undefined;
  };

  for (const event of events) {
    switch (event.type) {
      case "turn_start": {
        const data = event.data as TranscriptEventMap["turn_start"];
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
        step.assistant = {
          content: data.content,
          ...(data.reasoning !== undefined ? { reasoning: data.reasoning } : {}),
          ...(data.stopReason !== undefined ? { stopReason: data.stopReason } : {}),
          ...(data.usage !== undefined ? { usage: data.usage } : {}),
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
        const step = stepFor(turnFor(event), event.step, event.time);
        if (!step) break;
        step.toolCalls.push({
          callId: data.callId,
          name: data.name,
          input: data.input,
          // Real order arrives with the result; until then keep insertion order.
          orderInBatch: step.toolCalls.length,
          startedAt: event.time,
        });
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
        if (call) call.approval = { riskTier: data.riskTier, decision: "allow" };
        break;
      }

      case "approval_decision": {
        const data = event.data as TranscriptEventMap["approval_decision"];
        const call = findCall(turnFor(event), data.callId);
        if (call && call.approval) call.approval = { ...call.approval, decision: data.decision };
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
        const call = lastUnlinkedCall(turnFor(event));
        if (call) call.childSessionId = data.childSessionId;
        break;
      }

      case "error": {
        const data = event.data as TranscriptEventMap["error"];
        turnFor(event).error = data.message;
        break;
      }

      default:
        // Log-only: session_meta, request_header, context_assembled,
        // compaction, budget_exceeded, subagent_finished. They carry audit
        // detail the trajectory view reads straight off the event list.
        break;
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
  // consumer re-renders only the turn still in flight.
  return turns.map((turn, i) => {
    const before = prev[i];
    if (
      before !== undefined &&
      before.turn === turn.turn &&
      before.endedAt !== undefined &&
      before.endedAt === turn.endedAt
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
}

export type ConversationBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ConversationToolCall }
  | { type: "reasoning"; text: string };

export interface ConversationMessage {
  /** Stable across incremental rebuilds — never an array index. */
  id: string;
  role: "user" | "assistant";
  blocks: ConversationBlock[];
  /** All text segments concatenated, for copy-to-clipboard. */
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

export interface ConversationView {
  messages: ConversationMessage[];
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Derives the chat feed.
 *
 * System scaffolding never appears. A tool result is folded into the
 * assistant block that called it rather than becoming its own entry, so a
 * call renders where it actually happened in the reply.
 *
 * Steering messages land AFTER their step's tool calls, mirroring how the
 * reducer flushes `[...results, ...queuedUserInputs]` — ordering them by
 * event time instead would show the user a history the model never saw.
 */
export function toConversationView(records: readonly TurnRecord[]): ConversationView {
  const messages: ConversationMessage[] = [];

  for (const turn of records) {
    const direct = turn.userInput.filter((u) => u.origin === "direct");
    const queued = turn.userInput.filter((u) => u.origin === "queued");

    direct.forEach((input, i) => {
      const text = textOf(input.content);
      messages.push({
        id: `${turn.turn}:u${i}`,
        role: "user",
        blocks: text ? [{ type: "text", text }] : [],
        content: text,
        timestamp: input.time,
      });
    });

    for (const step of turn.steps) {
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
          } else if (block.type === "tool_use") {
            flush();
            const call = step.toolCalls.find((c) => c.callId === block.id);
            blocks.push({
              type: "tool_call",
              call: {
                id: block.id,
                name: block.name,
                args: block.input,
                ...(call?.content !== undefined ? { result: call.content } : {}),
                ...(call?.isError !== undefined ? { isError: call.isError } : {}),
                ...(call?.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
              },
            });
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
    }

    queued.forEach((input, i) => {
      const text = textOf(input.content);
      messages.push({
        id: `${turn.turn}:q${i}`,
        role: "user",
        blocks: text ? [{ type: "text", text }] : [],
        content: text,
        timestamp: input.time,
      });
    });
  }

  return { messages };
}
