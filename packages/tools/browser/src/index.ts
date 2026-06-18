/**
 * @volto/tools-browser — browser/computer-use tools
 *
 * BrowserAdapter provides the runtime capabilities; these tools
 * wrap it with defineTool and capability gating.
 */

export type { BrowserAdapter } from "./browser-adapter.js";
export { CAP_BROWSER_CONTROL } from "./browser-adapter.js";
export {
  createBrowserNavigateTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserScreenshotTool,
  createBrowserGetPageTextTool,
  BROWSER_TOOL_NAMES,
} from "./browser-tools.js";
