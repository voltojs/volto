/**
 * Provider registry — LLM providers and the models available under each.
 * Persisted in `~/.volto/config.json` under `providers`, with the apiKey
 * encrypted.
 *
 * The public surface (`listPublic`, `create`, `update`) never returns the
 * plaintext key. `resolveModel` is the single exception and exists only to
 * build a ModelPort server-side; its result must not reach an HTTP response.
 */

import * as crypto from "node:crypto";
import type { ModelInputValue } from "@volto/core";
import { isProviderProtocol, type ConfiguredProtocol, type ProviderAuth, type ProviderProtocol } from "@volto/provider-pi-ai";
import { createCipher } from "./crypto.js";
import { getConfigDir } from "./paths.js";
import { getConfigStore } from "./store.js";

export interface Model {
  id: string;
  name: string;
  code: string;
  /** Per-model protocol override; absent follows the provider default. */
  protocol?: ProviderProtocol;
  /** Max context window in tokens; optional — the context meter hides the percentage when unset. */
  contextWindow?: number;
  /** Max output tokens per model call; optional — omitted means the provider's own default. */
  maxOutputTokens?: number;
  /** Whether this model supports reasoning/thinking; optional, defaults to false downstream. */
  reasoning?: boolean;
  /** Declared input modalities; absent = UNKNOWN (spec §6). */
  input?: ModelInputValue;
}

/**
 * A model enabled under a catalog provider. `code` is pi-ai's own model id
 * and is the only required field — everything else is an optional override
 * of what pi-ai's catalog already reports, so an omitted field means "use
 * the catalog's value" rather than "unset".
 *
 * `reasoning` is a user override of pi-ai's catalog flag: `false` forces the
 * model non-reasoning even when pi-ai declares efforts; `true` keeps/forces
 * reasoning (the effort list still comes from pi-ai when available). Omitted
 * means "follow the catalog".
 */
export interface CatalogModel {
  code: string;
  /** Per-model protocol override; absent follows the provider/catalog. */
  protocol?: ProviderProtocol;
  /** Display name; omitted means pi-ai's catalog name. */
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  /**
   * Per-model override of pi-ai's catalog `input` modalities. Absent =
   * follow the catalog. Valid: ["text"] / ["text","image"] (spec D1).
   */
  input?: ModelInputValue;
}

/**
 * `kind` discriminates a catalog provider (backed by pi-ai's built-in
 * provider registry, selecting models by code) from a custom one (a
 * hand-declared OpenAI-completions-compatible endpoint with its own model
 * list). A record persisted before this field existed has no `kind` at all;
 * `readAll` defaults that to `"custom"` — see module header for why this is
 * a default and not a migration.
 */
export type Provider =
  | {
      kind: "catalog";
      id: string;
      name: string;
      piProvider: string;
      /** Replaces pi-ai's own address for this provider; null means "use it". */
      baseURL: string | null;
      apiKeyEnc: string | null;
      /** Protocol default; absent/auto follows pi-ai's catalog api. */
      protocol?: ConfiguredProtocol;
      auth?: ProviderAuth;
      headers?: Record<string, string>;
      models: CatalogModel[];
    }
  | {
      kind: "custom";
      id: string;
      name: string;
      baseURL: string | null;
      apiKeyEnc: string | null;
      /** Protocol default; absent means openai-completions. */
      protocol?: ProviderProtocol;
      auth?: ProviderAuth;
      headers?: Record<string, string>;
      models: Model[];
    };

export type PublicProvider =
  | {
      kind: "catalog";
      id: string;
      name: string;
      piProvider: string;
      baseURL: string | null;
      apiKeyMasked: string | null;
      protocol?: ConfiguredProtocol;
      auth?: ProviderAuth;
      headers?: Record<string, string>;
      models: CatalogModel[];
    }
  | {
      kind: "custom";
      id: string;
      name: string;
      baseURL: string | null;
      apiKeyMasked: string | null;
      protocol?: ProviderProtocol;
      auth?: ProviderAuth;
      headers?: Record<string, string>;
      models: Model[];
    };

