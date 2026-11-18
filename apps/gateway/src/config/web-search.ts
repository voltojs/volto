/**
 * Web search settings — `config.json` → `webSearch`.
 *
 * The section holds one selected source plus a credential slot per builtin
 * source and a list of user-declared REST sources. Reading is lenient: a typo
 * degrades search (and reports a warning) instead of refusing to build
 * sessions — search is not a security boundary, unlike egress. Writing is
 * strict, so the settings page cannot persist a document the readers would
 * only warn about.
 *
 * Credentials live encrypted next to the rest of the gateway config
 * (`~/.volto/key`), and each source has its own slot: a key entered for
 * DeepSeek must never be sent to Brave's host just because the user switched
 * sources.
 */

import type { EndpointSourceSpec } from "@voltojs/tools/web";
import { createCipher } from "./crypto.js";
import { getConfigDir } from "./paths.js";
import { createProviderStore } from "./providers.js";
import { getConfigStore } from "./store.js";

export const BUILTIN_SOURCES = ["auto", "deepseek", "brave", "glm"] as const;

export interface BuiltinSlotConfig {
  apiKeyEnc: string | null;
  baseUrl: string | null;
}

export interface DeepSeekSlotConfig extends BuiltinSlotConfig {
  /** Model channel whose key is reused instead of `apiKeyEnc`. */
  sourceProviderId: string | null;
}

export interface CustomSearchSourceConfig {
  id: string;
  name: string;
  apiKeyEnc: string | null;
  endpoint: EndpointSourceSpec;
}

export interface WebSearchConfig {
  /** "auto" | a builtin name | a custom source id. */
  source: string;
  deepseek: DeepSeekSlotConfig;
  brave: BuiltinSlotConfig;
  glm: BuiltinSlotConfig;
  custom: CustomSearchSourceConfig[];
}

export interface WebSearchSettingsView {
  source: string;
  builtins: {
    deepseek: { apiKeyMasked: string | null; sourceProviderId: string | null; baseUrl: string | null };
    brave: { apiKeyMasked: string | null; baseUrl: string | null };
    glm: { apiKeyMasked: string | null; baseUrl: string | null };
  };
  custom: Array<{ id: string; name: string; method: string; url: string; apiKeyMasked: string | null }>;
  candidates: Array<{ id: string; name: string; apiKeyMasked: string | null }>;
  warnings: string[];
}

export class WebSearchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchConfigError";
  }
}

const SLOT_KEYS = ["apiKeyEnc", "baseUrl"] as const;
const DEEPSEEK_KEYS = [...SLOT_KEYS, "sourceProviderId"] as const;
const CUSTOM_KEYS = ["id", "name", "apiKeyEnc", "endpoint"] as const;
const UPDATE_SLOT_KEYS = ["apiKey", "apiKeyEnc", "sourceProviderId", "baseUrl"] as const;

