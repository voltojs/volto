import type { NetworkRequest } from "@voltojs/core";
import {
  SearchAdapterError,
  assertOk,
  clampQuery,
  optionalString,
  parseJsonBody,
  type SearchAdapter,
  type SearchHit,
  type SearchRequestOptions,
} from "./types.js";

const DEFAULT_BASE = "https://api.deepseek.com";
const MAX_QUERY = 128;
const SOURCE_ID = "deepseek";
const LABEL = "DeepSeek";

/**
 * DeepSeek documents the search endpoint as `{base}/v1/tools/search`, while a
 * model channel's baseURL is commonly written with a trailing `/v1`. Accept
 * both: strip trailing slashes, then a trailing `/v1` so the path is never
 * doubled.
 */
function normalizeBase(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
}

function toHits(payload: unknown): SearchHit[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    throw new SearchAdapterError("shape", "DeepSeek search response has no results array");
  }
  const hits: SearchHit[] = [];
  for (const entry of results) {
    const record = entry as Record<string, unknown> | null;
    const title = optionalString(record?.["title"]);
    const url = optionalString(record?.["url"]);
    if (title === undefined || url === undefined) continue;
    const hit: SearchHit = { title, url };
    const snippet = optionalString(record?.["snippet"]);
    if (snippet !== undefined) hit.snippet = snippet;
    const summary = optionalString(record?.["summary"]);
    if (summary !== undefined) hit.summary = summary;
    const siteName = optionalString(record?.["site_name"]);
    if (siteName !== undefined) hit.siteName = siteName;
    const publishedAt = optionalString(record?.["date"]);
    if (publishedAt !== undefined) hit.publishedAt = publishedAt;
    hits.push(hit);
  }
  return hits;
}

export function createDeepSeekAdapter(): SearchAdapter {
  return {
    id: SOURCE_ID,
    label: LABEL,
    buildRequest(query: string, opts: SearchRequestOptions): NetworkRequest {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (opts.apiKey !== undefined) headers["Authorization"] = `Bearer ${opts.apiKey}`;
      return {
        url: `${normalizeBase(opts.baseUrl)}/v1/tools/search`,
        method: "POST",
        headers,
        body: JSON.stringify({
          query: clampQuery(query, MAX_QUERY),
          count: opts.count,
          need_content: false,
        }),
      };
    },
    parseResponse(resp, opts): SearchHit[] {
      assertOk(resp, LABEL);
      return toHits(parseJsonBody(resp, LABEL));
    },
  };
}
