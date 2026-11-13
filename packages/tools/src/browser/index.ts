/**
 * @voltojs/tools-browser — agent browser automation tools.
 *
 * BrowserAdapter provides the runtime capabilities; these tools wrap it
 * with defineTool and capability gating.
 */

export type {
  BrowserAdapter,
  BrowserClickOptions,
  BrowserDiagnosticsOptions,
  BrowserScreenshot,
  BrowserTypeOptions,
  BrowserWaitOptions,
} from "./browser-adapter.js";
export { CAP_BROWSER_CONTROL } from "./browser-adapter.js";
export type {
  ActionOutcome,
  BrowserState,
  DiagnosticsOutcome,
  FormatSnapshotOptions,
  SnapshotNode,
  SnapshotOutcome,
  StorageStateOutcome,
} from "./snapshot.js";
export { formatSnapshot, SNAPSHOT_SCRIPT } from "./snapshot.js";
export {
  createBrowserNavigateTool,
  createBrowserSnapshotTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserPressKeyTool,
  createBrowserWaitForTool,
  createBrowserScreenshotTool,
  createBrowserDiagnosticsTool,
  createBrowserStorageStateTool,
  BROWSER_TOOL_NAMES,
  type BrowserScreenshotToolOptions,
} from "./browser-tools.js";
