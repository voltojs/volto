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
 */

import type { ApprovalGate, PendingToolCall, RiskTier } from "@volto/core";

/** What a client may answer at an approval prompt. */
export type ApprovalDecision = "allow" | "allow_always" | "deny";

export interface PendingApproval {
  callId: string;
  toolName: string;
  resolve: (decision: "allow" | "deny") => void;
}

export interface ApprovalRegistry {
  /** The port handed to createAgent(). */
  readonly gate: ApprovalGate;
  /** Settle one pending approval. Returns false when `callId` is unknown. */
  settle(callId: string, decision: ApprovalDecision): boolean;
  /** Settle every pending approval at once — the fail-closed path. */
  settleAll(decision: "allow" | "deny"): void;
  /** How many approvals are waiting on a human. */
  size(): number;
}

export interface ApprovalRegistryOptions {
  /**
   * Called when a user grants "always allow" for a tool, before the call is
   * resolved — the caller appends a session-scoped permission rule so the
   * next call of the same tool is never asked about again.
   */
  onAlwaysAllow: (toolName: string) => void;
}

export function createApprovalRegistry(opts: ApprovalRegistryOptions): ApprovalRegistry {
  const pending = new Map<string, PendingApproval>();

  const gate: ApprovalGate = {
    ask(call: PendingToolCall, _riskTier: RiskTier): Promise<"allow" | "deny"> {
      return new Promise<"allow" | "deny">((resolve) => {
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
      // The rule is recorded before the call resolves, so the very next
      // permission evaluation in this turn already sees it.
      if (decision === "allow_always") opts.onAlwaysAllow(entry.toolName);
      entry.resolve(decision === "deny" ? "deny" : "allow");
      return true;
    },

    settleAll(decision: "allow" | "deny"): void {
      for (const entry of pending.values()) {
        entry.resolve(decision);
      }
      pending.clear();
    },

    size(): number {
      return pending.size;
    },
  };
}
