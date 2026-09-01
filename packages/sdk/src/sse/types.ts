/**
 * SSE (Server-Sent Events) message types for the volto SDK.
 *
 * Provides typed message definitions for the SSE protocol layer,
 * supporting streaming token output, tool events, approval flows,
 * system events, and connection state management.
 */

// ---------------------------------------------------------------------------
// Event type enum
// ---------------------------------------------------------------------------

/** SSE event type enum — exhaustive list of protocol events. */
export enum SSEEventType {
  /** Streaming token output (incremental content). */
  TOKEN = "token",
  /** Tool call initiated by the agent. */
  TOOL_CALL = "tool_call",
  /** Tool call result returned to the agent. */
  TOOL_RESULT = "tool_result",
  /** Approval request — a tool requires human approval before proceeding. */
  APPROVAL_REQ = "approval_req",
  /** Approval response — human decision on a pending approval request. */
  APPROVAL_RES = "approval_res",
  /** Agent state transition (e.g. idle -> running -> waiting). */
  STATE_CHANGE = "state_change",
  /** Error event. */
  ERROR = "error",
  /** Heartbeat / keep-alive ping. */
  HEARTBEAT = "heartbeat",
  /** Stream ended successfully. */
  DONE = "done",
}

// ---------------------------------------------------------------------------
// Unified message envelope
// ---------------------------------------------------------------------------

/** Unified SSE message envelope. `T` defaults to `unknown`. */
export interface SSEMessage<T = unknown> {
  /** Unique message ID, used for disconnection recovery (Last-Event-ID replay). */
  id: string;
  /** Event type discriminator. */
  event: SSEEventType;
  /** Event payload. */
  data: T;
  /** Server-side timestamp in milliseconds (epoch). */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Per-event data types
// ---------------------------------------------------------------------------

/** Streaming token data. */
export interface TokenData {
  /** Accumulated full content so far. */
  content: string;
  /** Incremental delta delivered in this message. */
  delta: string;
}

/** Tool call initiated by the agent. */
export interface ToolCallData {
  /** Unique call ID — correlates with the matching ToolResultData. */
  id: string;
  /** Tool name (matches a ToolDefinition). */
  name: string;
  /** Tool arguments (JSON-compatible). */
  args: Record<string, unknown>;
}

/** Tool call result. */
export interface ToolResultData {
  /** Call ID — correlates with the originating ToolCallData. */
  id: string;
  /** Tool output payload. */
  result: unknown;
  /** `true` when the tool returned an error. */
  isError: boolean;
}

/** Approval request — a tool with permission policy "ask" triggers this. */
export interface ApprovalRequestData {
  /** Approval ID — used to correlate with the response. */
  id: string;
  /** The tool call awaiting approval. */
  call: ToolCallData;
  /** Risk level of the operation. */
  risk: "low" | "medium" | "high";
  /** Human-readable prompt describing what is being requested. */
  prompt: string;
}

/** Approval response — human decision on a pending approval. */
export interface ApprovalResponseData {
  /** Approval ID — correlates with the originating ApprovalRequestData. */
  id: string;
  /** Human decision. */
  decision: "allow" | "deny";
}

/** Agent state change event. */
export interface StateChangeData {
  /** New state name. */
  state: string;
  /** Previous state name. */
  previous: string;
}

/** Error event. */
export interface ErrorData {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Whether the client may safely retry. */
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

/** Client-side SSE connection state. */
export type ConnectionState = "connecting" | "connected" | "disconnected";
