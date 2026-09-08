/**
 * Store Schema 类型定义
 * 定义 electron-store 的数据结构
 */

/** 窗口边界信息 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 应用设置 */
export interface AppSettings {
  /** 主题模式 */
  theme: "light" | "dark" | "system";
  /** 语言 */
  locale: "zh-CN" | "en-US";
  /** 字体大小 */
  fontSize: number;
  /** 是否显示开发者工具 */
  showDevTools: boolean;
  /** 自动检查更新 */
  autoCheckUpdates: boolean;
}

/** 会话元数据 */
export interface SessionMeta {
  /** 会话 ID */
  id: string;
  /** 会话标题 */
  title: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 消息数量 */
  messageCount: number;
  /** 绑定的供应商 id（未绑定时为 undefined，比如 providers 为空时新建的会话） */
  providerId?: string;
  /** 绑定的模型 id */
  modelId?: string;
}

/** 单个模型配置 */
export interface ModelConfig {
  /** 稳定唯一 id（crypto.randomUUID()） */
  id: string;
  /** 展示名，用户自定义 */
  name: string;
  /** 实际发给 API 的模型标识（如 "gpt-4o-mini"） */
  code: string;
  /** 上下文长度，仅展示，不接入 core 的 token 预算/压缩逻辑 */
  contextLength?: number;
}

/** 单个供应商配置 */
export interface ProviderConfig {
  id: string;
  name: string;
  /** 留空则由 wiring 层退回默认地址 https://api.openai.com */
  baseURL: string | null;
  apiKey: string | null;
  models: ModelConfig[];
}

/**
 * 已持久化的工具调用快照
 * 与渲染端 `chat-store` 的 ToolCall 保持结构兼容。
 */
export interface PersistedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  duration?: number;
}

/**
 * 已持久化的消息
 * 与渲染端 `chat-store` 的 Message 保持结构兼容；
 * `isStreaming` 故意不持久化（重启后未完成的流应当视为已结束）。
 */
export interface PersistedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: PersistedToolCall[];
}

/** 完整的 Store Schema */
export interface StoreSchema {
  /** 窗口边界 */
  windowBounds: WindowBounds;
  /** 应用设置 */
  settings: AppSettings;
  /** 会话列表 */
  sessions: SessionMeta[];
  /**
   * 会话消息：sessionId -> messages。
   * 与 sessions 分开存以便单会话写入时不必序列化全量历史。
   */
  sessionMessages: Record<string, PersistedMessage[]>;
  /** 最后活跃的会话 ID */
  lastActiveSessionId: string | null;
  /** 供应商列表，每个供应商下含自己的模型列表 */
  providers: ProviderConfig[];
  /** 权限模式 */
  permissionMode: "auto" | "ask" | "deny";
}

/** Store Schema 默认值 */
export const STORE_DEFAULTS: StoreSchema = {
  windowBounds: {
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
  },
  settings: {
    theme: "system",
    locale: "zh-CN",
    fontSize: 14,
    showDevTools: false,
    autoCheckUpdates: true,
  },
  sessions: [],
  sessionMessages: {},
  lastActiveSessionId: null,
  providers: [],
  // 默认开启 "ask" 模式：高风险写入与不可逆操作弹窗确认。"auto" 会绕过审批，
  // 一旦默认值上去，用户在 UI 看不见 ApprovalDialog 就会以为审批没接通；"ask"
  // 让 Phase 5 的审批流程开箱即用，用户可在设置里降级为 "auto"。
  permissionMode: "ask",
};
