/**
 * Audit log types for structured audit of approval decisions
 * and high-risk tool executions.
 */

export interface AuditEntry {
  /** "approval" for HITL decisions, "high_risk_exec" for WRITE_HIGH/IRREVERSIBLE tool execution */
  kind: "approval" | "high_risk_exec";
  /** Tool name */
  toolName: string;
  /** Risk tier of the tool */
  riskTier?: string;
  /** For approval: the decision ("allow" | "deny"). Undefined for high_risk_exec. */
  decision?: "allow" | "deny";
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Whether the tool execution resulted in an error (high_risk_exec only) */
  isError?: boolean;
  /** Session ID for attribution */
  sessionId?: string;
}

export interface AuditSink {
  record(entry: AuditEntry): void;
}

/** No-op audit sink — entries are discarded. */
export const defaultAuditSink: AuditSink = {
  record(): void {},
};
