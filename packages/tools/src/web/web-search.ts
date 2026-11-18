import type { Network, ToolResult } from "@voltojs/core";
import { z } from "zod";
import { defineTool } from "../common/index.js";
import { CAP_NETWORK_FETCH } from "./capabilities.js";
import { createSearchAdapter } from "./search/index.js";
import {
  SearchAdapterError,
  type BuiltinSearchSourceId,
  type EndpointSourceSpec,
  type SearchHit,
} from "./search/types.js";

const webSearchSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  numResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of results to return (default: 5)"),
});

const DEFAULT_COUNT = 5;
const MAX_COUNT = 50;
const MODEL_LIMIT = 4_000;
const META_HITS = 10;
const META_TEXT = 240;

/** What the host resolves from its configuration before wiring the tool. */
export type WebSearchToolOptions =
  | { source: "off" }
  | { source: "none" }
  | {
      source: BuiltinSearchSourceId | "endpoint";
      /** Custom source id, or the builtin id. */
      sourceId: string;
      /** Display name shown in the trace panel. */
      label: string;
      apiKey?: string;
      baseUrl?: string;
      endpoint?: EndpointSourceSpec;
      /** Legacy SDK option: a complete Brave-style endpoint URL. */
      apiUrl?: string;
    };

const GUIDANCE =
  "Web search is not configured. Open Settings → Tools → Web Search to pick a source " +
  "(DeepSeek, which can reuse a model channel's key, Brave, GLM, or a custom search service).";

function clipMeta(value: string): string {
  return value.length <= META_TEXT ? value : `${value.slice(0, META_TEXT - 1)}…`;
}

function formatForModel(hits: SearchHit[], query: string, label: string): string {
  if (hits.length === 0) {
    return `No matching results for "${query}" (${label}).`;
  }
  const lines: string[] = [];
  for (const [index, hit] of hits.entries()) {
    lines.push(`${index + 1}. ${hit.title} — ${hit.url}`);
    const meta = [hit.publishedAt, hit.siteName].filter((part): part is string => part !== undefined);
    if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);
    const digest = hit.summary ?? hit.snippet;
    if (digest !== undefined) lines.push(`   ${digest}`);
  }
  const text = lines.join("\n");
  if (text.length <= MODEL_LIMIT) return text;
  return `${text.slice(0, MODEL_LIMIT)}\n\n(output truncated: ${text.length} chars total, showing first ${MODEL_LIMIT})`;
}

function metadataHits(hits: SearchHit[]): Array<Record<string, string>> {
  return hits.slice(0, META_HITS).map((hit) => {
    const entry: Record<string, string> = { title: hit.title, url: hit.url };
    if (hit.snippet !== undefined) entry["snippet"] = clipMeta(hit.snippet);
    if (hit.summary !== undefined) entry["summary"] = clipMeta(hit.summary);
    if (hit.siteName !== undefined) entry["siteName"] = hit.siteName;
    if (hit.publishedAt !== undefined) entry["publishedAt"] = hit.publishedAt;
    return entry;
  });
}

export function createWebSearchTool(network: Network, opts?: WebSearchToolOptions) {
  return defineTool({
    name: "web_search",
    description:
      "Search the web via the search source the user configured. Returns paginated results with titles, URLs and digests. " +
      "Search syntax such as site:, lang: and after: is forwarded to the search service.",
    schema: webSearchSchema,
    requires: [CAP_NETWORK_FETCH],
    riskTier: "READ_ONLY",
    trust: "untrusted",
    run: async (input): Promise<ToolResult> => {
      const { query } = input;
      if (opts === undefined || opts.source === "none" || opts.source === "off") {
        return { modelContent: GUIDANCE, isError: true };
      }

      const count = Math.min(Math.max(input.numResults ?? DEFAULT_COUNT, 1), MAX_COUNT);
      // abortSignal is injected by the Runner via the tool executor (not exposed to the model).
      const abortSignal = (input as Record<string, unknown>).abortSignal as AbortSignal | undefined;
      const startedAt = Date.now();

      try {
        const adapter = createSearchAdapter({
          source: opts.source,
          id: opts.sourceId,
          label: opts.label,
          ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
          ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
        });
        const request = adapter.buildRequest(query, {
          ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
          ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
          count,
        });
        const response = await network.fetch(
          abortSignal === undefined ? request : { ...request, abortSignal },
        );
        const hits = adapter.parseResponse(response, { count });
        const durationMs = Date.now() - startedAt;
        return {
          modelContent: formatForModel(hits, query, adapter.label),
          displayMetadata: {
            webSearch: {
              sourceId: opts.sourceId,
              sourceLabel: adapter.label,
              query,
              count: hits.length,
              durationMs,
              status: response.status,
              hits: metadataHits(hits),
            },
          },
        };
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        if (error instanceof SearchAdapterError) {
          if (error.kind === "auth") {
            return {
              modelContent:
                `${opts.label} search rejected the API key (HTTP ${error.status ?? 0}). ` +
                "Open Settings → Tools → Web Search to update it.",
              isError: true,
            };
          }
          if (error.kind === "http") {
            return { modelContent: error.message, isError: true };
          }
          return {
            modelContent:
              `${opts.label} search returned an unreadable response: ${error.message}. ` +
              "Check the source configuration in Settings → Tools → Web Search.",
            isError: true,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        void durationMs;
        return { modelContent: `web_search failed: ${message}`, isError: true };
      }
    },
  });
}
