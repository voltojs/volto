/**
 * Electron 主进程入口
 * 负责应用生命周期管理和 IPC 处理器注册
 */

import { app, shell, BrowserWindow } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { createMainWindow } from "./window.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { getStoreIpcHandlers } from "./ipc/store-handlers.js";
import { getAgentIpcHandlers } from "./ipc/agent-handlers.js";
import { getAgentManager, destroyAgentManager } from "./agent/agent-manager.js";
import { createIpcEventSink } from "./agent/event-bridge.js";

function initApp(): void {
  electronApp.setAppUserModelId("com.volto.desktop-app");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  app.whenReady().then(() => {
    // 创建 EventSink
    const eventSink = createIpcEventSink();

    // 初始化 Agent Manager
    getAgentManager(eventSink);

    // 注册 IPC 处理器
    registerIpcHandlers([
      ...getStoreIpcHandlers(),
      ...getAgentIpcHandlers(),
    ]);

    createMainWindow();

    // macOS: 点击 dock 图标时重新创建窗口
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  // 关闭所有窗口时退出应用（macOS 除外）
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // 退出前回收每个 agent 实例持有的长驻 bash 会话与后台进程。
  // 用 before-quit 而非 will-quit：此时还允许 async 收尾，且要先阻止默认退出，
  // 否则子进程会随主进程一起被留成孤儿。
  let teardownDone = false;
  app.on("before-quit", (event) => {
    if (teardownDone) return;
    event.preventDefault();
    void destroyAgentManager().finally(() => {
      teardownDone = true;
      app.quit();
    });
  });

  // 外部链接用系统浏览器打开
  app.on("web-contents-created", (_, contents) => {
    contents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: "deny" };
    });
  });
}

initApp();
