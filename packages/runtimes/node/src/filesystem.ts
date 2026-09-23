import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  FileSystem,
  FileReadResult,
  FileReadBytesResult,
  FileStat,
  FileListResult,
  FileGlobResult,
  FileGrepResult,
} from "@volto/core";
import { readImageDimensions } from "./image-dimensions.js";

const MAX_GREP_LIMIT = 500;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

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
    const rel = path.relative(root, resolved);
    // Escapes the workspace if the relative path climbs out (..) or is absolute.
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      // Keep "escapes the workspace boundary" as a stable substring (tests
      // and tool-layer messages match on it) while also stating the
      // outside-the-root fact the denial dialect checks for.
      throw new Error(
        `Path "${target}" escapes the workspace boundary (outside the workspace root).`,
      );
    }
    return resolved;
  }

  /** Stat several resolved paths and return them sorted by mtime (newest first). */
  async function sortByMtime(relPaths: string[]): Promise<string[]> {
    const withMtime = await Promise.all(
      relPaths.map(async (rel) => {
        try {
          const stats = await fs.stat(path.resolve(root, rel));
          return { rel, mtime: stats.mtimeMs };
        } catch {
          return { rel, mtime: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime.map((entry) => entry.rel);
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

    async readBytes(target): Promise<FileReadBytesResult> {
      // Same path policy as read(): resolveWithinRoot is the single
      // workspace-boundary check this adapter owns.
      const resolved = resolveWithinRoot(target);
      const bytes = await fs.readFile(resolved);
      const dims = readImageDimensions(bytes);
      const mimeType = MIME_BY_EXT[path.extname(resolved).toLowerCase()];
      return {
        data: bytes.toString("base64"),
        size: bytes.byteLength,
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(dims ?? {}),
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

    // The sanctioned escape hatch for raw-fs consumers (document parser):
    // absolute path + the same boundary denial every other method applies.
    async resolvePath(target): Promise<string> {
      return resolveWithinRoot(target);
    },

    async list(dir): Promise<FileListResult> {
      const resolved = resolveWithinRoot(dir);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const withMtime = await Promise.all(
        entries.map(async (entry) => {
          let mtime = 0;
          try {
            mtime = (await fs.stat(path.join(resolved, entry.name))).mtimeMs;
          } catch {
            mtime = 0;
          }
          return {
            entry: {
              name: entry.name,
              path: normalizeSeparators(path.join(dir, entry.name)),
              isDirectory: entry.isDirectory(),
            },
            mtime,
          };
        }),
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);
      return { entries: withMtime.map((item) => item.entry) };
    },

    async glob(pattern): Promise<FileGlobResult> {
      const { glob } = await import("node:fs/promises");
      const matches: string[] = [];
      for await (const entry of glob(pattern, { cwd: root })) {
        const rel = normalizeSeparators(path.relative(root, path.resolve(root, entry)));
        // Validate the resolved path stays within the workspace boundary.
        // Symlinks or patterns like "../*" could escape without this check.
        const resolved = path.resolve(root, entry);
        const checkRel = path.relative(root, resolved);
        if (checkRel === ".." || checkRel.startsWith(`..${path.sep}`) || path.isAbsolute(checkRel)) {
          continue;
        }
        matches.push(rel);
      }
      return { paths: await sortByMtime(matches) };
    },

    async grep(query, opts): Promise<FileGrepResult> {
      const limit = opts?.limit && opts.limit > 0 ? Math.min(opts.limit, MAX_GREP_LIMIT) : MAX_GREP_LIMIT;
      const searchPath = opts?.path ? resolveWithinRoot(opts.path) : root;

      // ripgrep, JSON output for robust parsing. `-e` + `--` guard against a
      // query/path that begins with `-` being misread as a flag.
      const args = ["--json"];
      if (opts?.glob) {
        args.push("-g", opts.glob);
      }
      args.push("-e", query, "--", searchPath);

      return await new Promise<FileGrepResult>((resolve, reject) => {
        const matches: FileGrepResult["matches"] = [];
        let stdout = "";
        let stderr = "";
        const child = spawn("rg", args, { cwd: root });

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf-8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf-8");
        });
        child.on("error", (error) => {
          reject(new Error(`grep failed to launch ripgrep (rg): ${error.message}`));
        });
        child.on("close", (code) => {
          for (const line of stdout.split("\n")) {
            if (!line.trim() || matches.length >= limit) continue;
            try {
              const event = JSON.parse(line) as {
                type: string;
                data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
              };
              if (event.type === "match" && event.data?.path?.text) {
                matches.push({
                  path: normalizeSeparators(path.relative(root, path.resolve(root, event.data.path.text))),
                  line: event.data.line_number ?? 0,
                  text: (event.data.lines?.text ?? "").replace(/\r?\n$/, ""),
                });
              }
            } catch {
              // skip non-JSON line
            }
          }
          // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
          if (code === 2 && matches.length === 0 && stderr.trim()) {
            reject(new Error(`grep (ripgrep) error: ${stderr.trim()}`));
            return;
          }
          resolve({ matches, truncated: matches.length >= limit });
        });
      });
    },
  };
}
