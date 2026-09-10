/**
 * The gateway's human-in-the-loop approval gate.
 *
 * `createAutoAllowGate()` waved every "ask" decision through without the user
 * ever seeing it, which is why no preset that could produce one was ever
 * exposed. This registry parks each ask() on a promise, hands the call out
 * over the session's SSE channel (the Runner emits `approval_asked` as a
 * transcript event, so no extra plumbing is needed here), and settles it when
 * `POST /approvals` arrives.
 *
 * Every unsettled approval is denied when its session goes away — a dropped
 * connection or an interrupted turn must never leave a tool call silently
 * allowed. There is deliberately no timeout: an approval that hangs for hours
 * is more visible to a human than one that quietly resolved itself.
 *
 * Denials carry a reason so the UI (and the audit log) can tell a click the
 * user made from a fail-closed path the gateway took on their behalf.
 */

import type {
  ApprovalDenialReason,
  ApprovalGate,
  ApprovalResult,
  PendingToolCall,
  RiskTier,
} from "@volto/core";

/**
 * What a client may answer at an approval prompt.
 *
 * One-shot only. A session-scoped "always allow" used to exist here; it was
 * removed because a grant that outlives model switches, project switches and
 * a downgrade of the permission preset is a scope no user can predict --
 * granting it under `auto` left `bash` running after a downgrade to
 * `read-only`. If a persistent grant returns, it must be turn-scoped.
 */
export type ApprovalDecision = "allow" | "deny";

export interface PendingApproval {
  callId: string;
  toolName: string;
  resolve: (result: ApprovalResult) => void;
}

export interface ApprovalRegistry {
  /** The port handed to createAgent(). */
  readonly gate: ApprovalGate;
  /** Settle one pending approval as a user decision. False when callId is unknown. */
  settle(callId: string, decision: ApprovalDecision): boolean;
  /** Settle every pending approval at once — the fail-closed path. */
  settleAll(decision: ApprovalDecision, reason: ApprovalDenialReason): void;
  /** How many approvals are waiting on a human. */
  size(): number;
}

export function createApprovalRegistry(): ApprovalRegistry {
  const pending = new Map<string, PendingApproval>();

  const gate: ApprovalGate = {
    ask(call: PendingToolCall, _riskTier: RiskTier): Promise<ApprovalResult> {
      return new Promise<ApprovalResult>((resolve) => {
        pending.set(call.id, { callId: call.id, toolName: call.name, resolve });
      });
    },
  };

  return {
    gate,

    settle(callId: string, decision: ApprovalDecision): boolean {
      const entry = pending.get(callId);
      if (!entry) return false;
      pending.delete(callId);
      entry.resolve({ decision, reason: "user" });
      return true;
    },

    settleAll(decision: ApprovalDecision, reason: ApprovalDenialReason): void {
      for (const entry of pending.values()) {
        entry.resolve({ decision, reason });
      }
      pending.clear();
    },

    size(): number {
      return pending.size;
    },
  };
}