function defaultConfig(): WebSearchConfig {
  return {
    source: "auto",
    deepseek: { apiKeyEnc: null, sourceProviderId: null, baseUrl: null },
    brave: { apiKeyEnc: null, baseUrl: null },
    glm: { apiKeyEnc: null, baseUrl: null },
    custom: [],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function unknownKeys(record: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(record).filter((key) => !allowed.includes(key));
}

/** DeepSeek-capable channel: its own protocol or a DeepSeek host. */
export function isDeepSeekChannel(provider: { piProvider?: string; baseURL?: string | null }): boolean {
  if (provider.piProvider === "deepseek") return true;
  const base = provider.baseURL;
  if (base === undefined || base === null || base === "") return false;
  try {
    return new URL(base).hostname.endsWith("deepseek.com");
  } catch {
    return false;
  }
}

function parseSlot(raw: unknown, name: string, warnings: string[]): BuiltinSlotConfig {
  if (raw === undefined) return { apiKeyEnc: null, baseUrl: null };
  if (!isObject(raw)) {
    warnings.push(`webSearch.${name} must be an object; ignoring it`);
    return { apiKeyEnc: null, baseUrl: null };
  }
  for (const key of unknownKeys(raw, name === "deepseek" ? DEEPSEEK_KEYS : SLOT_KEYS)) {
    warnings.push(`webSearch.${name}.${key} is not a known key; ignoring it`);
  }
  const apiKeyEnc = nullableString(raw["apiKeyEnc"]);
  if (apiKeyEnc === undefined) {
    warnings.push(`webSearch.${name}.apiKeyEnc must be a string or null`);
  }
  const baseUrl = nullableString(raw["baseUrl"]);
  if (baseUrl === undefined) {
    warnings.push(`webSearch.${name}.baseUrl must be a string or null`);
  } else if (baseUrl !== null && !isHttpUrl(baseUrl)) {
    warnings.push(`webSearch.${name}.baseUrl must be an http(s) URL; ignoring it`);
    return { apiKeyEnc: apiKeyEnc ?? null, baseUrl: null };
  }
  return { apiKeyEnc: apiKeyEnc ?? null, baseUrl: baseUrl ?? null };
}

function parseCustom(raw: unknown, warnings: string[]): CustomSearchSourceConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push("webSearch.custom must be an array; ignoring it");
    return [];
  }
  const sources: CustomSearchSourceConfig[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isObject(entry)) {
      warnings.push(`webSearch.custom[${index}] must be an object; ignoring it`);
      continue;
    }
    for (const key of unknownKeys(entry, CUSTOM_KEYS)) {
      warnings.push(`webSearch.custom[${index}].${key} is not a known key; ignoring it`);
    }
    const id = entry["id"];
    const name = entry["name"];
    const endpoint = entry["endpoint"];
    if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") {
      warnings.push(`webSearch.custom[${index}] needs an id and a name; ignoring it`);
      continue;
    }
    if (!isObject(endpoint)) {
      warnings.push(`webSearch.custom[${index}] has no endpoint spec; ignoring it`);
      continue;
    }
    sources.push({
      id,
      name,
      apiKeyEnc: nullableString(entry["apiKeyEnc"]) ?? null,
      endpoint: endpoint as unknown as EndpointSourceSpec,
    });
  }
  return sources;
}

/** Read the section leniently: every problem becomes a warning, never a throw. */
export async function loadWebSearchConfig(
  configDir: string = getConfigDir(),
): Promise<{ config: WebSearchConfig; warnings: string[] }> {
  const section = (await getConfigStore(configDir).read())["webSearch"];
  return normalizeSection(section);
}

export function normalizeSection(section: unknown): {
  config: WebSearchConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (section === undefined) return { config: defaultConfig(), warnings };
  if (!isObject(section)) {
    warnings.push("webSearch must be a JSON object; using defaults");
    return { config: defaultConfig(), warnings };
  }
  for (const key of unknownKeys(section, ["source", "deepseek", "brave", "glm", "custom"])) {
    warnings.push(`webSearch.${key} is not a known key; ignoring it`);
  }
  const custom = parseCustom(section["custom"], warnings);
  const rawSource = section["source"];
  let source = "auto";
  if (rawSource !== undefined) {
    if (typeof rawSource !== "string") {
      warnings.push("webSearch.source must be a string; using auto");
    } else if (
      (BUILTIN_SOURCES as readonly string[]).includes(rawSource) ||
      custom.some((entry) => entry.id === rawSource)
    ) {
      source = rawSource;
    } else {
      warnings.push(`webSearch.source "${rawSource}" is not a configured source; using auto`);
    }
  }
  const deepseekBase = parseSlot(section["deepseek"], "deepseek", warnings);
  const sourceProviderId = isObject(section["deepseek"])
    ? nullableString(section["deepseek"]["sourceProviderId"])
    : null;
  return {
    config: {
      source,
      deepseek: { ...deepseekBase, sourceProviderId: sourceProviderId ?? null },
      brave: parseSlot(section["brave"], "brave", warnings),
      glm: parseSlot(section["glm"], "glm", warnings),
      custom,
    },
    warnings,
  };
}

