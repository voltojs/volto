/**
 * User-level defaults that outlive a session: which permission mode, model
 * and reasoning effort the *next* conversation should start with.
 *
 * These are deliberately not per-session: the session already stores its own
 * copy (and the transcript records what a turn actually ran with). The values
 * live in `config.json` under `preferences`; a corrupt document degrades to
 * empty defaults instead of failing the gateway — a preference is never worth
 * blocking on.
 */

import * as path from "node:path";
import { getConfigDir } from "./paths.js";
import { ConfigCorruptError } from "./io.js";
import { getConfigStore } from "./store.js";

/** Opaque ids: the server never interprets them, only hands them back. */
export interface Preferences {
  /** Permission tier for a new session ("ask", "read-only", …). */
  defaultPermissionMode?: string;
  /** Last provider/model the user picked, applied to a new session. */
  lastProviderId?: string;
  lastModelId?: string;
  /** Last reasoning-effort id, for the model above. */
  lastReasoningEffort?: string;
}

export interface PreferencesStore {
  get(): Promise<Preferences>;
  patch(next: Preferences): Promise<Preferences>;
}

/** The pre-unification file, retained for migration and documentation. */
export function preferencesPath(dir: string = getConfigDir()): string {
  return path.join(dir, "preferences.json");
}

/**
 * Keeps only the string fields this domain owns. Unknown keys are dropped on
 * read, so a hand-edited document cannot smuggle arbitrary data into a later
 * write.
 */
function normalizePreferences(raw: unknown): Preferences {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: Preferences = {};
  const str = (key: keyof Preferences): void => {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  };
  str("defaultPermissionMode");
  str("lastProviderId");
  str("lastModelId");
  str("lastReasoningEffort");
  return out;
}

/** Reads the preferences object from the unified config. */
export async function readPreferences(dir: string = getConfigDir()): Promise<Preferences> {
  try {
    const config = await getConfigStore(dir).read();
    return normalizePreferences(config["preferences"]);
  } catch (err) {
    if (err instanceof ConfigCorruptError) return {};
    throw err;
  }
}

/** Merges a patch into the stored preferences under the config write lock. */
export async function patchPreferences(
  patch: Preferences,
  dir: string = getConfigDir(),
): Promise<Preferences> {
  return getConfigStore(dir).update<Preferences>("preferences", (stored) => {
    const current = normalizePreferences(stored);
    const next: Preferences = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (key in current || value !== undefined) {
        (next as Record<string, unknown>)[key] = value;
      }
    }
    return next;
  });
}
