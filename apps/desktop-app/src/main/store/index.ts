/**
 * Electron Store 实例
 * 提供类型安全的持久化存储
 */

import Store from "electron-store";
import { type StoreSchema, STORE_DEFAULTS } from "./schema.js";

/** 创建 electron-store 实例 */
export function createStore(): Store<StoreSchema> {
  return new Store<StoreSchema>({
    name: "volto-config",
    defaults: STORE_DEFAULTS,
  });
}

/** 全局 store 单例 */
let storeInstance: Store<StoreSchema> | null = null;

/** 获取 store 单例 */
export function getStore(): Store<StoreSchema> {
  if (!storeInstance) {
    storeInstance = createStore();
  }
  return storeInstance;
}

/** 销毁 store 单例（用于测试） */
export function destroyStore(): void {
  storeInstance = null;
}

export type { StoreSchema };
export { STORE_DEFAULTS };