async function maskKey(
  cipher: ReturnType<typeof createCipher>,
  enc: string | null,
): Promise<string | null> {
  if (enc === null) return null;
  try {
    return cipher.mask(await cipher.decrypt(enc));
  } catch {
    return "…";
  }
}

/** Channels whose key may be reused as a search credential. */
export async function listDeepSeekCandidates(
  configDir: string = getConfigDir(),
): Promise<Array<{ id: string; name: string; apiKeyMasked: string | null }>> {
  const providers = await createProviderStore(configDir).listPublic();
  return providers
    .filter((provider) => isDeepSeekChannel(provider))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      apiKeyMasked: provider.apiKeyMasked ?? null,
    }));
}

export async function readWebSearchSettingsView(
  configDir: string = getConfigDir(),
): Promise<WebSearchSettingsView> {
  const { config, warnings } = await loadWebSearchConfig(configDir);
  const cipher = createCipher(configDir);
  const candidates = await listDeepSeekCandidates(configDir);
  const custom = await Promise.all(
    config.custom.map(async (entry) => ({
      id: entry.id,
      name: entry.name,
      method: entry.endpoint.method,
      url: entry.endpoint.url,
      apiKeyMasked: await maskKey(cipher, entry.apiKeyEnc),
    })),
  );
  return {
    source: config.source,
    builtins: {
      deepseek: {
        apiKeyMasked: await maskKey(cipher, config.deepseek.apiKeyEnc),
        sourceProviderId: config.deepseek.sourceProviderId,
        baseUrl: config.deepseek.baseUrl,
      },
      brave: {
        apiKeyMasked: await maskKey(cipher, config.brave.apiKeyEnc),
        baseUrl: config.brave.baseUrl,
      },
      glm: {
        apiKeyMasked: await maskKey(cipher, config.glm.apiKeyEnc),
        baseUrl: config.glm.baseUrl,
      },
    },
    custom,
    candidates,
    warnings,
  };
}

export interface WebSearchUpdateInput {
  source?: unknown;
  deepseek?: unknown;
  brave?: unknown;
  glm?: unknown;
}

interface SlotPatch {
  apiKeyEnc: string | null;
  baseUrl: string | null;
  sourceProviderId: string | null;
}

function updateSlot(
  raw: unknown,
  name: "deepseek" | "brave" | "glm",
  current: { apiKeyEnc: string | null; baseUrl: string | null; sourceProviderId?: string | null },
): SlotPatch {
  const next: SlotPatch = {
    apiKeyEnc: current.apiKeyEnc,
    baseUrl: current.baseUrl,
    sourceProviderId: current.sourceProviderId ?? null,
  };
  if (raw === undefined) return next;
  if (!isObject(raw)) throw new WebSearchConfigError(`webSearch.${name} must be an object`);
  for (const key of unknownKeys(raw, UPDATE_SLOT_KEYS)) {
    throw new WebSearchConfigError(`webSearch.${name}.${key} is not a known key`);
  }
  if (raw["apiKey"] !== undefined) {
    const value = nullableString(raw["apiKey"]);
    if (value === undefined) {
      throw new WebSearchConfigError(`webSearch.${name}.apiKey must be a string or null`);
    }
    next.apiKeyEnc = value === null || value === "" ? null : `plain:${value}`;
  }
  if (raw["baseUrl"] !== undefined) {
    const value = nullableString(raw["baseUrl"]);
    if (value === undefined) {
      throw new WebSearchConfigError(`webSearch.${name}.baseUrl must be a string or null`);
    }
    if (value !== null && !isHttpUrl(value)) {
      throw new WebSearchConfigError(`webSearch.${name}.baseUrl must be an http(s) URL`);
    }
    next.baseUrl = value;
  }
  if (raw["sourceProviderId"] !== undefined) {
    const value = nullableString(raw["sourceProviderId"]);
    if (value === undefined) {
      throw new WebSearchConfigError("webSearch.deepseek.sourceProviderId must be a string or null");
    }
    next.sourceProviderId = value;
  }
  return next;
}

