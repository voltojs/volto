/**
 * Electron API 类型声明
 * 为渲染进程提供类型安全的 API 访问
 *
 * 这是 Window.electronAPI 的**唯一**类型来源；其它文件不得再次 augment
 * `Window` 或重新定义 `ElectronAPI` 接口，避免类型合并冲突。
 */

import type { AgentEvent, AgentStatus, AgentResult } from "./agent";

/** 风险等级（与 core 的 RiskTier 同义，单独复制一份避免 type-only 跨包依赖） */
export type RiskTier = "READ_ONLY" | "WRITE_LOW" | "WRITE_HIGH" | "IRREVERSIBLE";

/** 审批请求载荷 — 主进程通过 `agent:approval-request` 推送给渲染端 */
export interface ApprovalRequest {
  requestId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskTier: RiskTier;
  requestedAt: number;
  /** 发起这次审批请求的聊天会话 id */
  sessionId: string;
}

/** Store API 类型 */
export interface StoreAPI {
  /** 获取 store 值 */
  get<T = unknown>(key: string): Promise<T>;

  /** 设置 store 值 */
  set(key: string, value: unknown): Promise<void>;

  /** 删除 store 值 */
  delete(key: string): Promise<void>;

  /** 清空 store */
  clear(): Promise<void>;
}

/** 应用信息 API 类型 */
export interface AppAPI {
  /** 平台信息 */
  platform: string;
}

/** Agent API 类型 */
export interface AgentAPI {
  /** 创建 agent 实例 */
  create(sessionId: string): Promise<AgentResult>;

  /** 发送消息 */
  sendMessage(sessionId: string, message: string): Promise<AgentResult>;

  /** 恢复会话 */
  resume(sessionId: string, resumeId: string, decision: "allow" | "deny"): Promise<AgentResult>;

  /** 获取 agent 状态 */
  getStatus(sessionId: string): Promise<AgentStatus>;

  /** 获取 agent 内部 state */
  getState(sessionId: string): Promise<unknown>;

  /** 销毁 agent 实例 */
  destroy(sessionId: string): Promise<void>;

  /** 订阅 agent 事件 */
  onEvent(callback: (event: AgentEvent) => void): () => void;

  /** 订阅审批请求事件 */
  onApprovalRequest(callback: (payload: ApprovalRequest) => void): () => void;

  /** 写回审批决策；返回值的 handled 字段为 false 时表示请求已超时/被替换 */
  decideApproval(
    requestId: string,
    decision: "allow" | "deny",
  ): Promise<{ handled: boolean }>;

  /** 拉取当前所有挂起的审批请求 */
  listApprovals(): Promise<ApprovalRequest[]>;
}

/** Electron API 类型 */
export interface ElectronAPI {
  /** Store API */
  store: StoreAPI;

  /** Agent API */
  agent: AgentAPI;

  /** 应用信息 API */
  app: AppAPI;
}

/** 全局 Window 接口扩展 */
declare global {
  interface Window {
    /** Electron API */
    electronAPI: ElectronAPI;
  }
}
