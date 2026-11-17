/**
 * Preload for the local shell page only. The gateway content view is created
 * without a preload, so this bridge never exists in a remote page.
 */

import { contextBridge, ipcRenderer } from "electron";

import type { ProfileDraft, ShellApi, ShellState } from "@shared/gateway";

const api: ShellApi = {
  getState: () => ipcRenderer.invoke("shell:get-state") as Promise<ShellState>,
  onState: (listener) => {
    const handler = (_event: unknown, state: ShellState): void => listener(state);
    ipcRenderer.on("shell:state", handler);
    return () => {
      ipcRenderer.removeListener("shell:state", handler);
    };
  },
  switchProfile: (id) => ipcRenderer.invoke("shell:switch-profile", id) as Promise<void>,
  saveProfile: (draft: ProfileDraft) => ipcRenderer.invoke("shell:save-profile", draft),
  removeProfile: (id) => ipcRenderer.invoke("shell:remove-profile", id),
  restart: () => ipcRenderer.invoke("shell:restart") as Promise<void>,
  retry: () => ipcRenderer.invoke("shell:retry") as Promise<void>,
  setSheetOpen: (open) => ipcRenderer.invoke("shell:set-sheet", open) as Promise<void>,
  reload: () => ipcRenderer.invoke("shell:reload") as Promise<void>,
  openInBrowser: () => ipcRenderer.invoke("shell:open-in-browser") as Promise<void>,
};

contextBridge.exposeInMainWorld("voltoShell", api);