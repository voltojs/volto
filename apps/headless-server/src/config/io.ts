/**
 * Shared JSON file I/O for the `~/.volto/` config registries (projects,
 * providers). Centralised so both registries get the same two guarantees:
 *
 * 1. A missing file reads as "empty" (first run), but a file that exists and
 *    fails to parse is a hard error, not silently treated as empty. The old
 *    `catch { return [] }` behaviour meant one corrupt file, combined with
 *    `writeAll([...(await readAll()), item])`, turned the next write into a
 *    full data-loss event: the "empty" read plus one new item became the
 *    entire persisted array, discarding everything that was there before.
 * 2. Writes are atomic: written to a temp file in the same directory, then
 *    renamed into place. `rename` within one filesystem is atomic, so a
 *    crash mid-write can never leave the target file partially written
 *    (which is exactly the kind of corruption case (1) now has to guard
 *    against).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Thrown when a config file exists but its contents are not valid JSON. */
export class ConfigCorruptError extends Error {
  constructor(
    public readonly filePath: string,
    cause: unknown,
  ) {
    super(
      `Config file exists but could not be parsed as JSON: ${filePath}. ` +
        `Refusing to treat it as empty — that would silently discard its contents on the next write.`,
    );
    this.name = "ConfigCorruptError";
    this.cause = cause;
  }
}

/**
 * Read and JSON-parse a config file.
 *
 * - File does not exist (`ENOENT`) → returns `fallback` (first run).
 * - File exists but is not valid JSON → throws `ConfigCorruptError`.
 * - Any other read error (permissions, etc.) → rethrown as-is.
 */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new ConfigCorruptError(filePath, err);
  }
}

/**
 * Write JSON to `filePath` atomically: write to a temp file in the same
 * directory, then `rename` over the target. The caller must ensure the
 * directory exists first.
 */
export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename never happened.
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}
