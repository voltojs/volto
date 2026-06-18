/**
 * Electron 主进程入口
 * 负责应用生命周期管理和 IPC 处理器注册
 */

import { app, shell, BrowserWindow } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { createMainWindow } from "./window.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { getStoreIpcHandlers } from "./ipc/store-handlers.js";

function initApp(): void {
  electronApp.setAppUserModelId("com.volto.desktop-app");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  app.whenReady().then(() => {
    // 注册 IPC 处理器
    registerIpcHandlers(getStoreIpcHandlers());

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

  // 外部链接用系统浏览器打开
  app.on("web-contents-created", (_, contents) => {
    contents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: "deny" };
    });
  });
}

initApp();
