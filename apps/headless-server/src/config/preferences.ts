/**
 * User-level defaults that outlive a session: which permission mode, model
 * and reasoning effort the *next* conversation should start with.
 *
 * These are deliberately not per-session: the session already stores its own
 * copy (and the transcript records what a turn actually ran with). This file
 * only answers "what should a fresh conversation pre-select", which is why a
 * missing or corrupt file degrades to empty defaults instead of failing the
 * gateway — a preference is never worth blocking on.
 */

import * as path from "node:path";
import { getConfigDir } from "./paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./io.js";

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

export function preferencesPath(dir: string = getConfigDir()): string {
  return path.join(dir, "preferences.json");
}

/**
 * Reads the preferences object.
 *
 * Unknown keys are dropped rather than persisted, so a hand-edited file
 * cannot smuggle arbitrary data into later writes.
 */
export async function readPreferences(dir: string = getConfigDir()): Promise<Preferences> {
  const raw = await readJsonFile<Record<string, unknown>>(preferencesPath(dir), {});
  const out: Preferences = {};
  const str = (key: keyof Preferences): void => {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  };
  str("defaultPermissionMode");
  str("lastProviderId");
  str("lastModelId");
  str("lastReasoningEffort");
  return out;
}

/** Merges a patch over the current file and rewrites it atomically. */
export async function patchPreferences(
  patch: Preferences,
  dir: string = getConfigDir(),
): Promise<Preferences> {
  const current = await readPreferences(dir);
  const next: Preferences = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key in current || value !== undefined) {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  await writeJsonFileAtomic(preferencesPath(dir), next);
  return next;
}
