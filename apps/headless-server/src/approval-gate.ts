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
 * The gate itself remains one-shot: every call is settled exactly once, by
 * an explicit user click or a fail-closed path.  The earlier prohibition on
 * persistent grants ("if a persistent grant returns, it must be
 * turn-scoped") ruled on *in-session implicit grants* — the deleted
 * `dynamicRules` that silently persisted across model / project switches
 * and preset downgrades (see spec §1.4, 2026-09-10).
 *
 * The "remember" feature (spec 2026-09-20) takes a fundamentally different
 * path: the user explicitly chooses to write a rule to the *visible,
 * user-editable* `permissions` section of `~/.volto/config.json`, subject to the same
 * ceiling clamp and R1/R2 caveats as hand-written rules.  The file is
 * user-level (applies to every project) and takes effect on the *next*
 * turn — the current turn may still ask again.  This is not a session-
 * scoped override; it is a durable, inspectable, deletable config entry
 * that the user chose to create.  See `permissions.ts` for the write path
 * and `sessions.ts` for the rebuild-on-dirty-flag mechanism.
 */
export type ApprovalDecision = "allow" | "deny";

export interface PendingApproval {
  callId: string;
  toolName: string;
  resolve: (result: ApprovalResult) => void;
}

/**
 * Lifecycle observers for the registry. The registry is the one place that
 * sees BOTH sides of an approval — the ask parking and the settle — including
 * the settle paths (fail-closed settleAll) no tool or runner observes. Hooks
 * fire synchronously, after the pending bookkeeping they describe; the
 * registry guards every invocation so an observer bug cannot fail the
 * approval it observes.
 *
 * The session registry uses these to synthesize the approval_asked /
 * approval_decision brackets for `ask_user` on the session's SSE channel —
 * see sessions.ts.
 */
export interface ApprovalRegistryHooks {
  /** A call just parked on the gate. */
  onPending?: (call: PendingToolCall, riskTier: RiskTier) => void;
  /** A pending call was settled — by a user decision or a fail-closed path. */
  onSettled?: (callId: string, toolName: string, decision: "allow" | "deny") => void;
}

export interface ApprovalRegistry {
  /** The port handed to createAgent(). */
  readonly gate: ApprovalGate;
  /**
   * Settle one pending approval as a user decision. False when callId is unknown.
   *
   * `answer` carries the user's response to an ask_user prompt (selected
   * labels and free-form input merged, the shape ask_user reads back off the
   * resolved ApprovalResult). Only ever set on this one-shot user path —
   * `settleAll`'s fail-closed settlements have no user to answer anything.
   */
  settle(callId: string, decision: ApprovalDecision, answer?: string[]): boolean;
  /** Settle every pending approval at once — the fail-closed path. */
  settleAll(decision: ApprovalDecision, reason: ApprovalDenialReason): void;
  /** How many approvals are waiting on a human. */
  size(): number;
}

export function createApprovalRegistry(hooks: ApprovalRegistryHooks = {}): ApprovalRegistry {
  const pending = new Map<string, PendingApproval>();

  /**
   * Hooks are observer callbacks: a bug in one must never reach the approval
   * itself. onPending runs inside a Promise constructor, so a synchronous
   * throw there would reject the gate promise and turn a parked approval into
   * an error — wrap every invocation.
   */
  function safeCall(hook: (() => void) | undefined): void {
    if (!hook) return;
    try {
      hook();
    } catch {
      // Observer failure is not an approval failure.
    }
  }

  const gate: ApprovalGate = {
    ask(call: PendingToolCall, riskTier: RiskTier): Promise<ApprovalResult> {
      return new Promise<ApprovalResult>((resolve) => {
        pending.set(call.id, { callId: call.id, toolName: call.name, resolve });
        // After the bookkeeping, so an observer that settles synchronously
        // (a test, a fail-fast host) observes a consistent registry.
        safeCall(() => hooks.onPending?.(call, riskTier));
      });
    },
  };

  return {
    gate,

    settle(callId: string, decision: ApprovalDecision, answer?: string[]): boolean {
      const entry = pending.get(callId);
      if (!entry) return false;
      pending.delete(callId);
      entry.resolve({ decision, reason: "user", answer });
      safeCall(() => hooks.onSettled?.(callId, entry.toolName, decision));
      return true;
    },

    settleAll(decision: ApprovalDecision, reason: ApprovalDenialReason): void {
      for (const entry of pending.values()) {
        entry.resolve({ decision, reason });
        safeCall(() => hooks.onSettled?.(entry.callId, entry.toolName, decision));
      }
      pending.clear();
    },

    size(): number {
      return pending.size;
    },
  };
}
