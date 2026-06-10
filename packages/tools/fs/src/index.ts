// @agent-core/tools-fs — re-exports from tools-common for backward compatibility
// + fs-specific tool definitions

export { defineTool as defineFileTool } from "@agent-core/tools-common";
export type { Tool as FileTool, ToolHandler } from "@agent-core/tools-common";
export { createReadFileTool } from "./read-file.js";
export { createEditFileTool, computeFuzzyMatchRegex, findFuzzyMatch, preserveIndentation } from "./edit-file.js";
export { createWriteFileTool } from "./write-file.js";
export { createApplyPatchTool } from "./apply-patch.js";
export { createMultiEditTool } from "./multi-edit.js";
export { createLsTool } from "./ls.js";
export { createGlobTool } from "./glob.js";
export { createGrepTool } from "./grep.js";
export { CAP_FS_READ, CAP_FS_WRITE } from "./capabilities.js";
export { FS_TOOL_NAMES } from "./tool-names.js";
