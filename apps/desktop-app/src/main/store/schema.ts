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
  /** 模型名称 */
  model?: string;
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
  /** API Key（加密存储） */
  apiKey: string | null;
  /** 模型名称 */
  modelName: string;
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
  apiKey: null,
  modelName: "gpt-4",
  permissionMode: "auto",
};
