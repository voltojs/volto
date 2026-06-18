import { contextBridge } from "electron";

// Phase 2+ 会通过 IPC 暴露 store API 和 agent API
// Phase 1 仅验证 preload 脚本正确加载

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
});
