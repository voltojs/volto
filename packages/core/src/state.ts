/**
 * AgentState — the complete, serializable state of an agent conversation.
 * Pure data, no methods, no I/O. Serializable for checkpoint/resume.
 */

/** Status of the agent state machine */
export type AgentStatus =
  | "idle"                  // Waiting for user input
  | "calling_model"         // Model request in flight
  | "executing_tools"       // Tools dispatched, executing
  | "waiting_for_approval"  // Waiting for HITL approval
  | "waiting_for_input"     // Waiting for external input (e.g., sub-agent)
  | "cancelling"            // Cancel requested, cleaning up
  | "done";                 // Turn complete

/** A text content block */
export interface TextContent {
  type: "text";
  text: string;
}

/** An image content block (base64 or URL) */
export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    mediaType: string;
    data: string;
  };
}

/** A tool use block in an assistant message */
export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool result block in a tool result message */
export interface ToolResultContent {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent;

/** System message — instructions injected by the host */
export interface SystemMessage {
  role: "system";
  content: string;
}

/** User message — from the human */
export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

/** Assistant message — from the model */
export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
}

/** Tool result message — output from tool execution */
export interface ToolResultMessage {
  role: "tool";
  content: ToolResultContent[];
}

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

/** A tool call extracted from a model response, pending execution */
export interface PendingToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Read file record for edit_file gating (pure, serializable — survives resume) */
export interface ReadFileRecord {
  path: string;
  /** Incremented each time the path is (re)read or successfully written */
  version: number;
  /** File mtime (epoch ms) observed at read/write time; used for staleness comparison */
  mtime: number;
}

/** The complete agent state */
export interface AgentState {
  messages: Message[];
  pendingTools: PendingToolCall[];
  status: AgentStatus;
  tokenBudget: number | undefined;
  /** Cumulative tokens consumed this turn (input + output), enforced against tokenBudget */
  tokensUsed: number;
  maxIterations: number;
  iterationCount: number;
  readFiles: ReadFileRecord[];
}
