import type {
  ApprovalDenialReason,
  TranscriptEventInput,
  TranscriptEventMap,
} from '@volto/core';
import type { CommandRiskKind } from '@volto/sdk/sse';
import { isMatchableCommandToken, tokenizeCommand } from '@volto/sdk/sse';

/**
 * User-facing wording for a settled denial, keyed by the reason the gate
 * recorded. `connection-lost` is the one denial the user did not make —
 * saying so, and saying it can be retried, is the whole point of carrying
 * the reason.
 */
export function denialNoteKeyFor(reason?: ApprovalDenialReason): string {
  return reason === 'connection-lost'
    ? 'approvals.denial.connectionLost'
    : reason === 'interrupted'
      ? 'approvals.denial.interrupted'
      : 'approvals.denial.denied';
}

/**
 * User-facing wording for a recognised command risk.
 *
 * The classifier lives in core and stays language-neutral, returning stable
 * kinds; this module returns catalog keys, the same split `denialNoteKeyFor` uses.
 *
 * This is an explanation, not a warning gate: the command is already shown in
 * full above it, and nothing here changes what the buttons do.
 */
export function riskNoteKeyFor(kind: CommandRiskKind): string {
  switch (kind) {
    case 'irreversible-push':
      return 'approvals.risk.irreversiblePush';
    case 'recursive-delete':
      return 'approvals.risk.recursiveDelete';
    case 'remote-script-execution':
      return 'approvals.risk.remoteScriptExecution';
    case 'public-publish':
      return 'approvals.risk.publicPublish';
    case 'discards-uncommitted':
      return 'approvals.risk.discardsUncommitted';
  }
}

/** One choice of an ask_user prompt (mirrors the ask tool's schema). */
export interface AskUserOption {
  label: string;
  description?: string;
}

/**
 * Payload of the ask tool's `ask_user` effect-channel event. Not part of the
 * core `TranscriptEventMap` vocabulary — it rides the stream as a raw event —
 * so every field is read defensively here.
 */
interface AskUserEventData {
  callId?: unknown;
  question?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}

function isAskUserOptionArray(value: unknown): value is AskUserOption[] {
  return (
    Array.isArray(value) &&
    value.every(
      (option) =>
        option !== null &&
        typeof option === 'object' &&
        typeof (option as AskUserOption).label === 'string',
    )
  );
}

/**
 * Receipt from `POST /approvals` carrying the remember-rule outcome.
 *
 * `remembered` is present when the rule was written or already covered.
 * `rememberError` is present when the save failed — the approval itself
 * still succeeded; this is NOT an error state for the approval.
 *
 * Both fields are optional: a plain allow/deny without remember returns
 * neither; a 409 (stale card) returns `{}`.
 */
export interface ApprovalOutcome {
  remembered?: {
    rule: unknown;
    outcome: string;
    effectiveFrom: string;
  };
  rememberError?: string;
}

/** One approval the agent is currently blocked on. */
export interface PendingApproval {
  callId: string;
  toolName: string;
  riskTier: string;
  /**
   * The arguments of the tool call being decided, recovered from the
   * `tool_use` block already streamed for this `callId`.
   *
   * Recovered rather than carried on the approval event on purpose: a second
   * copy of the arguments can drift from the ones that actually execute.
   * Undefined when the originating block is no longer in the replay buffer —
   * the approval still renders, just without arguments.
   */
  input?: Record<string, unknown>;
  /**
   * ask_user prompt data, merged from the `ask_user` event sharing this
   * callId (the ask tool emits it right before parking on the gate). Present
   * only while that event is still in the replay buffer; an ask_user pending
   * approval without it degrades to the free-text-only card.
   */
  question?: string;
  options?: AskUserOption[];
  multiSelect?: boolean;
}

/**
 * Derive the approvals still waiting on the user from the buffered event
 * stream: every `approval_asked` that has not been answered by a matching
 * `approval_decision`, in the order they were asked.
 *
 * Derived rather than stored so a reconnect (which replays the buffer) lands
 * in the same state as a live stream, with no separate bookkeeping to drift.
 *
 * Returns a FRESH ARRAY on every call, so it must NOT be called inside a
 * zustand selector: `useChatStore((s) => selectPendingApprovals(s.events))`
 * hands useSyncExternalStore a new identity every render, which React reports
 * as "The result of getServerSnapshot should be cached to avoid an infinite
 * loop". Subscribe to the stable `events` reference and derive in a `useMemo`
 * keyed on it — see ChatPanel. (`providerModels` in stores/config-store.ts
 * solves the same problem with an explicit cache, if a caller ever needs a
 * stable identity without a hook.)
 */
