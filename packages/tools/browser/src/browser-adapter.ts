/**
 * BrowserAdapter — the tool-facing contract for one live browser page.
 *
 * Implementations own a Playwright page (or another backend) and return
 * snapshots that already carry refs. Tools never see selectors or handles.
 */

import type {
  ActionOutcome,
  BrowserState,
  DiagnosticsOutcome,
  SnapshotOutcome,
  StorageStateOutcome,
} from "./snapshot.js";

export const CAP_BROWSER_CONTROL = "browser:control";

export interface BrowserClickOptions {
  button?: "left" | "right";
  clickCount?: 1 | 2;
}

export interface BrowserTypeOptions {
  submit?: boolean;
}

export interface BrowserWaitOptions {
  text?: string;
  timeoutMs?: number;
}

export interface BrowserScreenshot {
  /** Base64-encoded PNG. */
  data: string;
  width: number;
  height: number;
}

export interface BrowserDiagnosticsOptions {
  kind: "console" | "network";
  level?: "error" | "warning" | "info";
  limit?: number;
}

export interface BrowserAdapter {
  /** Current page identity and status. */
  state(): Promise<BrowserState>;
  navigate(url: string): Promise<ActionOutcome>;
  goBack(): Promise<ActionOutcome>;
  goForward(): Promise<ActionOutcome>;
  reload(): Promise<ActionOutcome>;
  /** Read the page structure; refs are valid until the next page change. */
  snapshot(opts?: { textOnly?: boolean }): Promise<SnapshotOutcome>;
  click(ref: string, opts?: BrowserClickOptions): Promise<ActionOutcome>;
  type(ref: string, text: string, opts?: BrowserTypeOptions): Promise<ActionOutcome>;
  pressKey(key: string): Promise<ActionOutcome>;
  waitFor(opts: BrowserWaitOptions): Promise<ActionOutcome>;
  screenshot(opts?: { fullPage?: boolean }): Promise<BrowserScreenshot>;
  diagnostics(opts: BrowserDiagnosticsOptions): Promise<DiagnosticsOutcome>;
  /** Persist the current context's cookies/localStorage to the configured path. */
  storageState(action: "save"): Promise<StorageStateOutcome>;
}