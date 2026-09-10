import type { TranscriptEventInput, TranscriptEventMap } from '@volto/core';

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
export function selectPendingApprovals(
  events: readonly TranscriptEventInput[],
): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();
  // callId -> the arguments streamed for it, filled as we walk the log.
  const inputs = new Map<string, unknown>();

  for (const event of events) {
    if (event.type === 'assistant_message') {
      // `data` is the union of every payload; narrow it to this event's shape
      // the same way the core projections (transcript/view-projection) do.
      const data = event.data as TranscriptEventMap['assistant_message'];
      for (const block of data.content) {
        if (block.type === 'tool_use') {
          inputs.set(block.id, block.input);
        }
      }
      continue;
    }
    if (event.type === 'approval_asked') {
      const data = event.data as TranscriptEventMap['approval_asked'];
      if (data.callId === '') continue;
      const input = inputs.get(data.callId);
      pending.set(data.callId, {
        callId: data.callId,
        toolName: data.name,
        riskTier: data.riskTier,
        ...(input !== undefined ? { input: input as Record<string, unknown> } : {}),
      });
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
