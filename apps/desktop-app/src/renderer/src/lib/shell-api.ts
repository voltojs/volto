import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  ActionResult,
  ProfileDraft,
  ShellApi,
  ShellState,
} from "@shared/gateway";

/** Tauri commands reject with a plain string; the UI wants ActionResult. */
async function action<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  try {
    const state = await invoke<T>(command, args);
    return { ok: true, state: state as unknown as ShellState };
  } catch (error) {
    return { ok: false, error: typeof error === "string" ? error : String(error) };
  }
}

function fire(command: string, args?: Record<string, unknown>): Promise<void> {
  return invoke(command, args)
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error(command, error);
    });
}

export function createShellApi(): ShellApi {
  return {
    getState: () => invoke<ShellState>("get_state"),
    onState: (listener) => {
      let unlisten: (() => void) | undefined;
      void listen<ShellState>("shell:state", (event) => listener(event.payload)).then(
        (stop) => {
          unlisten = stop;
        },
      );
      return () => {
        unlisten?.();
      };
    },
    switchProfile: (id) => fire("switch_profile", { id }),
    saveProfile: (draft: ProfileDraft) => action("save_profile", { draft }),
    removeProfile: (id) => action("remove_profile", { id }),
    restart: () => fire("restart_gateway"),
    retry: () => fire("retry_gateway"),
    closeSettings: () => fire("close_settings"),
    reload: () => fire("reload"),
    openInBrowser: () => fire("open_in_browser"),
  };
}

/**
 * `pnpm dev:web` in a plain browser has no Tauri host; render the shell with a
 * synthetic state so layout work does not require the desktop app.
 */
export function createPreviewApi(): ShellApi {
  const state: ShellState = {
    profiles: [
      { id: "local", label: "本机网关", kind: "local", url: "", managed: true, hasToken: false },
    ],
    activeProfileId: "local",
    status: { state: "offline", profileId: "local", error: "预览模式：请在 Tauri 中运行" },
    theme: "system",
    locale: "zh",
    platform: "darwin",
    appVersion: "preview",
  };
  return {
    getState: async () => state,
    onState: () => () => undefined,
    switchProfile: async () => undefined,
    saveProfile: async () => ({ ok: false, error: "预览模式不能保存" }),
    removeProfile: async () => ({ ok: false, error: "预览模式不能删除" }),
    restart: async () => undefined,
    retry: async () => undefined,
    closeSettings: async () => undefined,
    reload: async () => undefined,
    openInBrowser: async () => undefined,
  };
}