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

/** GLM's own base already carries `/api`; its search path hangs off that. */
const DEFAULT_BASE = "https://open.bigmodel.cn/api";
const MAX_QUERY = 70;
const SOURCE_ID = "glm";
const LABEL = "GLM";

function normalizeBase(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
}

function toHits(payload: unknown): SearchHit[] {
  const results = (payload as { search_result?: unknown } | null)?.search_result;
  if (!Array.isArray(results)) {
    throw new SearchAdapterError("shape", "GLM search response has no search_result array");
  }
  const hits: SearchHit[] = [];
  for (const entry of results) {
    const record = entry as Record<string, unknown> | null;
    const title = optionalString(record?.["title"]);
    const url = optionalString(record?.["link"]);
    if (title === undefined || url === undefined) continue;
    const content = optionalString(record?.["content"]);
    const hit: SearchHit = { title, url };
    if (content !== undefined) {
      hit.snippet = content;
      hit.summary = content;
    }
    const siteName = optionalString(record?.["media"]);
    if (siteName !== undefined) hit.siteName = siteName;
    const publishedAt = optionalString(record?.["publish_date"]);
    if (publishedAt !== undefined) hit.publishedAt = publishedAt;
    hits.push(hit);
  }
  return hits;
}

export function createGlmAdapter(): SearchAdapter {
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
        url: `${normalizeBase(opts.baseUrl)}/paas/v4/web_search`,
        method: "POST",
        headers,
        body: JSON.stringify({
          search_query: clampQuery(query, MAX_QUERY),
          search_engine: "search_std",
          count: opts.count,
        }),
      };
    },
    parseResponse(resp): SearchHit[] {
      assertOk(resp, LABEL);
      return toHits(parseJsonBody(resp, LABEL));
    },
  };
}
