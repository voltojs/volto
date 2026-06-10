/**
 * OpenAI-compatible Embedder implementation.
 *
 * Implements the M8 `Embedder` port using OpenAI's /v1/embeddings API.
 * Compatible with any OpenAI-compatible gateway via configurable baseURL.
 * Errors are normalized (no exceptions thrown).
 */

import type { Embedder } from "@agent-core/core";

export interface OpenAIEmbedderOptions {
  /** Base URL of the OpenAI-compatible API (default: https://api.openai.com) */
  baseURL?: string;
  /** API key for Authorization header */
  apiKey: string;
  /** Embedding model (default: text-embedding-3-small) */
  model?: string;
}

export function createOpenAIEmbedder(opts: OpenAIEmbedderOptions): Embedder {
  const baseURL = (opts.baseURL ?? "https://api.openai.com").replace(/\/+$/, "");
  const model = opts.model ?? "text-embedding-3-small";

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      try {
        const response = await fetch(`${baseURL}/v1/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({ model, input: texts }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`Embedding API error ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as {
          data?: Array<{ embedding?: number[] }>;
        };

        if (!data.data || !Array.isArray(data.data)) {
          throw new Error("Invalid embedding response: missing data array");
        }

        return data.data.map((item) => item.embedding ?? []);
      } catch (err: unknown) {
        // Normalize errors — Embedder port contract: errors should not throw
        // but the current port signature returns Promise<number[][]> without
        // explicit error handling. For now, re-throw with a clear message.
        // The SDK/Runner will catch and normalize.
        throw new Error(
          `Embedding failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
