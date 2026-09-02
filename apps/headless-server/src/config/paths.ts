/**
 * Resolution of the user-level config directory (`~/.volto`).
 *
 * The directory holds the encryption key plus the project and provider
 * configuration. It is created lazily with 0700 so its contents are not
 * world-readable.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Absolute path of the config directory. */
export function getConfigDir(): string {
  return process.env["VOLTO_CONFIG_DIR"] ?? path.join(os.homedir(), ".volto");
}

/** Absolute path of a file inside the config directory. */
export function getConfigPath(name: string, dir = getConfigDir()): string {
  return path.join(dir, name);
}

/** Create the config directory if it does not exist. */
export async function ensureConfigDir(dir = getConfigDir()): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}
