/**
 * Store 相关 IPC 处理器
 * 提供 store 的读写操作
 */

import { type IpcMainInvokeEvent } from "electron";
import { getStore } from "../store/index.js";
import type { StoreSchema } from "../store/schema.js";
import { createIpcChannel, type AnyIpcChannel, type IpcChannel } from "./handlers.js";

/** Store get 请求参数 */
export interface StoreGetArgs {
  key: keyof StoreSchema;
}

/** Store set 请求参数 */
export interface StoreSetArgs {
  key: keyof StoreSchema;
  value: StoreSchema[keyof StoreSchema];
}

/** Store delete 请求参数 */
export interface StoreDeleteArgs {
  key: keyof StoreSchema;
}

/** 创建 store:get 处理器 */
function createStoreGetHandler(): IpcChannel<StoreGetArgs, unknown> {
  return createIpcChannel<StoreGetArgs, unknown>(
    "store:get",
    (_event: IpcMainInvokeEvent, args: StoreGetArgs) => {
      const store = getStore();
      return store.get(args.key);
    },
  );
}

/** 创建 store:set 处理器 */
function createStoreSetHandler(): IpcChannel<StoreSetArgs, void> {
  return createIpcChannel<StoreSetArgs, void>(
    "store:set",
    (_event: IpcMainInvokeEvent, args: StoreSetArgs) => {
      const store = getStore();
      store.set(args.key, args.value);
    },
  );
}

/** 创建 store:delete 处理器 */
function createStoreDeleteHandler(): IpcChannel<StoreDeleteArgs, void> {
  return createIpcChannel<StoreDeleteArgs, void>(
    "store:delete",
    (_event: IpcMainInvokeEvent, args: StoreDeleteArgs) => {
      const store = getStore();
      store.delete(args.key);
    },
  );
}

/** 创建 store:clear 处理器 */
function createStoreClearHandler(): IpcChannel<void, void> {
  return createIpcChannel<void, void>(
    "store:clear",
    (_event: IpcMainInvokeEvent) => {
      const store = getStore();
      store.clear();
    },
  );
}

/** 获取所有 store 相关的 IPC 处理器 */
export function getStoreIpcHandlers(): AnyIpcChannel[] {
  return [
    createStoreGetHandler(),
    createStoreSetHandler(),
    createStoreDeleteHandler(),
    createStoreClearHandler(),
  ];
}
