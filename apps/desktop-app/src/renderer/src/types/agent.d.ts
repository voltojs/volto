/**
 * Agent 相关类型定义
 * 为渲染进程提供 Agent 操作的类型安全
 *
 * 这里只导出**值/数据**类型，不 augment Window。Window.electronAPI 的
 * 类型声明唯一来源是 `./electron.d.ts`。
 */

/** Agent 状态 */
export type AgentStatus = "idle" | "running" | "streaming" | "error";

/** Agent 事件类型 */
export interface AgentEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

/** 消息角色 */
export type MessageRole = "user" | "assistant" | "system";

/** 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  duration?: number;
}

/** 消息 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

/** 会话信息 */
export interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** Agent 操作结果 */
export interface AgentResult {
  success: boolean;
  error?: string;
}
