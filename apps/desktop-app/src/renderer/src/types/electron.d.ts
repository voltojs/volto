/**
 * Electron API 类型声明
 * 为渲染进程提供类型安全的 API 访问
 *
 * 这是 Window.electronAPI 的**唯一**类型来源；其它文件不得再次 augment
 * `Window` 或重新定义 `ElectronAPI` 接口，避免类型合并冲突。
 */

import type { AgentEvent, AgentStatus, AgentResult } from "./agent";

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
  create(): Promise<AgentResult>;

  /** 发送消息 */
  sendMessage(message: string): Promise<AgentResult>;

  /** 恢复会话 */
  resume(sessionId: string, decision: "allow" | "deny"): Promise<AgentResult>;

  /** 获取 agent 状态 */
  getStatus(): Promise<AgentStatus>;

  /** 获取 agent 内部 state */
  getState(): Promise<unknown>;

  /** 销毁 agent 实例 */
  destroy(): Promise<void>;

  /** 订阅 agent 事件 */
  onEvent(callback: (event: AgentEvent) => void): () => void;
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
