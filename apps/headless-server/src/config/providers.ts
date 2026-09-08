/**
 * Provider registry — LLM providers and the models available under each.
 * Persisted as `~/.volto/providers.json` with the apiKey encrypted.
 *
 * The public surface (`listPublic`, `create`, `update`) never returns the
 * plaintext key. `resolveModel` is the single exception and exists only to
 * build a ModelPort server-side; its result must not reach an HTTP response.
 */

import * as crypto from "node:crypto";
import { createCipher } from "./crypto.js";
import { ensureConfigDir, getConfigDir, getConfigPath } from "./paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./io.js";

export interface Model {
  id: string;
  name: string;
  code: string;
  /** Max context window in tokens; optional — the context meter hides the percentage when unset. */
  contextWindow?: number;
  /** Max output tokens per model call; optional — omitted means the provider's own default. */
  maxOutputTokens?: number;
  /** Whether this model supports reasoning/thinking; optional, defaults to false downstream. */
  reasoning?: boolean;
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
      apiKeyEnc: string | null;
      modelCodes: string[];
    }
  | {
      kind: "custom";
      id: string;
      name: string;
      baseURL: string | null;
      apiKeyEnc: string | null;
      models: Model[];
    };

export type PublicProvider =
  | {
      kind: "catalog";
      id: string;
      name: string;
      piProvider: string;
      apiKeyMasked: string | null;
      modelCodes: string[];
    }
  | {
      kind: "custom";
      id: string;
      name: string;
      baseURL: string | null;
      apiKeyMasked: string | null;
      models: Model[];
    };

export type ProviderInput =
  | {
      kind: "catalog";
      name: string;
      piProvider: string;
      apiKey?: string | null;
      modelCodes: string[];
    }
  | {
      kind?: "custom";
      name: string;
      baseURL?: string | null;
      apiKey?: string | null;
      models?: Array<{
        id?: string;
        name: string;
        code: string;
        contextWindow?: number;
        maxOutputTokens?: number;
        reasoning?: boolean;
      }>;
    };

export function createProviderStore(dir: string = getConfigDir()) {
  const file = getConfigPath("providers.json", dir);
  const cipher = createCipher(dir);

  async function readAll(): Promise<Provider[]> {
    // Missing file means "no providers yet"; a present-but-corrupt file
    // throws instead of being treated as empty — see config/io.ts. Treating
    // it as empty here would have meant the next create()/update() call
    // silently discarded every provider (and every apiKey with it).
    // `kind` is optional on disk: a record written before the discriminator
    // existed has none, and reads as "custom" — a default, not a migration
    // (see module header). This is the only place that default is applied.
    const raw = await readJsonFile<Array<Provider & { kind?: "catalog" | "custom" }>>(file, []);
    return raw.map((p) => (p.kind === "catalog" ? p : { ...p, kind: "custom" as const }));
  }

  async function writeAll(providers: Provider[]): Promise<void> {
    await ensureConfigDir(dir);
    await writeJsonFileAtomic(file, providers);
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
        apiKeyMasked: masked,
        modelCodes: provider.modelCodes,
      };
    }
    return {
      kind: "custom",
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      apiKeyMasked: masked,
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
      return {
        id: m.id || crypto.randomUUID(),
        name: m.name,
        code: m.code,
        ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
        ...(m.maxOutputTokens === undefined ? {} : { maxOutputTokens: m.maxOutputTokens }),
        ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }),
      };
    });
  }

  return {
    async listPublic(): Promise<PublicProvider[]> {
      return Promise.all((await readAll()).map(toPublic));
    },

    async create(input: ProviderInput): Promise<PublicProvider> {
      const provider: Provider =
        input.kind === "catalog"
          ? {
              kind: "catalog",
              id: crypto.randomUUID(),
              name: input.name,
              piProvider: input.piProvider,
              apiKeyEnc: input.apiKey ? await cipher.encrypt(input.apiKey) : null,
              modelCodes: input.modelCodes,
            }
          : {
              kind: "custom",
              id: crypto.randomUUID(),
              name: input.name,
              baseURL: input.baseURL ?? null,
              apiKeyEnc: input.apiKey ? await cipher.encrypt(input.apiKey) : null,
              models: normalizeModels(input.models),
            };
      await writeAll([...(await readAll()), provider]);
      return toPublic(provider);
    },

    // `kind` is immutable after creation: a provider changing from a
    // hand-declared custom endpoint to a catalog route (or vice versa) is a
    // different record, not an edit. If `input.kind` is present and differs
    // from the stored record's kind, this rejects with a clear error instead
    // of silently keeping the old kind and dropping the input's kind-specific
    // fields.
    async update(id: string, input: Partial<ProviderInput>): Promise<PublicProvider | null> {
      const all = await readAll();
      const index = all.findIndex((p) => p.id === id);
      const current = all[index];
      if (!current) return null;

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
        next = {
          kind: "catalog",
          id: current.id,
          name,
          piProvider: catalogInput.piProvider ?? current.piProvider,
          apiKeyEnc,
          modelCodes: catalogInput.modelCodes ?? current.modelCodes,
        };
      } else {
        const customInput = input as Partial<Extract<ProviderInput, { kind?: "custom" }>>;
        next = {
          kind: "custom",
          id: current.id,
          name,
          baseURL: customInput.baseURL === undefined ? current.baseURL : customInput.baseURL,
          apiKeyEnc,
          models: customInput.models ? normalizeModels(customInput.models) : current.models,
        };
      }

      all[index] = next;
      await writeAll(all);
      return toPublic(next);
    },

    async remove(id: string): Promise<boolean> {
      const all = await readAll();
      const next = all.filter((p) => p.id !== id);
      if (next.length === all.length) return false;
      await writeAll(next);
      return true;
    },

    async resolveModel(
      providerId: string,
      modelId: string,
    ): Promise<
      | {
          kind: "catalog";
          piProvider: string;
          apiKey: string | null;
          code: string;
        }
      | {
          kind: "custom";
          baseURL: string | null;
          apiKey: string | null;
          code: string;
          maxOutputTokens?: number;
          reasoning?: boolean;
        }
      | null
    > {
      const provider = (await readAll()).find((p) => p.id === providerId);
      if (!provider) return null;

      const apiKey = provider.apiKeyEnc ? await cipher.decrypt(provider.apiKeyEnc) : null;

      if (provider.kind === "catalog") {
        // Catalog models are selected by code (no per-model id), so `modelId`
        // is matched against the code directly.
        const code = provider.modelCodes.find((c) => c === modelId);
        if (!code) return null;
        return { kind: "catalog", piProvider: provider.piProvider, apiKey, code };
      }

      const model = provider.models.find((m) => m.id === modelId);
      if (!model) return null;

      return {
        kind: "custom",
        baseURL: provider.baseURL,
        apiKey,
        code: model.code,
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      };
    },
  };
}
