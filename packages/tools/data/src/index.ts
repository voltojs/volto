/**
 * @agent-core/tools-data — structured HTTP query tool
 *
 * http_query wraps the existing Network port with structured output
 * (status code, headers, body), distinct from the simpler web_fetch.
 */

import type { Network } from "@agent-core/core";
import { z } from "zod";
import { defineTool } from "@agent-core/tools-common";
import type { Tool } from "@agent-core/tools-common";

const CAP_NETWORK = "network:fetch";

const MAX_BODY = 50000;

const schema = z.object({
  url: z.string().describe("URL to send the request to."),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional().describe("HTTP method (default: GET)."),
  headers: z.record(z.string(), z.string()).optional().describe("Request headers."),
  body: z.string().optional().describe("Request body (for POST/PUT/PATCH)."),
});

export function createHttpQueryTool(network: Network): Tool {
  return defineTool({
    name: "http_query",
    description: "Send an HTTP request with custom method, headers, and body. Returns status code, response headers, and body.",
    schema,
    requires: [CAP_NETWORK],
    riskTier: "READ_ONLY",
    run: async ({ url, method, headers, body }) => {
      try {
        const response = await network.fetch({
          url,
          method: method ?? "GET",
          headers,
          body,
        });

        let responseBody = response.body;
        let truncated = false;
        if (responseBody.length > MAX_BODY) {
          responseBody = responseBody.slice(0, MAX_BODY) + "\n... [truncated]";
          truncated = true;
        }

        const summary = `HTTP ${response.status} ${response.status < 400 ? "OK" : "Error"}\n${responseBody}`;

        return {
          modelContent: summary,
          displayMetadata: {
            status: response.status,
            headers: response.headers,
            bodyLength: response.body.length,
            truncated,
          },
        };
      } catch (err) {
        return {
          modelContent: `http_query failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}

export const HTTP_TOOL_NAMES: ReadonlySet<string> = new Set(["http_query"]);
