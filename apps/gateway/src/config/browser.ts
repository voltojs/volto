/**
 * Browser settings — `config.json` → `browser`.
 *
 * Optional: an absent section keeps the agent browser enabled and launches it
 * headless (`headless: true` is the default here, so the gateway's
 * display-less hosts work without extra config). Set `headless: false` to
 * watch a debugging session; that needs a display, so it fails on a
 * display-less Linux host. Unknown keys and wrong types are rejected so a
 * typo cannot silently change the launch behavior.
 */

import {
  detectSystemBrowsers,
  resolveBrowserExecutable,
  type SystemBrowser,
} from "@voltojs/runtime-node";
import { ConfigCorruptError } from "./io.js";
import { getConfigStore } from "./store.js";

export interface BrowserSettings {
  enabled: boolean;
  /** Defaults to background headless; explicit false opens a visible window. */
  headless?: boolean;
  idleTimeoutMs: number;
  storageStatePath?: string;
  executablePath?: string;
}

export class BrowserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserConfigError";
  }
}

/** The request named a path volto cannot launch (missing/empty/directory). */
export class BrowserPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPathError";
  }
}

const BROWSER_KEYS = ["enabled", "headless", "idleTimeoutMs", "storageStatePath", "executablePath"] as const;

function asBoolean(key: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new BrowserConfigError(`config.json: browser.${key} must be a boolean`);
  }
  return value;
}

function asPositiveInteger(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BrowserConfigError(`config.json: browser.${key} must be a positive integer`);
  }
  return value;
}

function asPath(key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrowserConfigError(`config.json: browser.${key} must be a non-empty string`);
  }
  return value;
}

/** Load and validate the optional browser section. */
export async function loadBrowserConfig(configDir: string): Promise<BrowserSettings> {
  let section: unknown;
  try {
    section = (await getConfigStore(configDir).read())["browser"];
  } catch (err) {
    if (err instanceof ConfigCorruptError) {
      throw new BrowserConfigError(
        `config.json could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }

  const settings: BrowserSettings = {
    enabled: true,
    headless: true,
    idleTimeoutMs: 600_000,
  };
  if (section === undefined) return settings;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new BrowserConfigError("config.json: browser must be a JSON object");
  }

  const record = section as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(BROWSER_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new BrowserConfigError(
      `config.json: browser has unknown key(s): ${unknown.join(", ")} — expected ${BROWSER_KEYS.join(" / ")}`,
    );
  }
  if (record["enabled"] !== undefined) settings.enabled = asBoolean("enabled", record["enabled"]);
  if (record["headless"] !== undefined) settings.headless = asBoolean("headless", record["headless"]);
  if (record["idleTimeoutMs"] !== undefined) {
    settings.idleTimeoutMs = asPositiveInteger("idleTimeoutMs", record["idleTimeoutMs"]);
  }
  if (record["storageStatePath"] !== undefined) {
    settings.storageStatePath = asPath("storageStatePath", record["storageStatePath"]);
  }
  if (record["executablePath"] !== undefined) {
    settings.executablePath = asPath("executablePath", record["executablePath"]);
  }
  return settings;
}


/** Everything the settings page needs, without exposing unrelated config. */
export interface BrowserSettingsView {
  platform: NodeJS.Platform;
  configuredPath: string | null;
  resolvedPath: string | null;
  browsers: SystemBrowser[];
}

/** Read the current browser settings plus the browsers installed on the gateway. */
export async function readBrowserSettingsView(configDir: string): Promise<BrowserSettingsView> {
  const settings = await loadBrowserConfig(configDir);
  const browsers = await detectSystemBrowsers();
  const resolved = await resolveBrowserExecutable({
    ...(settings.executablePath !== undefined ? { configured: settings.executablePath } : {}),
  });
  return {
    platform: process.platform,
    configuredPath: settings.executablePath ?? null,
    resolvedPath: resolved ?? null,
    browsers,
  };
}

/**
 * Set or clear `browser.executablePath` in config.json, preserving every
 * other key in that section. The host is not reloaded; the caller tells the
 * user a gateway restart is required.
 */
export async function updateBrowserExecutablePath(
  configDir: string,
  executablePath: string | null,
): Promise<BrowserSettings> {
  // Validate the existing document before touching it: a malformed section
  // must fail the request without being partially rewritten.
  await loadBrowserConfig(configDir);

  let nextPath: string | null = null;
  if (executablePath !== null) {
    const trimmed = executablePath.trim();
    if (trimmed === "") {
      throw new BrowserPathError("browser.executablePath must not be empty");
    }
    if ((await resolveBrowserExecutable({ configured: trimmed })) === undefined) {
      throw new BrowserPathError(
        `browser.executablePath is not an existing executable: ${trimmed}`,
      );
    }
    nextPath = trimmed;
  }

  await getConfigStore(configDir).update<Record<string, unknown>>("browser", (current) => {
    if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
      throw new BrowserConfigError("config.json: browser must be a JSON object");
    }
    const next: Record<string, unknown> = { ...(current ?? {}) };
    if (nextPath === null) delete next["executablePath"];
    else next["executablePath"] = nextPath;
    return next;
  });

  return loadBrowserConfig(configDir);
}
