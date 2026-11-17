import type { ShellApi } from "@shared/gateway";

declare global {
  interface Window {
    voltoShell: ShellApi;
  }
}

export {};