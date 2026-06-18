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

/** Agent API */
const agentAPI = {
  /** 创建 agent 实例 */
  create: () => ipcRenderer.invoke("agent:create"),

  /** 发送消息 */
  sendMessage: (message: string) =>
    ipcRenderer.invoke("agent:send-message", { message }),

  /** 恢复会话 */
  resume: (sessionId: string, decision: "allow" | "deny") =>
    ipcRenderer.invoke("agent:resume", { sessionId, decision }),

  /** 获取 agent 状态 */
  getStatus: () => ipcRenderer.invoke("agent:get-status"),

  /** 获取 agent 状态 */
  getState: () => ipcRenderer.invoke("agent:get-state"),

  /** 销毁 agent 实例 */
  destroy: () => ipcRenderer.invoke("agent:destroy"),

  /** 订阅 agent 事件 */
  onEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("agent:event", handler);
    return () => {
      ipcRenderer.removeListener("agent:event", handler);
    };
  },
};

/** 应用信息 API */
const appAPI = {
  /** 获取平台信息 */
  platform: process.platform,
};

/** 暴露 API 到渲染进程 */
contextBridge.exposeInMainWorld("electronAPI", {
  store: storeAPI,
  agent: agentAPI,
  app: appAPI,
});