async function encryptPatch(
  cipher: ReturnType<typeof createCipher>,
  patch: SlotPatch,
): Promise<{ apiKeyEnc: string | null; baseUrl: string | null; sourceProviderId: string | null }> {
  const plain = patch.apiKeyEnc?.startsWith("plain:") === true ? patch.apiKeyEnc.slice("plain:".length) : null;
  return {
    apiKeyEnc: plain === null ? patch.apiKeyEnc : await cipher.encrypt(plain),
    baseUrl: patch.baseUrl,
    sourceProviderId: patch.sourceProviderId,
  };
}

/**
 * Update the selected source and the builtin slots. Strict on purpose: a bad
 * document must not be written, and a reused channel must actually be a
 * DeepSeek channel — otherwise its key would be shipped to a search host.
 */
export async function updateWebSearchConfig(
  configDir: string,
  input: WebSearchUpdateInput,
): Promise<WebSearchSettingsView> {
  const { config } = await loadWebSearchConfig(configDir);
  const cipher = createCipher(configDir);
  const providers = await createProviderStore(configDir).listPublic();

  for (const key of unknownKeys(input as Record<string, unknown>, ["source", "deepseek", "brave", "glm"])) {
    throw new WebSearchConfigError(`request body has an unknown key "${key}"`);
  }

  const deepseekPatch = await encryptPatch(cipher, updateSlot(input.deepseek, "deepseek", config.deepseek));
  const bravePatch = await encryptPatch(cipher, updateSlot(input.brave, "brave", config.brave));
  const glmPatch = await encryptPatch(cipher, updateSlot(input.glm, "glm", config.glm));

  if (deepseekPatch.sourceProviderId !== null) {
    const channel = providers.find((provider) => provider.id === deepseekPatch.sourceProviderId);
    if (channel === undefined) {
      throw new WebSearchConfigError(
        `webSearch.deepseek.sourceProviderId "${deepseekPatch.sourceProviderId}" is not a configured provider`,
      );
    }
    if (!isDeepSeekChannel(channel)) {
      throw new WebSearchConfigError(
        `webSearch.deepseek.sourceProviderId "${deepseekPatch.sourceProviderId}" is not a DeepSeek channel`,
      );
    }
  }

  let source = config.source;
  if (input.source !== undefined) {
    if (typeof input.source !== "string") throw new WebSearchConfigError("webSearch.source must be a string");
    const known =
      (BUILTIN_SOURCES as readonly string[]).includes(input.source) ||
      config.custom.some((entry) => entry.id === input.source);
    if (!known) throw new WebSearchConfigError(`webSearch.source "${input.source}" is not a configured source`);
    source = input.source;
  }

  await getConfigStore(configDir).update<Record<string, unknown>>("webSearch", (current) => {
    if (current !== undefined && !isObject(current)) {
      throw new WebSearchConfigError("config.json: webSearch must be a JSON object");
    }
    const base = (current ?? {}) as Record<string, unknown>;
    return {
      ...base,
      source,
      deepseek: {
        ...(isObject(base["deepseek"]) ? base["deepseek"] : {}),
        apiKeyEnc: deepseekPatch.apiKeyEnc,
        baseUrl: deepseekPatch.baseUrl,
        sourceProviderId: deepseekPatch.sourceProviderId,
      },
      brave: {
        ...(isObject(base["brave"]) ? base["brave"] : {}),
        apiKeyEnc: bravePatch.apiKeyEnc,
        baseUrl: bravePatch.baseUrl,
      },
      glm: {
        ...(isObject(base["glm"]) ? base["glm"] : {}),
        apiKeyEnc: glmPatch.apiKeyEnc,
        baseUrl: glmPatch.baseUrl,
      },
    };
  });

  return readWebSearchSettingsView(configDir);
}
