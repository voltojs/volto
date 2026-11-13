/**
 * File-based SessionStore implementation.
 * Persists snapshots as JSON files in a directory.
 */

import type { SessionStore, SessionSnapshot } from "@voltojs/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FileStoreOptions {
  /** Directory to store session files */
  directory: string;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export function createStore(opts: FileStoreOptions): SessionStore {
  const { directory } = opts;

  async function ensureDir(): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
  }

  function filePath(id: string): string {
    // Sanitize ID to prevent path traversal
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(directory, `${safe}.json`);
  }

  return {
    async save(snapshot: SessionSnapshot): Promise<void> {
      await ensureDir();
      const target = filePath(snapshot.id);
      const tmp = `${target}.tmp.${process.pid}`;
      const data = JSON.stringify(snapshot, null, 2);
      await fs.writeFile(tmp, data, "utf-8");
      await fs.rename(tmp, target);
    },

    async load(id: string): Promise<SessionSnapshot | undefined> {
      try {
        const data = await fs.readFile(filePath(id), "utf-8");
        return JSON.parse(data) as SessionSnapshot;
      } catch (err: unknown) {
        if (isEnoent(err)) return undefined;
        throw err;
      }
    },

    async list(): Promise<SessionSnapshot[]> {
      await ensureDir();
      const files = await fs.readdir(directory);
      const snapshots: SessionSnapshot[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = await fs.readFile(path.join(directory, file), "utf-8");
          snapshots.push(JSON.parse(data) as SessionSnapshot);
        } catch {
          // Skip corrupted or unreadable files in listing
        }
      }

      return snapshots;
    },
  };
}
