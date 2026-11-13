/**
 * Shared message catalog for copy the *server* produces.
 *
 * The gateway renders text for native dialogs and the CLI, and ships
 * `TextRef`s to the Web client for everything it cannot render itself. Both
 * sides resolve those refs through this module, so a server-emitted phrase is
 * translated once. Pure functions, no I/O, no framework: safe to import from
 * the gateway process and from the browser bundle.
 */

import { en } from "./messages/en.js";
import { zh } from "./messages/zh.js";

/** The languages the product ships. */
export const LOCALES = ["zh", "en"] as const;

/** A shipped language tag. */
export type Locale = (typeof LOCALES)[number];

/** Language used when nothing else decides (missing preference, no header). */
export const DEFAULT_LOCALE: Locale = "zh";

/** A flat `key -> text` table. Keys are dotted, e.g. `server.fork.branchSuffix`. */
export type Catalog = Readonly<Record<string, string>>;

/** Values a catalog entry may interpolate. */
export type TextParams = Readonly<Record<string, string | number>>;

/**
 * A reference to catalog text, safe to persist and to send over the wire: the
 * rendering locale is the reader's, not the writer's.
 */
export interface TextRef {
  /** Catalog key. */
  key: string;
  /** Interpolated values, if the entry is templated. */
  params?: TextParams;
  /**
   * Text to show when the key is unknown to the reader's catalog — typically
   * the already-rendered string a producer stored before this contract
   * existed.
   */
  fallback?: string;
}

const CATALOGS: Record<Locale, Catalog> = { zh, en };

/** Narrows an arbitrary value (config file, request body) to a shipped locale. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The catalog for `locale`. */
export function catalog(locale: Locale): Catalog {
  return CATALOGS[locale];
}

/**
 * Renders `key` in `locale`, substituting `{name}` placeholders from `params`.
 * An unknown key renders as the key itself: a missing translation must stay
 * readable and must never throw inside a render path.
 */
export function t(locale: Locale, key: string, params?: TextParams): string {
  const entry = CATALOGS[locale][key];
  if (entry === undefined) return key;
  if (params === undefined) return entry;
  return entry.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * Narrows an untrusted value to a `TextRef`. Used where a client or a config
 * file may submit copy (routing-tier labels): a bare string is rejected so
 * every stored label carries either a key or an explicit fallback.
 */
export function isTextRef(value: unknown): value is TextRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["key"] !== "string" || record["key"].length === 0) return false;
  const params = record["params"];
  if (params !== undefined) {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return false;
    for (const entry of Object.values(params as Record<string, unknown>)) {
      if (typeof entry !== "string" && typeof entry !== "number") return false;
    }
  }
  const fallback = record["fallback"];
  if (fallback !== undefined && typeof fallback !== "string") return false;
  return true;
}

/**
 * First shipped locale named by an `Accept-Language` header, if any.
 *
 * Shared by the gateway (which has no client-side resolver) and the tests, so
 * "no stored preference" degrades to the browser's language instead of always
 * falling back to the default.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | undefined {
  if (typeof header !== "string") return undefined;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase() ?? "";
    const primary = tag.split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return undefined;
}
