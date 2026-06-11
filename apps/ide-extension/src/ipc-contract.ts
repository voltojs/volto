/**
 * IPC Contract — shared event/request types for IDE ↔ agent communication.
 * Used by both VS Code and JetBrains extensions.
 */

export interface AgentRequest {
  type: "run" | "stream" | "resume";
  message: string;
  sessionId?: string;
  decision?: "allow" | "deny";
}

export interface AgentEvent {
  type: "text_delta" | "tool_result" | "model_done" | "error" | "done";
  data: Record<string, unknown>;
}

export interface AgentResponse {
  status: "ok" | "error";
  message?: string;
  sessionId?: string;
  state?: unknown;
}
