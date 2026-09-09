import type { TranscriptEventInput, TranscriptEventMap } from '@volto/core';

/** One approval the agent is currently blocked on. */
export interface PendingApproval {
  callId: string;
  toolName: string;
  riskTier: string;
}

/**
 * Derive the approvals still waiting on the user from the buffered event
 * stream: every `approval_asked` that has not been answered by a matching
 * `approval_decision`, in the order they were asked.
 *
 * Derived rather than stored so a reconnect (which replays the buffer) lands
 * in the same state as a live stream, with no separate bookkeeping to drift.
 */
export function selectPendingApprovals(
  events: readonly TranscriptEventInput[],
): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();

  for (const event of events) {
    if (event.type === 'approval_asked') {
      // `data` is the union of every payload; narrow it to this event's shape
      // the same way the core projections (transcript/view-projection) do.
      const data = event.data as TranscriptEventMap['approval_asked'];
      if (data.callId === '') continue;
      pending.set(data.callId, {
        callId: data.callId,
        toolName: data.name,
        riskTier: data.riskTier,
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
