import { createBraveAdapter } from "./brave.js";
import { createDeepSeekAdapter } from "./deepseek.js";
import { createEndpointAdapter } from "./endpoint.js";
import { createGlmAdapter } from "./glm.js";
import type { BuiltinSearchSourceId, EndpointSourceSpec, SearchAdapter } from "./types.js";

export interface SearchAdapterInput {
  source: BuiltinSearchSourceId | "endpoint";
  /** Custom source id, or the builtin id. */
  id: string;
  label: string;
  endpoint?: EndpointSourceSpec;
  /**
   * Legacy SDK option: a complete Brave-style endpoint that already carries
   * its path. Kept working by expressing it as a GET endpoint source.
   */
  apiUrl?: string;
}

const BUILTIN_FACTORIES: Record<BuiltinSearchSourceId, () => SearchAdapter> = {
  deepseek: createDeepSeekAdapter,
  brave: createBraveAdapter,
  glm: createGlmAdapter,
};

/**
 * A complete legacy `apiUrl` is the old Brave shape: `GET <url>?q=&count=`
 * with the subscription token in its own header. Express it as a custom GET
 * endpoint so there is still one request implementation.
 */
function legacyBraveEndpoint(apiUrl: string): EndpointSourceSpec {
  const separator = apiUrl.includes("?") ? "&" : "?";
  return {
    method: "GET",
    url: `${apiUrl}${separator}q={{query}}&count={{count}}`,
    headers: { Accept: "application/json" },
    auth: { header: "X-Subscription-Token", prefix: "" },
    paths: {
      list: "web.results",
      title: "title",
      url: "url",
      snippet: "description",
    },
  };
}

export function createSearchAdapter(input: SearchAdapterInput): SearchAdapter {
  if (input.apiUrl !== undefined) {
    return createEndpointAdapter({
      id: input.id,
      label: input.label,
      spec: legacyBraveEndpoint(input.apiUrl),
    });
  }
  if (input.source === "endpoint") {
    if (input.endpoint === undefined) {
      throw new Error("custom endpoint search source is missing its endpoint spec");
    }
    return createEndpointAdapter({ id: input.id, label: input.label, spec: input.endpoint });
  }
  return BUILTIN_FACTORIES[input.source]();
}

export type { SearchAdapter } from "./types.js";
