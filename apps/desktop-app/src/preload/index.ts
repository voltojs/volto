/**
 * Preload 脚本
 * 通过 contextBridge 暴露安全的 API 给渲染进程
 */

import { contextBridge, ipcRenderer } from "electron";

/** Store API */
const storeAPI = {
  /** 获取 store 值 */
  get: (key: string) => ipcRenderer.invoke("store:get", { key }),

  /** 设置 store 值 */
  set: (key: string, value: unknown) =>
    ipcRenderer.invoke("store:set", { key, value }),

  /** 删除 store 值 */
  delete: (key: string) => ipcRenderer.invoke("store:delete", { key }),

  /** 清空 store */
  clear: () => ipcRenderer.invoke("store:clear"),
};

/** 应用信息 API */
const appAPI = {
  /** 获取平台信息 */
  platform: process.platform,
};

/** 暴露 API 到渲染进程 */
contextBridge.exposeInMainWorld("electronAPI", {
  store: storeAPI,
  app: appAPI,
});
