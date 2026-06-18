import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";

export function createMainWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const mainWindow = new BrowserWindow({
    width: Math.min(1280, width),
    height: Math.min(800, height),
    title: "Volto Agent",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  // 开发模式加载 Vite dev server，生产模式加载本地文件
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // 窗口准备好后显示（避免白屏闪烁）
  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  return mainWindow;
}
