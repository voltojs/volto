import type { NetworkRequest } from "@voltojs/core";
import {
  SearchAdapterError,
  assertOk,
  optionalString,
  parseJsonBody,
  type SearchAdapter,
  type SearchHit,
  type SearchRequestOptions,
} from "./types.js";

/** Brave's endpoint is a fixed path under the API origin. */
const DEFAULT_ORIGIN = "https://api.search.brave.com";
const SOURCE_ID = "brave";
const LABEL = "Brave";

function normalizeOrigin(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_ORIGIN).trim().replace(/\/+$/, "");
}

function toHits(payload: unknown): SearchHit[] {
  const results = (payload as { web?: { results?: unknown } } | null)?.web?.results;
  if (!Array.isArray(results)) {
    throw new SearchAdapterError("shape", "Brave search response has no web.results array");
  }
  const hits: SearchHit[] = [];
  for (const entry of results) {
    const record = entry as Record<string, unknown> | null;
    const title = optionalString(record?.["title"]);
    const url = optionalString(record?.["url"]);
    if (title === undefined || url === undefined) continue;
    const description = optionalString(record?.["description"]);
    const hit: SearchHit = { title, url };
    if (description !== undefined) hit.snippet = description;
    hits.push(hit);
  }
  return hits;
}

export function createBraveAdapter(): SearchAdapter {
  return {
    id: SOURCE_ID,
    label: LABEL,
    buildRequest(query: string, opts: SearchRequestOptions): NetworkRequest {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (opts.apiKey !== undefined) headers["X-Subscription-Token"] = opts.apiKey;
      return {
        url: `${normalizeOrigin(opts.baseUrl)}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${opts.count}`,
        method: "GET",
        headers,
      };
    },
    parseResponse(resp): SearchHit[] {
      assertOk(resp, LABEL);
      return toHits(parseJsonBody(resp, LABEL));
    },
  };
}
