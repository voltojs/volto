/**
 * ModelRouter — model routing with transparent fallback.
 *
 * Wraps a primary ModelPort + ordered fallback chain into a single ModelPort.
 * When the primary yields a retriable ModelEventError, the router transparently
 * retries with the next fallback provider. Runner/reducer see one ModelPort.
 *
 * Role-based routing: create one ModelRouter per role (main / compaction /
 * classify / embedding), each bound to its own primary + fallback chain.
 */

import type { ModelPort, ModelEvent, ModelRequest } from "@volto/core";

export interface ModelRouterOptions {
  /** Primary model port + model name */
  primary: { provider: ModelPort; model: string };
  /**
   * Ordered fallback providers (tried in sequence on retriable errors).
   * Each entry can override the model; defaults to primary.model.
   */
  fallbacks?: Array<{ provider: ModelPort; model?: string }>;
  /** Max retry attempts (default: fallbacks.length) */
  maxRetries?: number;
}

/**
 * Create a ModelRouter that satisfies ModelPort.
 *
 * ```ts
 * const router = createModelRouter({
 *   primary: { provider: anthropicPort, model: "claude-sonnet-4-20250514" },
 *   fallbacks: [{ provider: openaiPort }],
 * });
 * createAgent({ modelPort: router });
 * ```
 */
export function createModelRouter(opts: ModelRouterOptions): ModelPort {
  const { primary, fallbacks = [], maxRetries } = opts;
  const retryLimit = maxRetries ?? fallbacks.length;

  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const chain: Array<{ provider: ModelPort; model: string }> = [
        { provider: primary.provider, model: req.model ?? primary.model },
        ...fallbacks.map((fb) => ({
          provider: fb.provider,
          model: fb.model ?? primary.model,
        })),
      ];

      const limit = Math.min(retryLimit + 1, chain.length);

      for (let attempt = 0; attempt < limit; attempt++) {
        const entry = chain[attempt]!;
        const events: ModelEvent[] = [];
        let sawRetriableError = false;

        try {
          for await (const event of entry.provider.stream({ ...req, model: entry.model })) {
            if (event.type === "error" && event.retriable) {
              sawRetriableError = true;
              break;
            }
            events.push(event);
          }
        } catch {
          sawRetriableError = true;
        }

        if (!sawRetriableError || attempt === limit - 1) {
          yield* events;
          return;
        }
      }
    },
  };
}
