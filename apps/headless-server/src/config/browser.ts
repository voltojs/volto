/**
 * Browser settings — `config.json` → `browser`.
 *
 * Optional: an absent section keeps the agent browser enabled with a headed
 * Chromium (Linux without a display falls back to headless in the host).
 * Unknown keys and wrong types are rejected so a typo cannot silently change
 * the launch behavior.
 */

import { ConfigCorruptError } from "./io.js";
import { getConfigStore } from "./store.js";

export interface BrowserSettings {
  enabled: boolean;
  headless: boolean;
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

const KEYS = ["enabled", "headless", "idleTimeoutMs", "storageStatePath", "executablePath"] as const;

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
    headless: false,
    idleTimeoutMs: 600_000,
  };
  if (section === undefined) return settings;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new BrowserConfigError("config.json: browser must be a JSON object");
  }

  const record = section as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new BrowserConfigError(
      `config.json: browser has unknown key(s): ${unknown.join(", ")} — expected ${KEYS.join(" / ")}`,
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
