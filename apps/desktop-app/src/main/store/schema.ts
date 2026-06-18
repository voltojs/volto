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

/** 完整的 Store Schema */
export interface StoreSchema {
  /** 窗口边界 */
  windowBounds: WindowBounds;
  /** 应用设置 */
  settings: AppSettings;
  /** 会话列表 */
  sessions: SessionMeta[];
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
  lastActiveSessionId: null,
  apiKey: null,
  modelName: "gpt-4",
  permissionMode: "auto",
};
