/**
 * Browser FileSystem implementation.
 * Uses in-memory virtual filesystem (portable, no OPFS dependency).
 * Can be extended to use OPFS when available.
 */

import type {
  FileSystem,
  FileReadResult,
  FileStat,
  FileListResult,
  FileGlobResult,
  FileGrepResult,
} from "@agent-core/core";

interface VirtualNode {
  type: "file" | "directory";
  content?: string;
  children?: Map<string, VirtualNode>;
  mtime: number;
  size: number;
}

export interface BrowserFileSystemOptions {
  /** Virtual root directory name (for display) */
  root?: string;
}

export function createBrowserFileSystem(_opts: BrowserFileSystemOptions = {}): FileSystem {
  const root: VirtualNode = {
    type: "directory",
    children: new Map(),
    mtime: Date.now(),
    size: 0,
  };

  function resolveNode(pathParts: string[]): VirtualNode | undefined {
    let current = root;
    for (const part of pathParts) {
      if (part === "" || part === ".") continue;
      if (part === "..") return undefined;
      if (!current.children) return undefined;
      const child = current.children.get(part);
      if (!child) return undefined;
      current = child;
    }
    return current;
  }

  function parsePath(p: string): string[] {
    return p.split("/").filter((s) => s.length > 0);
  }

  function ensureParent(pathParts: string[]): VirtualNode {
    let current = root;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i]!;
      if (!current.children) current.children = new Map();
      let child = current.children.get(part);
      if (!child) {
        child = { type: "directory", children: new Map(), mtime: Date.now(), size: 0 };
        current.children.set(part, child);
      }
      if (child.type !== "directory") throw new Error(`Not a directory: ${part}`);
      current = child;
    }
    return current;
  }

  function normalizePath(p: string): string {
    return "/" + parsePath(p).join("/");
  }

  return {
    async read(path: string, offset?: number, limit?: number): Promise<FileReadResult> {
      const parts = parsePath(path);
      const node = resolveNode(parts);
      if (!node || node.type !== "file" || node.content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      const lines = node.content.split(/\r?\n/);
      const totalLines = lines.length;
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit !== undefined ? Math.min(totalLines, start + limit) : totalLines;
      const selected = lines.slice(start, end);
      return {
        content: selected.join("\n"),
        totalLines,
        truncated: end < totalLines,
      };
    },

    async write(path: string, data: string): Promise<void> {
      const parts = parsePath(path);
      const parent = ensureParent(parts);
      const fileName = parts[parts.length - 1]!;
      if (!parent.children) parent.children = new Map();
      parent.children.set(fileName, {
        type: "file",
        content: data,
        mtime: Date.now(),
        size: data.length,
      });
    },

    async stat(path: string): Promise<FileStat> {
      const parts = parsePath(path);
      const node = resolveNode(parts);
      if (!node) throw new Error(`Not found: ${path}`);
      return {
        path: normalizePath(path),
        isDirectory: node.type === "directory",
        size: node.size,
        mtime: node.mtime,
      };
    },

    async list(dir: string): Promise<FileListResult> {
      const parts = parsePath(dir);
      const node = resolveNode(parts);
      if (!node || node.type !== "directory" || !node.children) {
        return { entries: [] };
      }
      const entries = [...node.children.entries()].map(([name, child]) => ({
        name,
        path: normalizePath(dir + "/" + name),
        isDirectory: child.type === "directory",
      }));
      return { entries };
    },

    async glob(pattern: string): Promise<FileGlobResult> {
      const results: string[] = [];
      function walk(node: VirtualNode, currentPath: string) {
        if (node.type === "file") {
          if (matchGlob(pattern, currentPath)) {
            results.push(currentPath);
          }
        }
        if (node.children) {
          for (const [name, child] of node.children) {
            walk(child, currentPath === "/" ? "/" + name : currentPath + "/" + name);
          }
        }
      }
      walk(root, "/");
      return { paths: results };
    },

    async grep(
      query: string,
      opts?: { path?: string; glob?: string; limit?: number },
    ): Promise<FileGrepResult> {
      const limit = opts?.limit ?? 100;
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const searchDir = opts?.path ? parsePath(opts.path) : [];

      function walk(node: VirtualNode, currentPath: string) {
        if (matches.length >= limit) return;
        if (node.type === "file" && node.content !== undefined) {
          if (opts?.glob && !matchGlob(opts.glob, currentPath)) return;
          const lines = node.content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= limit) return;
            const line = lines[i]!;
            if (line.includes(query)) {
              matches.push({ path: currentPath, line: i + 1, text: line });
            }
          }
        }
        if (node.children) {
          for (const [name, child] of node.children) {
            walk(child, currentPath === "/" ? "/" + name : currentPath + "/" + name);
          }
        }
      }

      const startNode = resolveNode(searchDir) ?? root;
      walk(startNode, opts?.path ?? "/");
      return { matches, truncated: matches.length >= limit };
    },
  };
}

function matchGlob(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/").filter((s) => s.length > 0);
  const pathParts = path.split("/").filter((s) => s.length > 0);
  return matchParts(patternParts, pathParts);
}

function matchParts(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [first, ...rest] = pattern;
  if (first === undefined) return path.length === 0;
  if (first === "**") {
    for (let i = 0; i <= path.length; i++) {
      if (matchParts(rest, path.slice(i))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  const [head, ...tail] = path;
  if (first === "*") return matchParts(rest, tail);
  if (head !== undefined && matchSinglePart(first, head)) return matchParts(rest, tail);
  return false;
}

function matchSinglePart(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return regex.test(value);
  }
  return pattern === value;
}
