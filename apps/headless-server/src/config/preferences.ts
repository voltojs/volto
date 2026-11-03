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
import { DEFAULT_LOCALE, isLocale, type Locale } from "@volto/i18n";

export { isLocale };
export type { Locale };

/** Color scheme the Web shell renders in; "system" follows the OS. */
export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

/** How much execution detail the chat feed shows. */
export const STREAM_DENSITIES = ["detailed", "concise"] as const;
export type StreamDensity = (typeof STREAM_DENSITIES)[number];

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

function isStreamDensity(value: unknown): value is StreamDensity {
  return typeof value === "string" && (STREAM_DENSITIES as readonly string[]).includes(value);
}

/** Opaque ids: the server never interprets them, only hands them back. */
export interface Preferences {
  /**
   * Language for user-facing copy, shared by the Web UI and the server's own
   * rendered text (native dialogs, CLI). Absent = follow the client's
   * Accept-Language, then "zh".
   */
  locale?: Locale;
  /** Color scheme for the Web shell. Absent = follow the OS. */
  theme?: Theme;
  /** Execution-detail level for the chat feed. Absent = "detailed". */
  streamDensity?: StreamDensity;
  /** Permission tier for a new session ("ask", "read-only", …). */
  defaultPermissionMode?: string;
  /** Last provider/model the user picked, applied to a new session. */
  lastProviderId?: string;
  lastModelId?: string;
  /** Last reasoning-effort id, for the model above. */
  lastReasoningEffort?: string;
  /**
   * Model used to name new sessions. Absent/empty = truncate the first
   * message instead. Stored as strings so this domain stays all-flat.
   */
  titleProviderId?: string;
  titleModelId?: string;
}

export interface PreferencesStore {
  get(): Promise<Preferences>;
  patch(next: Preferences): Promise<Preferences>;
}

/** The pre-unification file, retained for migration and documentation. */
export function preferencesPath(dir: string = getConfigDir()): string {
  return path.join(dir, "preferences.json");
}

/** The opaque-string preferences; `locale` is the one field with a domain. */
type StringPreferenceKey = Exclude<keyof Preferences, "locale" | "theme" | "streamDensity">;

/**
 * Keeps only the fields this domain owns and only values it can honour: the
 * opaque strings, plus a locale from `LOCALES`. Unknown keys and unsupported
 * values are dropped on read *and* on write, so a hand-edited document or a
 * bad request cannot smuggle them into a later write.
 */
function normalizePreferences(raw: unknown): Preferences {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: Preferences = {};
  const str = (key: StringPreferenceKey): void => {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  };
  str("defaultPermissionMode");
  str("lastProviderId");
  str("lastModelId");
  str("lastReasoningEffort");
  str("titleProviderId");
  str("titleModelId");
  const locale = record["locale"];
  if (isLocale(locale)) out.locale = locale;
  const theme = record["theme"];
  if (isTheme(theme)) out.theme = theme;
  const density = record["streamDensity"];
  if (isStreamDensity(density)) out.streamDensity = density;
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
      // An unsupported value is ignored, not written: dropping it here keeps
      // the previously stored value instead of normalize() erasing the key.
      if (key === "locale" && !isLocale(value)) continue;
      if (key === "theme" && !isTheme(value)) continue;
      if (key === "streamDensity" && !isStreamDensity(value)) continue;
      if (key in current || value !== undefined) {
        (next as Record<string, unknown>)[key] = value;
      }
    }
    return normalizePreferences(next);
  });
}

/** The locale the server renders its own copy in: the stored preference, else
 * the product default. One read per request keeps a language switch immediate
 * without caching a value that can go stale. */
export async function activeLocale(dir: string = getConfigDir()): Promise<Locale> {
  const preferences = await readPreferences(dir);
  return preferences.locale ?? DEFAULT_LOCALE;
}
