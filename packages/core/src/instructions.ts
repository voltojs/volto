/**
 * instructions.ts — Pure function for project instruction file loading.
 *
 * Recursively expands `@import` directives in instruction text files.
 * The pure function receives a "path → content" map (provided by FileSystem
 * port externally) and returns expanded text + reference graph.
 *
 * Rules:
 * - `@import` directive: a line starting with `@` followed by a relative path
 * - Expansion is recursive (nested @import)
 * - Cycle detection via visited set
 * - Path restriction: all imports must resolve within a given root directory
 * - Missing imports degrade to a visible placeholder (not an error)
 * - Layer priority: global < project (merged in order)
 */

export interface InstructionReference {
  /** Path that was imported */
  from: string;
  /** Path that was imported FROM */
  to: string;
}

export interface InstructionExpandResult {
  /** Expanded instruction text */
  text: string;
  /** Reference graph (for debugging / diagnostics) */
  references: InstructionReference[];
  /** Paths that were visited during expansion */
  visited: string[];
}

/**
 * Recursively expand @import directives in instruction text.
 *
 * @param fileContents - Map from file path to file content (provided by FileSystem port)
 * @param entryPath - The entry instruction file path to expand
 * @param rootDir - Root directory constraint (all imports must resolve within this)
 * @returns Expanded text + reference graph
 */
export function expandInstructions(
  fileContents: Map<string, string>,
  entryPath: string,
  rootDir: string,
): InstructionExpandResult {
  const references: InstructionReference[] = [];
  const visited = new Set<string>();

  const text = expandFile(fileContents, entryPath, rootDir, references, visited);

  return {
    text,
    references,
    visited: [...visited],
  };
}

function expandFile(
  fileContents: Map<string, string>,
  path: string,
  rootDir: string,
  references: InstructionReference[],
  visited: Set<string>,
): string {
  // Cycle detection
  if (visited.has(path)) {
    return `[circular import: ${path}]`;
  }
  visited.add(path);

  const content = fileContents.get(path);
  if (content === undefined) {
    return `[missing instruction file: ${path}]`;
  }

  const lines = content.split("\n");
  const expanded: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const importMatch = trimmed.match(/^@(.+)$/);
    if (importMatch?.[1] != null) {
      const importPath = normalizePath(importMatch[1], path);

      // Path restriction: must be within rootDir
      if (!isWithinRoot(importPath, rootDir)) {
        expanded.push(`[import out of scope: ${importPath}]`);
        continue;
      }

      references.push({ from: path, to: importPath });
      const importedText = expandFile(fileContents, importPath, rootDir, references, visited);
      expanded.push(importedText);
    } else {
      expanded.push(line);
    }
  }

  return expanded.join("\n");
}

/**
 * Merge instruction layers: global < project priority.
 *
 * @param layers - Array of expanded instruction texts, ordered by priority (lowest first)
 * @returns Merged instruction text
 */
export function mergeInstructionLayers(layers: string[]): string {
  return layers.filter((l) => l.length > 0).join("\n\n");
}

// ──────────────────────────────────────────────
// Path utilities
// ──────────────────────────────────────────────

/**
 * Normalize a relative import path against the importing file's directory.
 * Handles `./relative`, `../relative`, and bare paths.
 */
function normalizePath(importPath: string, fromPath: string): string {
  if (importPath.startsWith("/")) {
    return importPath;
  }

  const fromDir = fromPath.substring(0, fromPath.lastIndexOf("/"));
  const parts = [...fromDir.split("/"), ...importPath.split("/")];
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return "/" + resolved.join("/");
}

/**
 * Check if a path is within the root directory (or is the root itself).
 */
function isWithinRoot(path: string, rootDir: string): boolean {
  const normalizedRoot = rootDir.endsWith("/") ? rootDir : rootDir + "/";
  return path === rootDir || path.startsWith(normalizedRoot) || rootDir.startsWith(path + "/");
}
