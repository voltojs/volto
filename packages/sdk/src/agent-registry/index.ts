/**
 * Agent registry public surface: definition parsing, multi-level scan, and
 * the create/update/delete write layer.
 */

export { parseAgentFile } from "./frontmatter.js";
export type { ParsedAgentFile } from "./frontmatter.js";

export { scanAgentSources } from "./scan.js";
export type {
  AgentEntry,
  AgentScanResult,
  ScanAgentSourcesOptions,
} from "./scan.js";

export {
  BUILTIN_AGENTS,
  BUILTIN_EXPLORE,
  BUILTIN_GENERAL_PURPOSE,
  EXPLORE_NAME,
  GENERAL_PURPOSE_NAME,
  findBuiltInAgent,
} from "./builtin.js";

export { serializeAgentFile } from "./serialize.js";

export { createAgentStore } from "./store.js";
export type { AgentStore, CreateAgentStoreOptions } from "./store.js";
