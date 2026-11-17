/**
 * The only bridge between the local shell page and the main process.
 *
 * Every handler refuses senders other than `shellView` — the gateway content
 * view has no preload at all, but the sender check keeps a compromised local
 * page (or a future extra view) from reaching the controller.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { ProfileDraft } from "@shared/gateway";

import type { GatewayController } from "../gateway/controller";
import type { ShellWindow } from "./window";

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

const HTTP_URL = /^https?:\/\//i;

export function registerShellIpc(options: {
  controller: GatewayController;
  shell: ShellWindow;
}): void {
  const { controller, shell } = options;
  const isTrusted = (event: IpcMainInvokeEvent): boolean =>
    event.sender === shell.shellView.webContents;

  const handle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrusted(event)) throw new Error("Untrusted sender");
      try {
        return await handler(event, ...args);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    });
  };

  handle("shell:get-state", () => controller.getState());
  handle("shell:save-profile", (_event, draft) => controller.saveProfile(draft as ProfileDraft));
  handle("shell:remove-profile", (_event, id) => controller.removeProfile(String(id)));
  handle("shell:switch-profile", (_event, id) => controller.switchProfile(String(id)));
  handle("shell:restart", () => controller.restart());
  handle("shell:retry", () => controller.retry());
  handle("shell:set-sheet", (_event, open) => controller.setSheetOpen(open === true));
  handle("shell:reload", () => shell.reloadContent());
  handle("shell:open-in-browser", () => {
    const url = controller.lastEntryUrl();
    if (url !== undefined) shell.openExternal(url);
  });
  handle("shell:open-external", async (_event, url) => {
    const target = typeof url === "string" ? url : "";
    if (!HTTP_URL.test(target)) return;
    shell.openExternal(target);
  });
}