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
}

export interface Provider {
  id: string;
  name: string;
  baseURL: string | null;
  apiKeyEnc: string | null;
  models: Model[];
}

export interface PublicProvider {
  id: string;
  name: string;
  baseURL: string | null;
  apiKeyMasked: string | null;
  models: Model[];
}

export interface ProviderInput {
  name: string;
  baseURL?: string | null;
  apiKey?: string | null;
  models?: Array<{ id?: string; name: string; code: string; contextWindow?: number }>;
}

export function createProviderStore(dir: string = getConfigDir()) {
  const file = getConfigPath("providers.json", dir);
  const cipher = createCipher(dir);

  async function readAll(): Promise<Provider[]> {
    // Missing file means "no providers yet"; a present-but-corrupt file
    // throws instead of being treated as empty — see config/io.ts. Treating
    // it as empty here would have meant the next create()/update() call
    // silently discarded every provider (and every apiKey with it).
    return readJsonFile<Provider[]>(file, []);
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
    return {
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      apiKeyMasked: masked,
      models: provider.models,
    };
  }

  function normalizeModels(models: ProviderInput["models"]): Model[] {
    return (models ?? []).map((m) => {
      if (
        m.contextWindow !== undefined &&
        (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0)
      ) {
        throw new Error(`contextWindow must be a positive integer (got ${m.contextWindow})`);
      }
      return {
        id: m.id || crypto.randomUUID(),
        name: m.name,
        code: m.code,
        ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
      };
    });
  }

  return {
    async listPublic(): Promise<PublicProvider[]> {
      return Promise.all((await readAll()).map(toPublic));
    },

    async create(input: ProviderInput): Promise<PublicProvider> {
      const provider: Provider = {
        id: crypto.randomUUID(),
        name: input.name,
        baseURL: input.baseURL ?? null,
        apiKeyEnc: input.apiKey ? await cipher.encrypt(input.apiKey) : null,
        models: normalizeModels(input.models),
      };
      await writeAll([...(await readAll()), provider]);
      return toPublic(provider);
    },

    async update(id: string, input: Partial<ProviderInput>): Promise<PublicProvider | null> {
      const all = await readAll();
      const index = all.findIndex((p) => p.id === id);
      const current = all[index];
      if (!current) return null;

      const next: Provider = {
        ...current,
        name: input.name ?? current.name,
        baseURL: input.baseURL === undefined ? current.baseURL : input.baseURL,
        // An omitted apiKey means "keep the existing one" — this is what lets
        // the settings UI show a masked value without round-tripping secrets.
        apiKeyEnc: input.apiKey ? await cipher.encrypt(input.apiKey) : current.apiKeyEnc,
        models: input.models ? normalizeModels(input.models) : current.models,
      };

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
    ): Promise<{ baseURL: string | null; apiKey: string | null; code: string } | null> {
      const provider = (await readAll()).find((p) => p.id === providerId);
      if (!provider) return null;
      const model = provider.models.find((m) => m.id === modelId);
      if (!model) return null;

      return {
        baseURL: provider.baseURL,
        apiKey: provider.apiKeyEnc ? await cipher.decrypt(provider.apiKeyEnc) : null,
        code: model.code,
      };
    },
  };
}
