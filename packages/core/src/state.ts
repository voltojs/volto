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

/**
 * Optional stable identifier for a message.
 * Used by pinning to track which messages must never be compressed.
 * Set by the host when adding messages to state; absent messages are not pinnable.
 */
export interface WithId {
  id?: string;
}

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
  /** Tool call pending HITL approval (serialized for checkpoint/resume) */
  pendingApprovalTool?: PendingToolCall;
  /**
   * Steering queue — user messages received mid-turn (during calling_model or
   * executing_tools). Injected into messages at the next turn boundary
   * (all tools complete → calling_model). Serializable for checkpoint/resume.
   */
  queuedUserInputs: UserMessage[];
  /** Cumulative tool calls dispatched this turn. Enforced against maxToolCalls. */
  toolCallCount: number;
  /**
   * Max tool calls allowed per turn. When exceeded, the reducer terminates
   * the turn with a "budget_exceeded" done state. Undefined = no limit.
   */
  maxToolCalls: number | undefined;
  /**
   * Maximum total cost ($) allowed per turn. When exceeded by the Runner,
   * a budget_exceeded input is fed to terminate the turn. Undefined = no limit.
   * Requires pricing configuration to be meaningful.
   */
  maxCostDollars: number | undefined;
  /**
   * Maximum raw token count allowed per turn (input + output).
   * Independent of pricing — always compares against raw token sums.
   * Undefined = no limit.
   */
  maxTokensPerTurn: number | undefined;
  /**
   * Maximum wall-clock milliseconds allowed per turn. When exceeded by the
   * Runner, a budget_exceeded input is fed to terminate the turn. Undefined = no limit.
   */
  maxWallclockMs: number | undefined;
  /**
   * Max consecutive identical failed tool calls before intervention (loop detection).
   * When the model repeats the same tool call with the same input K times and
   * all return errors, the turn is terminated. Undefined = no limit.
   */
  maxLoopCount: number | undefined;
  /**
   * IDs of messages that are "pinned" — never compressed by Compactor,
   * and stably positioned in ContextAssembler prefix slots.
   * Serializable for checkpoint/resume.
   */
  pinnedMessageIds?: string[];
  /**
   * Self-correction attempt counter (reset each turn).
   * Tracked in serializable state for checkpoint/resume.
   * When maxSelfCorrections is reached, forced termination occurs.
   */
  selfCorrectionCount: number;
  /** Max self-corrections per turn. Undefined = no limit (0 effectively disables self-correction). */
  maxSelfCorrections: number | undefined;
}
