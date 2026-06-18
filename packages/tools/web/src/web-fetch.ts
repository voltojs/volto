import type { Network, ToolResult } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import { CAP_NETWORK_FETCH } from "./capabilities.js";

const OUTPUT_LIMIT = 100_000;

const webFetchSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  method: z.string().optional().describe("HTTP method (default: GET)"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("HTTP headers as key-value pairs"),
});

export function createWebFetchTool(network: Network) {
  return defineTool({
    name: "web_fetch",
    description: "Fetch content from a URL via HTTP. Returns the response body text.",
    schema: webFetchSchema,
    requires: [CAP_NETWORK_FETCH],
    riskTier: "READ_ONLY",
    trust: "untrusted",
    run: async (input): Promise<ToolResult> => {
      const { url, method, headers } = input;
      // abortSignal is injected by the Runner via the tool executor (not exposed to the model).
      const abortSignal = (input as Record<string, unknown>).abortSignal as AbortSignal | undefined;
      try {
        const response = await network.fetch({ url, method, headers, abortSignal });
        const truncated = response.body.length > OUTPUT_LIMIT;
        const content = truncated ? response.body.slice(0, OUTPUT_LIMIT) : response.body;
        const truncationNote = truncated
          ? `\n\n(output truncated: ${response.body.length} chars total, showing first ${OUTPUT_LIMIT})`
          : "";
        return {
          modelContent: `${content}${truncationNote}`,
          displayMetadata: {
            status: response.status,
            headers: response.headers,
            bodyLength: response.body.length,
            truncated,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `web_fetch failed: ${message}`, isError: true };
      }
    },
  });
}
