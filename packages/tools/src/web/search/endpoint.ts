import type { NetworkRequest } from "@voltojs/core";
import {
  SearchAdapterError,
  assertOk,
  optionalString,
  parseJsonBody,
  type EndpointSourceSpec,
  type SearchAdapter,
  type SearchHit,
  type SearchRequestOptions,
} from "./types.js";

const DEFAULT_AUTH = { header: "Authorization", prefix: "Bearer " } as const;
const PLACEHOLDER = /\{\{(query|count)\}\}/g;

/** JSON-escape a string for embedding inside a JSON string literal. */
function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function renderTemplate(
  template: string,
  query: string,
  count: number,
  encodeQuery: boolean,
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) =>
    name === "count" ? String(count) : encodeQuery ? encodeURIComponent(query) : escapeJsonString(query),
  );
}

/** Read a dotted path; numeric segments index arrays. */
function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function requireString(value: unknown, role: string, path: string): string {
  if (typeof value !== "string" || value === "") {
    throw new SearchAdapterError(
      "shape",
      `custom search result is missing the ${role} field (path "${path}")`,
    );
  }
  return value;
}

function toHits(payload: unknown, spec: EndpointSourceSpec): SearchHit[] {
  const list = readPath(payload, spec.paths.list);
  if (!Array.isArray(list)) {
    throw new SearchAdapterError(
      "shape",
      `custom search response has no array at "${spec.paths.list}"`,
    );
  }
  const hits: SearchHit[] = [];
  for (const entry of list) {
    const hit: SearchHit = {
      title: requireString(readPath(entry, spec.paths.title), "title", spec.paths.title),
      url: requireString(readPath(entry, spec.paths.url), "url", spec.paths.url),
    };
    if (spec.paths.snippet !== undefined) {
      const snippet = optionalString(readPath(entry, spec.paths.snippet));
      if (snippet !== undefined) hit.snippet = snippet;
    }
    if (spec.paths.summary !== undefined) {
      const summary = optionalString(readPath(entry, spec.paths.summary));
      if (summary !== undefined) hit.summary = summary;
    }
    if (spec.paths.siteName !== undefined) {
      const siteName = optionalString(readPath(entry, spec.paths.siteName));
      if (siteName !== undefined) hit.siteName = siteName;
    }
    if (spec.paths.date !== undefined) {
      const publishedAt = optionalString(readPath(entry, spec.paths.date));
      if (publishedAt !== undefined) hit.publishedAt = publishedAt;
    }
    hits.push(hit);
  }
  return hits;
}

export function createEndpointAdapter(params: {
  id: string;
  label: string;
  spec: EndpointSourceSpec;
}): SearchAdapter {
  const { id, label, spec } = params;
  const auth = spec.auth ?? DEFAULT_AUTH;

  return {
    id,
    label,
    buildRequest(query: string, opts: SearchRequestOptions): NetworkRequest {
      const headers: Record<string, string> = { ...spec.headers };
      if (opts.apiKey !== undefined) headers[auth.header] = `${auth.prefix}${opts.apiKey}`;

      if (spec.method === "GET") {
        return {
          url: renderTemplate(spec.url, query, opts.count, true),
          method: "GET",
          headers,
        };
      }

      if (spec.bodyTemplate === undefined) {
        throw new SearchAdapterError("shape", "custom search is missing a request body template");
      }
      const body = renderTemplate(spec.bodyTemplate, query, opts.count, false);
      try {
        JSON.parse(body);
      } catch {
        throw new SearchAdapterError(
          "shape",
          "request body template did not render to valid JSON — check the {{query}} quoting",
        );
      }
      return { url: spec.url, method: "POST", headers, body };
    },
    parseResponse(resp): SearchHit[] {
      assertOk(resp, label);
      return toHits(parseJsonBody(resp, label), spec);
    },
  };
}
