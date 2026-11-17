/**
 * The native shell: one BrowserWindow with two views.
 *
 * - `shellView` renders the local bar/management page and owns the preload
 *   bridge.
 * - `contentView` renders whatever gateway is active. It has no preload, no
 *   Node access, its own session partition, a navigation allow-list and an
 *   external-open handler — a remote gateway's page is untrusted input.
 *
 * Opening the management page grows `shellView` to the whole window instead of
 * compositing a transparent overlay: view transparency differs across
 * platforms, an opaque full-window page does not.
 */

import { pathToFileURL } from "node:url";

import { app, BrowserWindow, WebContentsView, session, shell } from "electron";

import { BAR_HEIGHT, type ShellState } from "@shared/gateway";

import { isAllowedNavigation, isShellNavigationAllowed } from "./navigation";

const CONTENT_PARTITION = "persist:volto-gateway";
const ALLOWED_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write"]);

export interface ShellWindow {
  win: BrowserWindow;
  shellView: WebContentsView;
  contentView: WebContentsView;
  applyState(state: ShellState): void;
  loadGateway(url: string): void;
  /** Blank the content view and forget the gateway origin it allowed. */
  clearGateway(): void;
  reloadContent(): void;
  openExternal(url: string): void;
  toggleDevTools(): void;
  show(): void;
}

export interface CreateShellWindowOptions {
  preloadPath: string;
  /** `ELECTRON_RENDERER_URL` in development; absent in a packaged build. */
  rendererUrl?: string;
  rendererFile: string;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function createShellWindow(options: CreateShellWindowOptions): ShellWindow {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Volto",
    backgroundColor: "#0b0b0c",
    titleBarStyle: isMac ? "hiddenInset" : isWindows ? "hidden" : "default",
    ...(isMac ? { trafficLightPosition: { x: 16, y: 15 } } : {}),
    ...(isWindows
      ? { titleBarOverlay: { color: "#0b0b0c", symbolColor: "#e5e5e5", height: BAR_HEIGHT } }
      : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const shellView = new WebContentsView({
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const contentView = new WebContentsView({
    webPreferences: {
      partition: CONTENT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.contentView.addChildView(contentView);
  win.contentView.addChildView(shellView);

  let sheetOpen = false;
  let gatewayOrigin: string | undefined;
  let allowClose = false;
  app.once("before-quit", () => {
    allowClose = true;
  });

  const layout = (): void => {
    const [width = 0, height = 0] = win.getContentSize();
    shellView.setBounds({ x: 0, y: 0, width, height: sheetOpen ? height : BAR_HEIGHT });
    contentView.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) });
  };
  layout();
  win.on("resize", layout);
  win.on("enter-full-screen", layout);
  win.on("leave-full-screen", layout);

  const gatewaySession = session.fromPartition(CONTENT_PARTITION);
  gatewaySession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  gatewaySession.setPermissionCheckHandler((_contents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission);
  });

  // A page from the active gateway may only navigate inside its own origin.
  // Everything else leaves for the system browser.
  const allowNavigation = (url: string): boolean => isAllowedNavigation(gatewayOrigin, url);

  contentView.webContents.on("will-navigate", (event) => {
    if (allowNavigation(event.url)) return;
    event.preventDefault();
    if (isHttpUrl(event.url)) void shell.openExternal(event.url);
  });
  contentView.webContents.on("will-redirect", (event) => {
    if (allowNavigation(event.url)) return;
    event.preventDefault();
    if (isHttpUrl(event.url)) void shell.openExternal(event.url);
  });
  // Subframes do not emit `will-navigate`; without this a gateway page could
  // frame an arbitrary origin inside the sandboxed session.
  contentView.webContents.on("will-frame-navigate", (event) => {
    if (allowNavigation(event.url)) return;
    event.preventDefault();
  });
  contentView.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contentView.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  shellView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const shellEntryUrl =
    options.rendererUrl !== undefined && options.rendererUrl !== ""
      ? `${options.rendererUrl.replace(/\/+$/, "")}/index.html`
      : pathToFileURL(options.rendererFile).toString();
  // The shell page carries the preload and the whole ShellApi; it must never
  // navigate away from its own entry document.
  const guardShellNavigation = (event: { preventDefault(): void; url: string }): void => {
    if (!isShellNavigationAllowed(shellEntryUrl, event.url)) event.preventDefault();
  };
  shellView.webContents.on("will-navigate", guardShellNavigation);
  shellView.webContents.on("will-redirect", guardShellNavigation);
  void shellView.webContents.loadURL(shellEntryUrl).catch(() => undefined);

  // The window's own webContents never loads anything: `ready-to-show` may
  // never fire, so show immediately on the dark background and let the views
  // paint into it.
  win.show();

  win.on("close", (event) => {
    if (isMac && !allowClose) {
      // Closing the window hides it; Cmd+Q quits through before-quit.
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    if (!shellView.webContents.isDestroyed()) shellView.webContents.close();
    if (!contentView.webContents.isDestroyed()) contentView.webContents.close();
  });

  return {
    win,
    shellView,
    contentView,
    applyState(state) {
      sheetOpen = state.sheetOpen;
      layout();
      if (!shellView.webContents.isDestroyed()) {
        shellView.webContents.send("shell:state", state);
      }
    },
    loadGateway(url) {
      gatewayOrigin = new URL(url).origin;
      void contentView.webContents.loadURL(url).catch(() => undefined);
    },
    clearGateway() {
      gatewayOrigin = undefined;
      void contentView.webContents.loadURL("about:blank").catch(() => undefined);
    },
    reloadContent() {
      contentView.webContents.reload();
    },
    openExternal(url) {
      if (isHttpUrl(url)) void shell.openExternal(url);
    },
    toggleDevTools() {
      contentView.webContents.toggleDevTools();
    },
    show() {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  };
}