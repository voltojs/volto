/**
 * Electron API 类型声明
 * 为渲染进程提供类型安全的 API 访问
 */

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

/** Electron API 类型 */
export interface ElectronAPI {
  /** Store API */
  store: StoreAPI;

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
