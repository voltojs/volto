/**
 * Edge FileSystem implementation.
 * Uses an abstract object storage interface (compatible with R2, S3, KV).
 * Falls back to in-memory storage when no backend is provided.
 */

import type {
  FileSystem,
  FileReadResult,
  FileStat,
  FileListResult,
  FileGlobResult,
  FileGrepResult,
} from "@volto/core";

export interface ObjectStorageBackend {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface EdgeFileSystemOptions {
  /** Object storage backend (R2/S3/KV); defaults to in-memory Map */
  backend?: ObjectStorageBackend;
  /** Root prefix for all keys */
  root?: string;
}

function createMemoryBackend(): ObjectStorageBackend {
  const store = new Map<string, string>();
  return {
    async get(key) { return store.get(key); },
    async put(key, value) { store.set(key, value); },
    async list(prefix) {
      return [...store.keys()].filter((k) => !prefix || k.startsWith(prefix));
    },
    async delete(key) { store.delete(key); },
  };
}

export function createEdgeFileSystem(opts: EdgeFileSystemOptions = {}): FileSystem {
  const backend = opts.backend ?? createMemoryBackend();
  const root = opts.root ?? "";

  function fullPath(p: string): string {
    const clean = p.replace(/^\/+/, "");
    return root ? `${root}/${clean}` : clean;
  }

  return {
    async read(path: string, offset?: number, limit?: number): Promise<FileReadResult> {
      const key = fullPath(path);
      const content = await backend.get(key);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit !== undefined ? Math.min(totalLines, start + limit) : totalLines;
      return {
        content: lines.slice(start, end).join("\n"),
        totalLines,
        truncated: end < totalLines,
      };
    },

    async write(path: string, data: string): Promise<void> {
      await backend.put(fullPath(path), data);
    },

    async stat(path: string): Promise<FileStat> {
      const key = fullPath(path);
      const content = await backend.get(key);
      if (content === undefined) throw new Error(`Not found: ${path}`);
      // Check if it's a "directory" by listing keys with this prefix
      const entries = await backend.list(key + "/");
      return {
        path: "/" + key,
        isDirectory: entries.length > 0 && content === undefined,
        size: content.length,
        mtime: Date.now(),
      };
    },

    async list(dir: string): Promise<FileListResult> {
      const prefix = fullPath(dir);
      const allKeys = await backend.list(prefix ? prefix + "/" : "");
      const entries = allKeys.map((key) => {
        const relative = key.slice(prefix.length + 1);
        const name = relative.split("/")[0] ?? key;
        return {
          name,
          path: "/" + key,
          isDirectory: relative.includes("/"),
        };
      });
      // Deduplicate directory names
      const seen = new Set<string>();
      const deduped = entries.filter((e) => {
        if (seen.has(e.name)) return false;
        seen.add(e.name);
        return true;
      });
      return { entries: deduped };
    },

    async glob(pattern: string): Promise<FileGlobResult> {
      const allKeys = await backend.list();
      const paths = allKeys
        .map((k) => "/" + k)
        .filter((p) => matchGlob(pattern, p));
      return { paths };
    },

    async grep(
      query: string,
      opts?: { path?: string; glob?: string; limit?: number },
    ): Promise<FileGrepResult> {
      const limit = opts?.limit ?? 100;
      const allKeys = await backend.list();
      const matches: Array<{ path: string; line: number; text: string }> = [];

      for (const key of allKeys) {
        if (matches.length >= limit) break;
        const path = "/" + key;
        if (opts?.path && !path.startsWith(opts.path)) continue;
        if (opts?.glob && !matchGlob(opts.glob, path)) continue;

        const content = await backend.get(key);
        if (!content) continue;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= limit) break;
          if (lines[i]!.includes(query)) {
            matches.push({ path, line: i + 1, text: lines[i]! });
          }
        }
      }
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
