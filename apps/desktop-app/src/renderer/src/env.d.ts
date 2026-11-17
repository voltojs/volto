import type { ShellApi } from "@shared/gateway";

declare global {
  interface Window {
    voltoShell: ShellApi;
    __VOLTO_SURFACE__?: string;
    __TAURI_INTERNALS__?: unknown;
  }
}

export {};