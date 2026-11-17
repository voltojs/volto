/**
 * Electron main entry: build the controller and the native shell, wire them
 * together, and own the process lifecycle.
 *
 * Ordering matters in one place: the shell is created and subscribed BEFORE
 * `controller.init()` runs, so the very first "starting" status reaches the
 * bar instead of being dropped.
 */

import { app } from "electron";
import * as path from "node:path";

import type { ShellState } from "@shared/gateway";

import { GatewayController } from "./gateway/controller";
import { probeGateway } from "./gateway/probe";
import { resolveGatewayRuntime } from "./gateway/runtime";
import { ElectronProfileStore } from "./gateway/store";
import { LocalGatewaySupervisor } from "./gateway/supervisor";
import { registerShellIpc } from "./shell/ipc";
import { installAppMenu, type ShellMenuActions } from "./shell/menu";
import { createShellWindow, type ShellWindow } from "./shell/window";
import { runSmoke } from "./smoke";

// Smoke runs get their own userData (profiles, cookies, cache) so a harness can
// never read or mutate the real profile store, and repeated runs start clean.
const smokeDir = process.env["VOLTO_DESKTOP_SMOKE"];
if (smokeDir !== undefined && smokeDir !== "") {
  app.setPath("userData", path.join(smokeDir, "user-data"));
}

let controller: GatewayController | undefined;
let shell: ShellWindow | undefined;
let quitting = false;
let menuKey = "";

function syncShell(state: ShellState, actions: ShellMenuActions): void {
  if (shell === undefined) return;
  shell.applyState(state);
  const key = JSON.stringify([state.activeProfileId, state.profiles, state.status.state]);
  if (key !== menuKey) {
    menuKey = key;
    installAppMenu({ state, actions });
  }
}

function start(): void {
  app.setAppUserModelId("com.volto.desktop-app");

  app.on("second-instance", () => shell?.show());
  app.on("activate", () => shell?.show());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.whenReady().then(() => {
    const store = new ElectronProfileStore();
    const supervisor = new LocalGatewaySupervisor({
      runtime: () =>
        resolveGatewayRuntime({
          isPackaged: app.isPackaged,
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          execPath: process.execPath,
        }),
    });
    const gateway = new GatewayController({
      store,
      supervisor,
      probe: probeGateway,
      appVersion: app.getVersion(),
    });
    controller = gateway;

    const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
    shell = createShellWindow({
      preloadPath: path.join(__dirname, "../preload/index.mjs"),
      rendererFile: path.join(__dirname, "../renderer/index.html"),
      ...(rendererUrl !== undefined && rendererUrl !== "" ? { rendererUrl } : {}),
    });

    registerShellIpc({ controller: gateway, shell });

    const actions: ShellMenuActions = {
      switchProfile: (id) => void gateway.switchProfile(id),
      manage: () => {
        gateway.setSheetOpen(true);
        shell?.show();
      },
      restart: () => void gateway.restart(),
      openInBrowser: () => {
        const url = gateway.lastEntryUrl();
        if (url !== undefined) shell?.openExternal(url);
      },
      reload: () => shell?.reloadContent(),
      toggleDevTools: () => shell?.toggleDevTools(),
    };

    gateway.subscribe((event) => {
      if (event.type === "navigate") shell?.loadGateway(event.url);
      if (event.type === "status" && (event.status.state === "starting" || event.status.state === "offline")) {
        // A failed switch must not leave the previous gateway's UI live: the
        // bar would name the new profile while the old one still serves every
        // request under its stale allow-list.
        shell?.clearGateway();
      }
      syncShell(gateway.getState(), actions);
    });

    syncShell(gateway.getState(), actions);
    void gateway
      .init()
      .catch((error: unknown) => {
        console.error("gateway init failed:", error);
      })
      .finally(() => syncShell(gateway.getState(), actions));

    const smokeDir = process.env["VOLTO_DESKTOP_SMOKE"];
    if (smokeDir !== undefined && smokeDir !== "" && shell !== undefined) {
      void runSmoke({ shell, controller: gateway, outputDir: smokeDir }).catch((error: unknown) => {
        console.error("smoke failed:", error);
        app.exit(1);
      });
    }
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    const dispose = controller?.dispose() ?? Promise.resolve();
    void dispose.finally(() => app.quit());
  });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  start();
}