/**
 * Attach the ask_user prompt data an event carried to a pending approval,
 * field-by-field guarded: the event rides the wire untyped, and a malformed
 * payload must degrade to "no ask data" (the card then falls back to the
 * free-text-only ask UI), never to a blank screen.
 */
function withAskData(
  approval: PendingApproval,
  data: AskUserEventData,
): PendingApproval {
  return {
    ...approval,
    ...(typeof data.question === 'string' ? { question: data.question } : {}),
    ...(isAskUserOptionArray(data.options) ? { options: data.options } : {}),
    ...(typeof data.multiSelect === 'boolean'
      ? { multiSelect: data.multiSelect }
      : {}),
  };
}

export function selectPendingApprovals(
  events: readonly TranscriptEventInput[],
): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();
  // callId -> the arguments streamed for it, filled as we walk the log.
  const inputs = new Map<string, unknown>();
  // callId -> ask_user prompt data. The ask tool emits its event BEFORE the
  // approval parks, so either order is legal: data seen first is staged here
  // and merged when the matching approval_asked lands (and vice versa).
  const askData = new Map<string, AskUserEventData>();

  for (const event of events) {
    if (event.type === 'assistant_message') {
      // `data` is the union of every payload; narrow it to this event's shape
      // the same way the core projections (transcript/view-projection) do.
      const data = event.data as TranscriptEventMap['assistant_message'];
      // Guarded rather than trusted: this runs inside ChatPanel's useMemo, so
      // a throw here takes down the whole chat pane, not just the approval
      // card. A malformed or partial event must degrade to "no arguments
      // recovered", never to a blank screen.
      if (Array.isArray(data?.content)) {
        for (const block of data.content) {
          if (block?.type === 'tool_use') {
            inputs.set(block.id, block.input);
          }
        }
      }
      continue;
    }
    if ((event.type as string) === 'ask_user') {
      // The ask tool's own event: carries the prompt data the approval card
      // renders its radio/checkbox/free-text UI from. Same callId the gate
      // (and therefore POST /approvals) keys on. Not in the core event
      // vocabulary, so the discriminant is widened here.
      const data = event.data as AskUserEventData;
      if (typeof data?.callId !== 'string' || data.callId === '') continue;
      askData.set(data.callId, data);
      const existing = pending.get(data.callId);
      if (existing) {
        pending.set(data.callId, withAskData(existing, data));
      }
      continue;
    }
    if (event.type === 'approval_asked') {
      const data = event.data as TranscriptEventMap['approval_asked'];
      if (data.callId === '') continue;
      const input = inputs.get(data.callId);
      const approval: PendingApproval = {
        callId: data.callId,
        toolName: data.name,
        riskTier: data.riskTier,
        ...(input !== undefined ? { input: input as Record<string, unknown> } : {}),
      };
      const staged = askData.get(data.callId);
      pending.set(data.callId, staged ? withAskData(approval, staged) : approval);
      continue;
    }
    if (event.type === 'approval_decision') {
      // A decision for an unknown callId is a no-op: its ask may have fallen
      // outside the replay buffer.
      const data = event.data as TranscriptEventMap['approval_decision'];
      pending.delete(data.callId);
    }
  }

  return [...pending.values()];
}

/** v1 remembers bash prefixes only — see the approval-remember spec (D9). */
const REMEMBER_TOOL = 'bash';
const MAX_REMEMBER_TOKENS = 8;

/**
 * Prefix candidates a user may remember for this approval, shortest first.
 *
 * Returns [] when the command cannot be expressed as a rule at all — a
 * compound command, an untokenizable one, or one whose leading tokens are not
 * matchable. The card shows no "always allow" entry in that case rather than
 * offering a button whose label would be wider than its effect.
 *
 * This is the one place the web reads `input.command` by name. The display
 * path deliberately stays schema-agnostic (see `soleStringArg`); a remember
 * flow scoped to bash may name bash's field, and keeping it here means a
 * future second command-bearing tool has one function to generalise.
 */
export function rememberablePrefixes(approval: PendingApproval): string[][] {
  if (approval.toolName !== REMEMBER_TOOL) return [];
  const command = approval.input?.['command'];
  if (typeof command !== 'string') return [];
  const tokens = tokenizeCommand(command);
  if (tokens === null) return [];
  const prefixes: string[][] = [];
  for (let size = 1; size <= tokens.length && size <= MAX_REMEMBER_TOKENS; size++) {
    const prefix = tokens.slice(0, size);
    if (!prefix.every(isMatchableCommandToken)) break;
    prefixes.push(prefix);
  }
  return prefixes;
}
