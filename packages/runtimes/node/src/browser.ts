/**
 * Node browser host entry point.
 *
 * The session-scoped host replaces the old single-page adapter; this module
 * stays as the stable import path for hosts that already reference it.
 */

export {
  BrowserUnavailableError,
  createNodeBrowserHost,
  createSerialQueue,
  expandHome,
  resolveHeadless,
} from "./browser-host.js";
export type {
  BrowserHost,
  BrowserHostOptions,
  LiveBrowserPage,
  PageOptions,
} from "./browser-host.js";
