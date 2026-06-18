/**
 * Agent 相关类型定义
 * 为渲染进程提供 Agent 操作的类型安全
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

/** Agent API 类型 */
export interface AgentAPI {
  /** 创建 agent 实例 */
  create(): Promise<AgentResult>;

  /** 发送消息 */
  sendMessage(message: string): Promise<AgentResult>;

  /** 恢复会话 */
  resume(sessionId: string, decision: "allow" | "deny"): Promise<AgentResult>;

  /** 获取 agent 状态 */
  getStatus(): Promise<AgentStatus>;

  /** 获取 agent 状态 */
  getState(): Promise<unknown>;

  /** 销毁 agent 实例 */
  destroy(): Promise<void>;

  /** 订阅 agent 事件 */
  onEvent(callback: (event: AgentEvent) => void): () => void;
}

/** 全局 Window 接口扩展 */
declare global {
  interface Window {
    /** Electron API */
    electronAPI: {
      /** Store API */
      store: import("./electron.d.ts").StoreAPI;

      /** Agent API */
      agent: AgentAPI;

      /** 应用信息 API */
      app: import("./electron.d.ts").AppAPI;
    };
  }
}
