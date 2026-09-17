// @volto/tools-fs — re-exports from tools-common for backward compatibility
// + fs-specific tool definitions

export { defineTool as defineFileTool } from "@volto/tools-common";
export type { Tool as FileTool, ToolHandler } from "@volto/tools-common";
export { createReadFileTool } from "./read-file.js";
export { createEditFileTool, computeFuzzyMatchRegex, findFuzzyMatch, preserveIndentation } from "./edit-file.js";
export { createWriteFileTool } from "./write-file.js";
export { createApplyPatchTool } from "./apply-patch.js";
export { createMultiEditTool } from "./multi-edit.js";
export { createLsTool } from "./ls.js";
export { createGlobTool } from "./glob.js";
export { createGrepTool } from "./grep.js";
export { createWatchFilesTool } from "./watch-files.js";
export { createUnwatchFilesTool } from "./unwatch-files.js";
export { createListWatchesTool } from "./list-watches.js";
export { CAP_FS_READ, CAP_FS_WRITE, CAP_FS_WATCH } from "./capabilities.js";
export { FS_TOOL_NAMES, FS_EXECUTOR_TOOL_NAMES } from "./tool-names.js";
