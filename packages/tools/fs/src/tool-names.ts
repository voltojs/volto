/**
 * Tool-name sets for @volto/tools-fs.
 *
 * FS_TOOL_NAMES is the full export surface (visibility / docs / tests).
 * FS_EXECUTOR_TOOL_NAMES is the subset implemented by
 * createFsToolExecutor (FileSystem-backed). Watch tools are exported from
 * this package but call the FileWatcher port, not FileSystem — routing them
 * through the FS executor would yield "Unknown tool".
 */

/** All tool names exported by @volto/tools-fs */
export const FS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "edit_file",
  "write_file",
  "apply_patch",
  "multi_edit",
  "ls",
  "glob",
  "grep",
  "watch_files",
  "unwatch_files",
  "list_watches",
]);

/**
 * FileSystem-backed tools handled by createFsToolExecutor.
 * Deliberately excludes watch_files / unwatch_files / list_watches —
 * those are FileWatcher-backed and must route via customToolMap.
 */
export const FS_EXECUTOR_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "edit_file",
  "write_file",
  "apply_patch",
  "multi_edit",
  "ls",
  "glob",
  "grep",
]);
