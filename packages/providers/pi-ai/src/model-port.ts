import type { Models, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelEvent, ModelPort, ModelRequest, ResolvedModelInfo } from "@volto/core";
import { buildModels, describeModelInfo, resolveConfiguredApiKey, type PiAiProviderConfig } from "./collection.js";
import { toPiContext } from "./context.js";
import { normalizeStream } from "./stream-normalize.js";

export interface CreatePiAiModelPortOptions {
  providers: PiAiProviderConfig[];
  /**
   * Which configured provider `req.model` is resolved against. Required when
   * more than one provider is configured — cross-provider routing (picking
   * the provider per-request) is out of scope for this phase; a future phase
   * will let the config carry both providerId and modelId per request.
   */
  defaultProviderId?: string;
  /** Used when a request omits `req.model`. */
  defaultModel?: string;
}

/**
 * Build a volto ModelPort backed by pi-ai. `req.model` is treated as a model
 * code within the single configured route (`defaultProviderId`, or the sole
 * provider when only one is configured). Fails synchronously at construction
 * time if the route is ambiguous — see resolveProviderId.
 */
export function createPiAiModelPort(opts: CreatePiAiModelPortOptions): ModelPort {
  const providerId = resolveProviderId(opts);
  const models = buildModels(opts.providers);
  const apiKey = resolveConfiguredApiKey(opts.providers, providerId);
  return createPiAiModelPortFromModels(models, providerId, opts.defaultModel, apiKey);
}

/**
 * Same as {@link createPiAiModelPort}, but takes an already-built `Models`
 * collection directly. Exported (not re-exported from index.ts) so tests can
 * inject a `Models` collection carrying a faux/mocked provider without going
 * through real network-backed provider construction — see model-port.test.ts.
 */
export function createPiAiModelPortFromModels(
  models: Models,
  providerId: string,
  defaultModel?: string,
  /**
   * API key injected into every `streamSimple` call for this route (rule 2 —
   * catalog providers carry no baked-in auth; the key travels per request).
   * Undefined for custom providers, whose key is already baked into their
   * `fixedApiKeyAuth` by `buildModels()`.
   */
  requestApiKey?: string,
): ModelPort {
  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      // Entire body is wrapped in try/catch so that any throw (e.g. from
      // describeModelInfo on an unknown model) is converted into an error
      // event rather than escaping the generator. This is a belt-and-braces
      // measure: an async generator function does not execute any of its
      // body until the first `.next()` call, so a throw before the first
      // `yield` already surfaces as a rejected promise (from that `.next()`
      // call), never as a synchronous throw at `stream(req)` call time. The
      // try/catch here does not change that timing; it exists so that a
      // throw is *always* turned into a `{ type: "error" }` event fed back
      // into the ModelPort contract, consistent with how normalizeStream and
      // the rest of this adapter never let a provider failure surface as an
      // uncaught exception.
      try {
        // Step 1: resolve req.model to an exact provider/model.
        const code = req.model ?? defaultModel;
        const model = code === undefined ? undefined : models.getModel(providerId, code);
        if (model === undefined) {
          yield {
            type: "error",
            error: `pi-ai: unable to resolve model "${code ?? "<none>"}" for provider "${providerId}"`,
            retriable: false,
          };
          return;
        }

        // Step 2: validate req.reasoningEffort against the model's declared
        // efforts BEFORE any I/O. describeModelInfo re-looks-up the model,
        // but the model is already known to exist (checked above), so this
        // call cannot throw here.
        if (req.reasoningEffort !== undefined) {
          const info = describeModelInfo(models, providerId, code!);
          const supported = info.reasoning?.efforts.map((e) => e.id) ?? [];
          if (!supported.includes(req.reasoningEffort)) {
            yield {
              type: "error",
              error:
                `pi-ai: model "${code}" does not support reasoning effort "${req.reasoningEffort}"; ` +
                `supported: ${supported.length > 0 ? supported.join(", ") : "(none)"}`,
              retriable: false,
            };
            return;
          }
        }

        // Step 3: translate core's Message[] into a pi-ai Context.
        const context = toPiContext(req, model);

        // Step 4: invoke pi-ai's streaming call.
        // maxTokens/temperature ARE forwarded — per api-notes.md item 2,
        // `SimpleStreamOptions extends StreamOptions`, which declares both
        // `temperature` and `maxTokens` as real per-request fields (not
        // model-level-only). `reasoning` is omitted entirely when no
        // effort was requested: `SimpleStreamOptions.reasoning` is typed as
        // `ThinkingLevel`, which has no "off" member (only the model-level
        // `ModelThinkingLevel` does) — passing the literal "off" would be a
        // type error, so "no reasoning" means omitting the option, not
        // sending an explicit off value.
        const events = models.streamSimple(model, context, {
          signal: req.abortSignal,
          ...(requestApiKey !== undefined ? { apiKey: requestApiKey } : {}),
          ...(req.reasoningEffort !== undefined
            ? { reasoning: req.reasoningEffort as ThinkingLevel }
            : {}),
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        });

        // Step 5: normalize pi-ai's event stream into volto's ModelEvent stream.
        yield* normalizeStream(events, model.id);
      } catch (err) {
        yield {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          retriable: false,
        };
      }
    },
    describeModel: async (model: string): Promise<ResolvedModelInfo> =>
      describeModelInfo(models, providerId, model),
  } satisfies ModelPort;
}

function resolveProviderId(opts: CreatePiAiModelPortOptions): string {
  if (opts.defaultProviderId !== undefined) {
    return opts.defaultProviderId;
  }
  if (opts.providers.length === 1 && opts.providers[0] !== undefined) {
    return opts.providers[0].id;
  }
  throw new Error(
    "createPiAiModelPort: multiple providers configured but no defaultProviderId given; " +
      "cross-provider routing is not supported in this phase. Pass exactly one provider, " +
      "or set defaultProviderId to name the route.",
  );
}