export type ProviderInput =
  | {
      kind: "catalog";
      name: string;
      piProvider: string;
      baseURL?: string | null;
      apiKey?: string | null;
      protocol?: ConfiguredProtocol;
      auth?: ProviderAuth;
      headers?: Record<string, string>;
      models: CatalogModel[];
    }
  | {
      kind?: "custom";
      name: string;
      baseURL?: string | null;
      apiKey?: string | null;
      protocol?: ProviderProtocol;
      auth?: ProviderAuth;
      headers?: Record<string, string>;
      models?: Array<{
        id?: string;
        name: string;
        code: string;
        protocol?: ProviderProtocol;
        contextWindow?: number;
        maxOutputTokens?: number;
        reasoning?: boolean;
        /** Declared input modalities; absent = UNKNOWN (spec §6). */
        input?: ModelInputValue;
      }>;
    };

export function createProviderStore(dir: string = getConfigDir()) {
  const store = getConfigStore(dir);
  const cipher = createCipher(dir);

  async function readAll(): Promise<Provider[]> {
    // Missing section means "no providers yet"; a corrupt document throws
    // instead of being treated as empty — see config/store.ts. Treating it
    // as empty here would have meant the next create()/update() call
    // silently discarded every provider (and every apiKey with it).
    // `kind` is optional on disk: a record written before the discriminator
    // existed has none, and reads as "custom" — a default, not a migration
    // (see module header). This is the only place that default is applied.
    const raw = (await store.read())["providers"] as
      | Array<Provider & { kind?: "catalog" | "custom"; modelCodes?: string[] }>
      | undefined ?? [];
    return raw.map((p) => {
      if (p.kind !== "catalog") return { ...p, kind: "custom" as const };
      // Same read-time default as `kind` above: a catalog record written when
      // enabled models were a bare code list has `modelCodes` and no `models`.
      // A bare code carries no overrides, which is exactly what an all-optional
      // CatalogModel with only `code` means — so this is a projection, not a
      // migration, and nothing is rewritten on disk until the user saves.
      return p.models ? p : { ...p, models: (p.modelCodes ?? []).map((code) => ({ code })) };
    });
  }

  async function toPublic(provider: Provider): Promise<PublicProvider> {
    let masked: string | null = null;
    if (provider.apiKeyEnc) {
      try {
        masked = cipher.mask(await cipher.decrypt(provider.apiKeyEnc));
      } catch {
        // A key we can no longer decrypt (e.g. the key file was replaced)
        // is surfaced as a distinct marker rather than a crash, so the user
        // can see that it needs re-entering.
        masked = "…";
      }
    }
    if (provider.kind === "catalog") {
      return {
        kind: "catalog",
        id: provider.id,
        name: provider.name,
        piProvider: provider.piProvider,
        baseURL: provider.baseURL ?? null,
        apiKeyMasked: masked,
        ...(provider.protocol === undefined ? {} : { protocol: provider.protocol }),
        ...(provider.auth === undefined ? {} : { auth: provider.auth }),
        ...(provider.headers === undefined ? {} : { headers: provider.headers }),
        models: provider.models,
      };
    }
    return {
      kind: "custom",
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      apiKeyMasked: masked,
      ...(provider.protocol === undefined ? {} : { protocol: provider.protocol }),
      ...(provider.auth === undefined ? {} : { auth: provider.auth }),
      ...(provider.headers === undefined ? {} : { headers: provider.headers }),
      models: provider.models,
    };
  }

  function normalizeModels(
    models: Extract<ProviderInput, { kind?: "custom" }>["models"],
  ): Model[] {
    return (models ?? []).map((m) => {
      if (
        m.contextWindow !== undefined &&
        (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0)
      ) {
        throw new Error(`contextWindow must be a positive integer (got ${m.contextWindow})`);
      }
      if (
        m.maxOutputTokens !== undefined &&
        (!Number.isInteger(m.maxOutputTokens) || m.maxOutputTokens <= 0)
      ) {
        throw new Error(`maxOutputTokens must be a positive integer (got ${m.maxOutputTokens})`);
      }
      const normalizedInput = normalizeInput(m.input);
      return {
        id: m.id || crypto.randomUUID(),
        name: m.name,
        code: m.code,
        ...(m.protocol === undefined ? {} : { protocol: normalizeProtocol(m.protocol, m.code) }),
        ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
        ...(m.maxOutputTokens === undefined ? {} : { maxOutputTokens: m.maxOutputTokens }),
        ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }),
        ...(normalizedInput === undefined ? {} : { input: normalizedInput }),
      };
    });
  }

  /**
   * The only two legal modality lists (D3: text is always present, so
   * `input: []` and single-modality ["image"] cannot occur).
   */
  function normalizeProtocol(value: unknown, model?: string): ProviderProtocol | undefined {
    if (value === undefined) return undefined;
    if (!isProviderProtocol(value)) {
      throw new Error(`Unsupported protocol${model === undefined ? "" : ` for model ${model}`}: ${String(value)}`);
    }
    return value;
  }

  function normalizeConfiguredProtocol(value: unknown): ConfiguredProtocol | undefined {
    if (value === undefined) return undefined;
    if (value === "auto") return "auto";
    return normalizeProtocol(value);
  }

  function normalizeAuth(value: unknown): ProviderAuth | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null) throw new Error("auth must be an object");
    const record = value as Record<string, unknown>;
    const kind = record["kind"];
    if (kind !== "bearer" && kind !== "x-api-key" && kind !== "header") {
      throw new Error(`Unsupported auth kind: ${String(kind)}`);
    }
    if (kind === "header") {
      if (typeof record["name"] !== "string" || record["name"].trim() === "") {
        throw new Error("auth.name is required for header auth");
      }
      return { kind, name: record["name"] };
    }
    return { kind };
  }

  function normalizeHeaders(value: unknown): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null) throw new Error("headers must be an object");
    const out: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(value)) {
      if (typeof headerValue !== "string") throw new Error(`header ${name} must be a string`);
      if (/authorization|x-api-key/i.test(name)) {
        throw new Error("API credentials must be configured as apiKey/auth, not headers");
      }
      out[name] = headerValue;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }

  function normalizeInput(input: ModelInputValue | undefined): ModelInputValue | undefined {
    if (input === undefined) return undefined;
    const legal =
      (input.length === 1 && input[0] === "text") ||
      (input.length === 2 && input[0] === "text" && input[1] === "image");
    if (!legal) {
      throw new Error(`input must be ["text"] or ["text","image"] (got ${JSON.stringify(input)})`);
    }
    return input;
  }

  /**
   * Catalog models carry only overrides, so the two token caps get the same
   * positive-integer check as custom models while `name` stays free-form and
   * an omitted field stays omitted (rather than becoming an explicit
   * `undefined` that would shadow pi-ai's own value on read).
   */
  function normalizeCatalogModels(models: CatalogModel[]): CatalogModel[] {
    return models.map((m) => {
      if (!m.code) throw new Error("catalog model code is required");
      if (
        m.contextWindow !== undefined &&
        (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0)
      ) {
        throw new Error(`contextWindow must be a positive integer (got ${m.contextWindow})`);
      }
      if (
        m.maxOutputTokens !== undefined &&
        (!Number.isInteger(m.maxOutputTokens) || m.maxOutputTokens <= 0)
      ) {
        throw new Error(`maxOutputTokens must be a positive integer (got ${m.maxOutputTokens})`);
      }
      const normalizedInput = normalizeInput(m.input);
      return {
        code: m.code,
        ...(m.protocol === undefined ? {} : { protocol: normalizeProtocol(m.protocol, m.code) }),
        ...(m.name === undefined || m.name === "" ? {} : { name: m.name }),
        ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
        ...(m.maxOutputTokens === undefined ? {} : { maxOutputTokens: m.maxOutputTokens }),
        ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }),
        ...(normalizedInput === undefined ? {} : { input: normalizedInput }),
      };
    });
  }

  /**
   * One record per pi-ai provider.
   *
   * A `Models` collection registers a catalog provider under pi-ai's own id
   * (see provider-pi-ai's buildCatalogProvider), so two records pointing at
   * the same one cannot coexist — and pi-ai's `setProvider` would silently
   * replace rather than reject. Two records would also be ambiguous by
   * definition: same endpoint, same models, two API keys. Rejected here so
   * the failure lands on the save, naming the conflict, instead of on some
   * later turn.
   */
  async function assertPiProviderFree(piProvider: string, exceptId?: string): Promise<void> {
    const clash = (await readAll()).find(
      (p) => p.kind === "catalog" && p.piProvider === piProvider && p.id !== exceptId,
    );
    if (clash) {
      throw new Error(
        `Built-in provider "${piProvider}" is already configured as "${clash.name}"; edit that one instead.`,
      );
    }
  }

  return {
    async listPublic(): Promise<PublicProvider[]> {
      return Promise.all((await readAll()).map(toPublic));
    },

    async create(input: ProviderInput): Promise<PublicProvider> {
      if (input.kind === "catalog") {
        await assertPiProviderFree(input.piProvider);
      }
      const provider: Provider =
        input.kind === "catalog"
          ? {
              kind: "catalog",
              id: crypto.randomUUID(),
              name: input.name,
              piProvider: input.piProvider,
              baseURL: input.baseURL ?? null,
              apiKeyEnc: input.apiKey ? await cipher.encrypt(input.apiKey) : null,
              ...(input.protocol === undefined ? {} : { protocol: normalizeConfiguredProtocol(input.protocol) }),
              ...(input.auth === undefined ? {} : { auth: normalizeAuth(input.auth) }),
              ...(input.headers === undefined ? {} : { headers: normalizeHeaders(input.headers) }),
              models: normalizeCatalogModels(input.models),
            }
          : {
              kind: "custom",
              id: crypto.randomUUID(),
              name: input.name,
              baseURL: input.baseURL ?? null,
              apiKeyEnc: input.apiKey ? await cipher.encrypt(input.apiKey) : null,
              ...(input.protocol === undefined ? {} : { protocol: normalizeProtocol(input.protocol) }),
              ...(input.auth === undefined ? {} : { auth: normalizeAuth(input.auth) }),
              ...(input.headers === undefined ? {} : { headers: normalizeHeaders(input.headers) }),
              models: normalizeModels(input.models),
            };
      await store.update<Provider[]>("providers", (current) => [
        ...(current ?? []),
        provider,
      ]);
      return toPublic(provider);
    },

    // `kind` is immutable after creation: a provider changing from a
    // hand-declared custom endpoint to a catalog route (or vice versa) is a
    // different record, not an edit. If `input.kind` is present and differs
    // from the stored record's kind, this rejects with a clear error instead
    // of silently keeping the old kind and dropping the input's kind-specific
    // fields.
    async update(id: string, input: Partial<ProviderInput>): Promise<PublicProvider | null> {
      let publicNext: PublicProvider | null = null;
      await store.update<Provider[]>("providers", async (stored) => {
        const all = stored ?? [];
        const index = all.findIndex((p) => p.id === id);
        const current = all[index];
        if (!current) return all;

        if (input.kind !== undefined && input.kind !== current.kind) {
          throw new Error(
            `Cannot change provider "${current.id}" kind from "${current.kind}" to "${input.kind}"; delete and recreate it instead.`,
          );
        }

        // An omitted apiKey means "keep the existing one" — this is what lets
        // the settings UI show a masked value without round-tripping secrets.
        const apiKeyEnc = input.apiKey ? await cipher.encrypt(input.apiKey) : current.apiKeyEnc;
        const name = input.name ?? current.name;

        let next: Provider;
        if (current.kind === "catalog") {
          const catalogInput = input as Partial<Extract<ProviderInput, { kind: "catalog" }>>;
          if (catalogInput.piProvider !== undefined && catalogInput.piProvider !== current.piProvider) {
            await assertPiProviderFree(catalogInput.piProvider, current.id);
          }
          next = {
            kind: "catalog",
            id: current.id,
            name,
            piProvider: catalogInput.piProvider ?? current.piProvider,
            baseURL:
              catalogInput.baseURL === undefined ? current.baseURL ?? null : catalogInput.baseURL,
            apiKeyEnc,
            ...(catalogInput.protocol === undefined ? {} : { protocol: normalizeConfiguredProtocol(catalogInput.protocol) }),
            ...(catalogInput.auth === undefined ? {} : { auth: normalizeAuth(catalogInput.auth) }),
            ...(catalogInput.headers === undefined ? {} : { headers: normalizeHeaders(catalogInput.headers) }),
            models: catalogInput.models
              ? normalizeCatalogModels(catalogInput.models)
              : current.models,
          };
        } else {
          const customInput = input as Partial<Extract<ProviderInput, { kind?: "custom" }>>;
          next = {
            kind: "custom",
            id: current.id,
            name,
            baseURL: customInput.baseURL === undefined ? current.baseURL : customInput.baseURL,
            apiKeyEnc,
            ...(customInput.protocol === undefined ? {} : { protocol: normalizeProtocol(customInput.protocol) }),
            ...(customInput.auth === undefined ? {} : { auth: normalizeAuth(customInput.auth) }),
            ...(customInput.headers === undefined ? {} : { headers: normalizeHeaders(customInput.headers) }),
            models: customInput.models ? normalizeModels(customInput.models) : current.models,
          };
        }

        all[index] = next;
        publicNext = await toPublic(next);
        return all;
      });
      return publicNext;
    },

    async remove(id: string): Promise<boolean> {
      let removed = false;
      await store.update<Provider[]>("providers", (current) => {
        const all = current ?? [];
        const next = all.filter((p) => p.id !== id);
        removed = next.length !== all.length;
        return removed ? next : all;
      });
      return removed;
    },

    async resolveModel(
      providerId: string,
      modelId: string,
    ): Promise<
      | {
          kind: "catalog";
          piProvider: string;
          baseURL: string | null;
          apiKey: string | null;
          code: string;
          protocol?: ConfiguredProtocol;
          modelProtocol?: ProviderProtocol;
          auth?: ProviderAuth;
          headers?: Record<string, string>;
          maxOutputTokens?: number;
          /** Declared context window; absent = follow the pi-ai catalog. */
          contextWindow?: number;
          /** User override of pi-ai's catalog reasoning flag; absent = follow catalog. */
          reasoning?: boolean;
          input?: ModelInputValue;
        }
      | {
          kind: "custom";
          baseURL: string | null;
          apiKey: string | null;
          code: string;
          protocol?: ProviderProtocol;
          auth?: ProviderAuth;
          headers?: Record<string, string>;
          maxOutputTokens?: number;
          /** Declared context window; absent = the adapter's 128k fallback. */
          contextWindow?: number;
          reasoning?: boolean;
          input?: ModelInputValue;
        }
      | null
    > {
      const provider = (await readAll()).find((p) => p.id === providerId);
      if (!provider) return null;

      const apiKey = provider.apiKeyEnc ? await cipher.decrypt(provider.apiKeyEnc) : null;

      if (provider.kind === "catalog") {
        // Catalog models are selected by code (no per-model id), so `modelId`
        // is matched against the code directly.
        const model = provider.models.find((m) => m.code === modelId);
        if (!model) return null;
        return {
          kind: "catalog",
          piProvider: provider.piProvider,
          // `?? null` covers a record written before catalog providers could
          // carry an override, same read-time default as `models` above.
          baseURL: provider.baseURL ?? null,
          apiKey,
          code: model.code,
          ...(provider.protocol === undefined ? {} : { protocol: provider.protocol }),
          ...(model.protocol === undefined ? {} : { modelProtocol: model.protocol }),
          ...(provider.auth === undefined ? {} : { auth: provider.auth }),
          ...(provider.headers === undefined ? {} : { headers: provider.headers }),
          ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
          ...(model.input === undefined ? {} : { input: model.input }),
        };
      }

      const model = provider.models.find((m) => m.id === modelId);
      if (!model) return null;

      return {
        kind: "custom",
        baseURL: provider.baseURL,
        apiKey,
        code: model.code,
        ...(model.protocol ?? provider.protocol
          ? { protocol: model.protocol ?? provider.protocol }
          : {}),
        ...(provider.auth === undefined ? {} : { auth: provider.auth }),
        ...(provider.headers === undefined ? {} : { headers: provider.headers }),
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        ...(model.input === undefined ? {} : { input: model.input }),
      };
    },
  };
}
