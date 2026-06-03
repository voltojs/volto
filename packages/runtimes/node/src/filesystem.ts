import fs from "node:fs/promises";
import path from "node:path";
import type {
  FileSystem,
  FileReadResult,
  FileStat,
  FileListResult,
  FileGlobResult,
  FileGrepResult,
} from "@agent-core/core";

const MAX_GREP_LIMIT = 500;

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

export interface NodeFileSystemOptions {
  root: string;
}

export function createNodeFileSystem(options: NodeFileSystemOptions): FileSystem {
  const root = path.resolve(options.root);

  function resolveWithinRoot(target: string): string {
    const resolved = path.resolve(root, target);
    if (!resolved.startsWith(root)) {
      throw new Error(`Path "${target}" escapes the workspace boundary.`);
    }
    return resolved;
  }

  return {
    async read(target, offset = 1, limit?): Promise<FileReadResult> {
      const resolved = resolveWithinRoot(target);
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        throw new Error(`read_file failed: ${target} is a directory.`);
      }

      const content = await fs.readFile(resolved, "utf-8");
      const lines = content.split(/\r?\n/);
      const clampedOffset = Math.max(1, Math.min(offset, lines.length));
      const sliced = limit ? lines.slice(clampedOffset - 1, clampedOffset - 1 + limit) : lines.slice(clampedOffset - 1);

      return {
        content: sliced.join("\n"),
        totalLines: lines.length,
        truncated: typeof limit === "number" ? clampedOffset - 1 + sliced.length < lines.length : false,
      };
    },

    async write(target, data): Promise<void> {
      const resolved = resolveWithinRoot(target);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, data, "utf-8");
    },

    async stat(target): Promise<FileStat> {
      const resolved = resolveWithinRoot(target);
      const stats = await fs.stat(resolved);
      return {
        path: normalizeSeparators(path.relative(root, resolved) || "."),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtimeMs,
      };
    },

    async list(dir): Promise<FileListResult> {
      const resolved = resolveWithinRoot(dir);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return {
        entries: entries.map((entry) => ({
          name: entry.name,
          path: normalizeSeparators(path.join(dir, entry.name)),
          isDirectory: entry.isDirectory(),
        })),
      };
    },

    async glob(pattern): Promise<FileGlobResult> {
      const { glob } = await import("node:fs/promises");
      const matches: string[] = [];
      for await (const entry of glob(pattern, { cwd: root })) {
        matches.push(normalizeSeparators(path.relative(root, path.resolve(root, entry))));
      }
      return { paths: matches };
    },

    async grep(query, opts): Promise<FileGrepResult> {
      const limit = opts?.limit && opts.limit > 0 ? Math.min(opts.limit, MAX_GREP_LIMIT) : MAX_GREP_LIMIT;
      const regex = new RegExp(query, "i");
      const matches: FileGrepResult["matches"] = [];

      async function walk(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= limit) {
            return;
          }
          const full = path.join(dir, entry.name);
          const relative = normalizeSeparators(path.relative(root, full));

          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }

          if (entry.isFile()) {
            const content = await fs.readFile(full, "utf-8");
            const lines = content.split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index] ?? "";
              if (regex.test(line)) {
                matches.push({ path: relative, line: index + 1, text: line });
                if (matches.length >= limit) {
                  return;
                }
              }
            }
          }
        }
      }

      await walk(root);
      return { matches, truncated: matches.length >= limit };
    },
  };
}
