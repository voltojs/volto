import type { NetworkRequest, NetworkResponse } from "@voltojs/core";

/** Search engines Volto wires out of the box. */
export type BuiltinSearchSourceId = "deepseek" | "brave" | "glm";

/** One normalized search result, whatever the upstream source returned. */
export interface SearchHit {
  title: string;
  url: string;
  /** Short digest for lists and the trace panel. */
  snippet?: string;
  /** Longer digest for the model. */
  summary?: string;
  siteName?: string;
  /** Publication time as reported by the source; never parsed or normalized. */
  publishedAt?: string;
}

export interface SearchRequestOptions {
  apiKey?: string;
  /**
   * API base for the source. Adapters own the normalization rules: DeepSeek
   * accepts `/v1` or not, BRAVE takes an origin, GLM defaults to
   * `https://open.bigmodel.cn/api`.
   */
  baseUrl?: string;
  count: number;
}

export type SearchAdapterErrorKind = "auth" | "http" | "shape";

/** A failure that maps onto one of the three guidance messages the tool emits. */
export class SearchAdapterError extends Error {
  readonly kind: SearchAdapterErrorKind;
  readonly status?: number;

  constructor(kind: SearchAdapterErrorKind, message: string, status?: number) {
    super(message);
    this.name = "SearchAdapterError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** User-declared REST search source, authored in the settings UI. */
export interface EndpointSourceSpec {
  method: "GET" | "POST";
  /** GET: {{query}} / {{count}} live in the query string. POST: the full endpoint URL. */
  url: string;
  /** Extra static headers, merged under the auth header. */
  headers?: Record<string, string>;
  /** Defaults to `{ header: "Authorization", prefix: "Bearer " }`. */
  auth?: { header: string; prefix: string };
  /**
   * POST only. `{{query}}` expands to the JSON-escaped string (the user
   * supplies the quotes); `{{count}}` expands to a number.
   */
  bodyTemplate?: string;
  paths: {
    /** Path to the results array (dotted; numeric segments index arrays). */
    list: string;
    title: string;
    url: string;
    snippet?: string;
    summary?: string;
    siteName?: string;
    date?: string;
  };
}

export interface SearchAdapter {
  /** Stable id: a builtin id or the custom source's id. */
  id: string;
  /** Display name shown in the trace panel and the settings card. */
  label: string;
  /** Pure: how the request is spelled. */
  buildRequest(query: string, opts: SearchRequestOptions): NetworkRequest;
  /** Pure: how the response is normalized; throws SearchAdapterError. */
  parseResponse(resp: NetworkResponse, opts: SearchRequestOptions): SearchHit[];
}

/** Trim a response body for an error message. */
export function clipBody(body: string, limit = 400): string {
  const single = body.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

/** Clamp a query to a source's character budget. */
export function clampQuery(query: string, limit: number): string {
  const points = Array.from(query);
  return points.length <= limit ? query : points.slice(0, limit).join("");
}

/**
 * Shared HTTP status handling. Only 401 is treated as an auth failure: the
 * Network port answers an egress denial with 403, and that body carries the
 * host name the user needs to fix their allowlist — swallowing it behind an
 * "invalid key" message would send them to the wrong place.
 */
export function assertOk(resp: NetworkResponse, label: string): void {
  if (resp.status === 401) {
    throw new SearchAdapterError(
      "auth",
      `${label} search rejected the API key (HTTP ${resp.status})`,
      resp.status,
    );
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new SearchAdapterError(
      "http",
      `${label} search failed (HTTP ${resp.status}): ${clipBody(resp.body)}`,
      resp.status,
    );
  }
}

/** Parse a JSON body, failing as a shape error rather than throwing raw. */
export function parseJsonBody(resp: NetworkResponse, label: string): unknown {
  try {
    return JSON.parse(resp.body) as unknown;
  } catch {
    throw new SearchAdapterError("shape", `${label} search returned a non-JSON body`);
  }
}

/** Read one string field; absent/wrong-typed values are undefined. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
