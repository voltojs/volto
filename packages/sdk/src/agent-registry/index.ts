/**
 * Agent registry public surface: definition parsing plus multi-level scan.
 */

export { parseAgentFile } from "./frontmatter.js";
export type { ParsedAgentFile } from "./frontmatter.js";

export { scanAgentSources } from "./scan.js";
export type {
  AgentEntry,
  AgentScanResult,
  ScanAgentSourcesOptions,
} from "./scan.js";
