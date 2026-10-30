/**
 * One on-disk JSON document for every user-level configuration domain.
 *
 * `~/.volto/config.json` replaces the per-domain files (preferences,
 * projects, providers, routing-tiers, permissions, hooks, lsp, egress).
 * Secrets (`key`, `auth-secret`), logs (`audit.jsonl`), and data
 * (sessions/, db/, attachments/, agents/, skills/) deliberately stay out.
 *
 * Guarantees:
 * - Reads fall back to the legacy per-domain files while a migration has not
 *   happened yet, so an upgrade never starts from an empty configuration.
 * - Writes are serialized per directory, then written to a temp file and
 *   renamed over the target. The previous valid document is kept as
 *   `config.json.bak` and used when `config.json` is corrupt.
 * - Unknown sections and unknown keys inside a section survive a write.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ConfigCorruptError, writeJsonFileAtomic } from "./io.js";
import { ensureConfigDir, getConfigDir } from "./paths.js";

export const CONFIG_VERSION = 1;

/** Sections of the unified document, in the order the legacy files defined them. */
export const LEGACY_FILES = {
  preferences: "preferences.json",
  projects: "projects.json",
  providers: "providers.json",
  routingTiers: "routing-tiers.json",
  permissions: "permissions.json",
  hooks: "hooks.json",
  lsp: "lsp.json",
  egress: "egress.json",
} as const;

export type ConfigSection = keyof typeof LEGACY_FILES;

export interface VoltoConfig {
  version: number;
  /** Kept loose on purpose: each domain store owns its own validation. */
  [section: string]: unknown;
}

export interface ConfigStore {
  readonly path: string;
  read(): Promise<VoltoConfig>;
  /**
   * Read-modify-write one section. Calls against the same directory run in
   * order, so two concurrent requests cannot overwrite each other's keys.
   */
  update<T>(
    section: ConfigSection,
    mutate: (current: T | undefined) => T | Promise<T>,
  ): Promise<T>;
}

const stores = new Map<string, ConfigStore>();
const writeChains = new Map<string, Promise<unknown>>();

function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(dir) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeChains.set(dir, next.then(() => undefined, () => undefined));
  return next;
}

async function readJsonRaw(filePath: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigCorruptError(filePath, err);
  }
}

/** Parses a config document, rejecting roots that cannot be a config object. */
async function readDocument(filePath: string): Promise<VoltoConfig | undefined> {
  const parsed = await readJsonRaw(filePath);
  if (parsed === undefined) return undefined;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigCorruptError(filePath, new Error("config root must be an object"));
  }
  const record = parsed as Record<string, unknown>;
  const version =
    typeof record["version"] === "number" ? record["version"] : CONFIG_VERSION;
  return { ...record, version };
}

/** Reads the legacy per-domain files into an in-memory document. */
async function readLegacy(dir: string): Promise<VoltoConfig> {
  const config: VoltoConfig = { version: CONFIG_VERSION };
  for (const [section, file] of Object.entries(LEGACY_FILES)) {
    const value = await readJsonRaw(path.join(dir, file));
    if (value !== undefined) config[section] = value;
  }
  return config;
}

export function getConfigStore(dir: string = getConfigDir()): ConfigStore {
  const root = path.resolve(dir);
  const cached = stores.get(root);
  if (cached !== undefined) return cached;

  const configPath = path.join(root, "config.json");
  const backupPath = `${configPath}.bak`;

  async function readCurrent(): Promise<VoltoConfig | undefined> {
    try {
      return await readDocument(configPath);
    } catch (err) {
      if (!(err instanceof ConfigCorruptError)) throw err;
      // A damaged document must not lose a good backup; prefer the backup
      // and leave the damaged file in place for inspection.
      const backup = await readDocument(backupPath).catch(() => undefined);
      if (backup === undefined) throw err;
      console.warn(
        `config.json could not be parsed; using config.json.bak (${configPath})`,
      );
      return backup;
    }
  }

  const store: ConfigStore = {
    path: configPath,
    async read() {
      const current = await readCurrent();
      if (current !== undefined) return current;
      return readLegacy(root);
    },
    async update<T>(
      section: ConfigSection,
      mutate: (current: T | undefined) => T | Promise<T>,
    ): Promise<T> {
      return withDirLock(root, async () => {
        const base = await store.read();
        const next = await mutate(base[section] as T | undefined);
        const nextConfig: VoltoConfig = {
          ...base,
          version: CONFIG_VERSION,
          [section]: next,
        };
        await ensureConfigDir(root);
        // Keep the last readable document (not the damaged one) as the
        // backup, so a corrupt write cannot destroy the only good copy.
        const current = await readCurrent();
        if (current !== undefined) {
          await writeJsonFileAtomic(backupPath, current);
        }
        await writeJsonFileAtomic(configPath, nextConfig);
        return next;
      });
    },
  };
  stores.set(root, store);
  return store;
}

/**
 * One-shot migration of the legacy per-domain files into `config.json`.
 *
 * Returns true only when it actually wrote a document. An unreadable legacy
 * file is skipped with a warning rather than blocking gateway startup — the
 * domains that can be read still migrate. Legacy files are left untouched so
 * deleting `config.json` remains a rollback path.
 */
export async function ensureConfigMigrated(dir: string = getConfigDir()): Promise<boolean> {
  const configPath = path.join(dir, "config.json");
  try {
    await fs.access(configPath);
    return false;
  } catch {
    // Missing: continue with the migration.
  }

  const config: VoltoConfig = { version: CONFIG_VERSION };
  let found = false;
  for (const [section, file] of Object.entries(LEGACY_FILES)) {
    try {
      const value = await readJsonRaw(path.join(dir, file));
      if (value !== undefined) {
        config[section] = value;
        found = true;
      }
    } catch (err) {
      console.warn(
        `skipping unreadable legacy config ${file}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (!found) return false;

  await ensureConfigDir(dir);
  await writeJsonFileAtomic(configPath, config);
  return true;
}
