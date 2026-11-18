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

import {
  createEndpointAdapter,
  createSearchAdapter,
  type EndpointSourceSpec,
  type SearchHit,
  type WebSearchToolOptions,
} from "@voltojs/tools/web";
import { createNodeNetwork, wrapNetworkWithEgress } from "@voltojs/runtime-node";
import { createCipher } from "./crypto.js";
import { loadEgressPolicy } from "./egress.js";
import { getConfigDir } from "./paths.js";
import { readPreferences } from "./preferences.js";
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
  /** What a new session would actually use, shown above the source picker. */
  resolved: { sourceId: string; label: string; reason: string };
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
  const preferences = await readPreferences(configDir);
  const provider = await readChannel(configDir, preferences.lastProviderId);
  const resolution = resolveWebSearch(config, provider !== null ? { provider } : {});
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
    resolved: {
      sourceId: resolution.sourceId,
      label: resolution.label,
      reason: resolution.reason,
    },
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
export interface CustomSourceInput {
  name: string;
  /** Plaintext key; omitted on edit means "keep the stored one". */
  apiKey?: string | null;
  endpoint: EndpointSourceSpec;
}

/** Validate a user-authored endpoint spec, including a dry render. */
export function validateEndpointSpec(raw: unknown): EndpointSourceSpec {
  if (!isObject(raw)) throw new WebSearchConfigError("endpoint must be an object");
  const method = raw["method"];
  if (method !== "GET" && method !== "POST") {
    throw new WebSearchConfigError('endpoint.method must be "GET" or "POST"');
  }
  const url = raw["url"];
  if (typeof url !== "string" || !isHttpUrl(url)) {
    throw new WebSearchConfigError("endpoint.url must be an http(s) URL");
  }
  const headers = raw["headers"];
  if (headers !== undefined) {
    if (!isObject(headers) || Object.values(headers).some((value) => typeof value !== "string")) {
      throw new WebSearchConfigError("endpoint.headers must be an object of strings");
    }
  }
  const auth = raw["auth"];
  if (auth !== undefined) {
    if (!isObject(auth) || typeof auth["header"] !== "string" || typeof auth["prefix"] !== "string") {
      throw new WebSearchConfigError("endpoint.auth must be { header, prefix }");
    }
  }
  const bodyTemplate = raw["bodyTemplate"];
  if (method === "POST" && typeof bodyTemplate !== "string") {
    throw new WebSearchConfigError("endpoint.bodyTemplate is required for POST");
  }
  if (method === "GET" && bodyTemplate !== undefined && typeof bodyTemplate !== "string") {
    throw new WebSearchConfigError("endpoint.bodyTemplate must be a string");
  }
  const paths = raw["paths"];
  if (!isObject(paths)) throw new WebSearchConfigError("endpoint.paths must be an object");
  const list = paths["list"];
  const title = paths["title"];
  const resultUrl = paths["url"];
  for (const [name, value] of [["list", list], ["title", title], ["url", resultUrl]] as const) {
    if (typeof value !== "string" || value === "") {
      throw new WebSearchConfigError(`endpoint.paths.${name} is required`);
    }
  }

  const spec = raw as unknown as EndpointSourceSpec;
  // Dry render: a template that cannot produce a request never reaches a user
  // as a saved source that fails on every call.
  try {
    createEndpointAdapter({ id: "validate", label: "validate", spec }).buildRequest("volto", {
      count: 5,
    });
  } catch (error) {
    throw new WebSearchConfigError(
      `endpoint cannot build a request: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return spec;
}

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "search" : slug;
}

async function readCustomSources(configDir: string): Promise<CustomSearchSourceConfig[]> {
  return (await loadWebSearchConfig(configDir)).config.custom;
}

async function writeCustomSources(
  configDir: string,
  mutate: (sources: CustomSearchSourceConfig[]) => {
    sources: CustomSearchSourceConfig[];
    source?: string;
  },
): Promise<WebSearchSettingsView> {
  await getConfigStore(configDir).update<Record<string, unknown>>("webSearch", (current) => {
    const { config } = normalizeSection(current);
    const next = mutate(config.custom);
    const base = isObject(current) ? current : {};
    return {
      ...base,
      ...(next.source !== undefined ? { source: next.source } : {}),
      custom: next.sources,
    };
  });
  return readWebSearchSettingsView(configDir);
}

export async function createCustomSource(
  configDir: string,
  input: CustomSourceInput,
): Promise<WebSearchSettingsView> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") throw new WebSearchConfigError("name must not be empty");
  const endpoint = validateEndpointSpec(input.endpoint);
  const cipher = createCipher(configDir);
  const apiKeyEnc = typeof input.apiKey === "string" && input.apiKey !== ""
    ? await cipher.encrypt(input.apiKey)
    : null;

  const existing = await readCustomSources(configDir);
  const base = slugify(name);
  let id = base;
  for (let suffix = 2; existing.some((entry) => entry.id === id); suffix += 1) {
    id = `${base}-${suffix}`;
  }

  return writeCustomSources(configDir, (sources) => ({
    sources: [...sources, { id, name, apiKeyEnc, endpoint }],
  }));
}

export async function updateCustomSource(
  configDir: string,
  id: string,
  input: Partial<CustomSourceInput>,
): Promise<WebSearchSettingsView> {
  const existing = await readCustomSources(configDir);
  const current = existing.find((entry) => entry.id === id);
  if (current === undefined) throw new WebSearchConfigError(`custom search source "${id}" does not exist`);

  const name = input.name === undefined ? current.name : input.name.trim();
  if (name === "") throw new WebSearchConfigError("name must not be empty");
  const endpoint = input.endpoint === undefined ? current.endpoint : validateEndpointSpec(input.endpoint);
  const cipher = createCipher(configDir);
  const apiKeyEnc =
    input.apiKey === undefined
      ? current.apiKeyEnc
      : typeof input.apiKey === "string" && input.apiKey !== ""
        ? await cipher.encrypt(input.apiKey)
        : null;

  return writeCustomSources(configDir, (sources) => ({
    sources: sources.map((entry) =>
      entry.id === id ? { id, name, apiKeyEnc, endpoint } : entry,
    ),
  }));
}

export async function deleteCustomSource(
  configDir: string,
  id: string,
): Promise<WebSearchSettingsView> {
  const existing = await readCustomSources(configDir);
  if (!existing.some((entry) => entry.id === id)) {
    throw new WebSearchConfigError(`custom search source "${id}" does not exist`);
  }
  const { config } = await loadWebSearchConfig(configDir);
  const fellBack = config.source === id;

  const view = await writeCustomSources(configDir, (sources) => ({
    sources: sources.filter((entry) => entry.id !== id),
    ...(fellBack ? { source: "auto" } : {}),
  }));
  if (!fellBack) return view;
  return {
    ...view,
    warnings: [
      `The selected search source "${id}" was deleted; the source fell back to auto.`,
      ...view.warnings,
    ],
  };
}
export interface WebSearchResolutionContext {
  /** The session's model channel, with its decrypted key. */
  provider?: { id: string; piProvider: string; baseURL: string | null; apiKey: string | null } | null;
  /** Decrypted keys for the builtin slots and the custom sources. */
  keys?: {
    deepseek?: string | null;
    brave?: string | null;
    glm?: string | null;
    custom?: Record<string, string | null>;
  };
}

export interface ResolvedWebSearch {
  options: WebSearchToolOptions;
  warnings: string[];
  /** Display name for the resolution line in the settings page. */
  label: string;
  sourceId: string;
  /** Why this source was picked: "auto-channel", "configured", "off", "unconfigured". */
  reason: string;
}

/**
 * Pure: turn the stored section plus the session's channel into the options the
 * SDK receives. Keys only ever travel in memory (this object), never into a
 * state, event or log.
 */
export function resolveWebSearch(
  config: WebSearchConfig,
  ctx: WebSearchResolutionContext = {},
): ResolvedWebSearch {
  const warnings: string[] = [];
  const provider = ctx.provider ?? null;
  const keys = ctx.keys ?? {};

  const channelDeepSeek =
    provider !== null && isDeepSeekChannel(provider) && provider.apiKey !== null;
  const channelBaseUrl = provider?.baseURL ?? undefined;

  const deepseekOwn = keys.deepseek ?? null;

  const custom = (id: string): ResolvedWebSearch | null => {
    const entry = config.custom.find((candidate) => candidate.id === id);
    if (entry === undefined) return null;
    const apiKey = keys.custom?.[id] ?? null;
    return {
      options: {
        source: "endpoint",
        sourceId: entry.id,
        label: entry.name,
        ...(apiKey !== null ? { apiKey } : {}),
        endpoint: entry.endpoint,
      },
      warnings,
      label: entry.name,
      sourceId: entry.id,
      reason: "custom",
    };
  };

  const builtin = (name: "deepseek" | "brave" | "glm"): ResolvedWebSearch => {
    const label = name === "deepseek" ? "DeepSeek" : name === "brave" ? "Brave" : "GLM";
    if (name === "deepseek") {
      const slot = config.deepseek;
      if (slot.sourceProviderId !== null && provider !== null && provider.id === slot.sourceProviderId) {
        if (channelDeepSeek) {
          return {
            options: {
              source: name,
              sourceId: name,
              label,
              apiKey: provider.apiKey as string,
              ...(channelBaseUrl !== undefined ? { baseUrl: channelBaseUrl } : {}),
            },
            warnings,
            label,
            sourceId: name,
            reason: "reuse-channel",
          };
        }
        warnings.push(
          `webSearch.deepseek.sourceProviderId "${slot.sourceProviderId}" has no usable key; using the slot key`,
        );
      }
      if (deepseekOwn !== null) {
        return {
          options: {
            source: name,
            sourceId: name,
            label,
            apiKey: deepseekOwn,
            ...(slot.baseUrl !== null ? { baseUrl: slot.baseUrl } : {}),
          },
          warnings,
          label,
          sourceId: name,
          reason: "configured",
        };
      }
      warnings.push("DeepSeek search has no API key; pick a channel or enter one in Settings");
      return { options: { source: "none" }, warnings, label, sourceId: "none", reason: "unconfigured" };
    }

    const slot = name === "brave" ? config.brave : config.glm;
    const apiKey = name === "brave" ? keys.brave ?? null : keys.glm ?? null;
    return {
      options: {
        source: name,
        sourceId: name,
        label,
        ...(apiKey !== null ? { apiKey } : {}),
        ...(slot.baseUrl !== null ? { baseUrl: slot.baseUrl } : {}),
      },
      warnings,
      label,
      sourceId: name,
      reason: "configured",
    };
  };

  if (config.source === "off") {
    return { options: { source: "off" }, warnings, label: "Off", sourceId: "off", reason: "off" };
  }
  if (config.source === "deepseek" || config.source === "brave" || config.source === "glm") {
    return builtin(config.source);
  }
  if (config.source !== "auto") {
    const resolved = custom(config.source);
    if (resolved !== null) return resolved;
    warnings.push(`webSearch.source "${config.source}" no longer exists; falling back to auto`);
  }

  if (channelDeepSeek) {
    return {
      options: {
        source: "deepseek",
        sourceId: "deepseek",
        label: "DeepSeek",
        apiKey: provider.apiKey as string,
        ...(channelBaseUrl !== undefined ? { baseUrl: channelBaseUrl } : {}),
      },
      warnings,
      label: "DeepSeek",
      sourceId: "deepseek",
      reason: "auto-channel",
    };
  }
  return {
    options: { source: "none" },
    warnings,
    label: "Not configured",
    sourceId: "none",
    reason: "unconfigured",
  };
}

async function decryptSlot(
  cipher: ReturnType<typeof createCipher>,
  enc: string | null,
): Promise<string | null> {
  if (enc === null) return null;
  try {
    return await cipher.decrypt(enc);
  } catch {
    return null;
  }
}

/** Decrypt every stored search credential for one resolution pass. */
async function readSearchKeys(
  configDir: string,
  config: WebSearchConfig,
): Promise<NonNullable<WebSearchResolutionContext["keys"]>> {
  const cipher = createCipher(configDir);
  const custom: Record<string, string | null> = {};
  for (const entry of config.custom) {
    custom[entry.id] = await decryptSlot(cipher, entry.apiKeyEnc);
  }
  return {
    deepseek: await decryptSlot(cipher, config.deepseek.apiKeyEnc),
    brave: await decryptSlot(cipher, config.brave.apiKeyEnc),
    glm: await decryptSlot(cipher, config.glm.apiKeyEnc),
    custom,
  };
}

async function readChannel(
  configDir: string,
  providerId: string | undefined,
): Promise<NonNullable<WebSearchResolutionContext["provider"]> | null> {
  if (providerId === undefined) return null;
  const store = createProviderStore(configDir);
  const providers = await store.listPublic();
  const channel = providers.find((provider) => provider.id === providerId);
  if (channel === undefined) return null;
  return {
    id: channel.id,
    piProvider: channel.kind === "catalog" ? channel.piProvider : "custom",
    baseURL: channel.baseURL,
    apiKey: await store.readApiKey(channel.id),
  };
}

/**
 * Host-side entry point used when building a session: read, decrypt, resolve.
 * Warnings go to the gateway log; the settings view shows them too.
 */
export async function resolveWebSearchForSession(
  configDir: string,
  providerId: string | undefined,
): Promise<WebSearchToolOptions> {
  const { config } = await loadWebSearchConfig(configDir);
  const provider = await readChannel(configDir, providerId);
  const keys = await readSearchKeys(configDir, config);
  const resolved = resolveWebSearch(config, { ...(provider !== null ? { provider } : {}), keys });
  for (const warning of resolved.warnings) console.warn(`web search: ${warning}`);
  return resolved.options;
}

/** The resolution line the settings page shows above the source picker. */
export async function readWebSearchResolution(
  configDir: string,
  providerId: string | undefined,
): Promise<{ sourceId: string; label: string; reason: string }> {
  const { config } = await loadWebSearchConfig(configDir);
  const provider = await readChannel(configDir, providerId);
  const resolved = resolveWebSearch(config, provider !== null ? { provider } : {});
  return { sourceId: resolved.sourceId, label: resolved.label, reason: resolved.reason };
}

export interface WebSearchTestResult {
  resolved: { sourceId: string; label: string; reason: string };
  durationMs?: number;
  hits?: SearchHit[];
  error?: string;
}

/**
 * Run one search with the exact resolution a new session would get, through the
 * same egress-wrapped Network port, so "test" cannot disagree with the agent.
 */
export async function testWebSearch(
  configDir: string,
  opts: { source?: string; query?: string; providerId?: string } = {},
): Promise<WebSearchTestResult> {
  const { config: stored } = await loadWebSearchConfig(configDir);
  const config = opts.source === undefined ? stored : { ...stored, source: opts.source };
  const preferences = await readPreferences(configDir);
  const providerId = opts.providerId ?? preferences.lastProviderId;
  const provider = await readChannel(configDir, providerId);
  const keys = await readSearchKeys(configDir, config);
  const resolved = resolveWebSearch(config, { ...(provider !== null ? { provider } : {}), keys });
  const summary = { sourceId: resolved.sourceId, label: resolved.label, reason: resolved.reason };

  if (resolved.options.source === "none" || resolved.options.source === "off") {
    return {
      resolved: summary,
      error:
        "Web search is not configured. Pick a source in Settings → Tools → Web Search " +
        "(DeepSeek can reuse a model channel's key).",
    };
  }

  const query = opts.query ?? "DeepSeek";
  const startedAt = Date.now();
  try {
    const adapter = createSearchAdapter({
      source: resolved.options.source,
      id: resolved.options.sourceId,
      label: resolved.options.label,
      ...(resolved.options.endpoint !== undefined ? { endpoint: resolved.options.endpoint } : {}),
    });
    const request = adapter.buildRequest(query, {
      ...(resolved.options.apiKey !== undefined ? { apiKey: resolved.options.apiKey } : {}),
      ...(resolved.options.baseUrl !== undefined ? { baseUrl: resolved.options.baseUrl } : {}),
      count: 5,
    });
    const egress = await loadEgressPolicy(configDir);
    const raw = createNodeNetwork();
    const network = egress === null ? raw : wrapNetworkWithEgress(raw, egress);
    const response = await network.fetch(request);
    const hits = adapter.parseResponse(response, { count: 5 });
    return { resolved: summary, durationMs: Date.now() - startedAt, hits };
  } catch (error) {
    return {
      resolved: summary,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
