import type { Network, ToolResult } from "@agent-core/core";
import { z } from "zod";
import { defineFileTool } from "@agent-core/tools-fs";
import { CAP_NETWORK_FETCH } from "./capabilities.js";

const webFetchSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  method: z.string().optional().describe("HTTP method (default: GET)"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("HTTP headers as key-value pairs"),
});

export function createWebFetchTool(network: Network) {
  return defineFileTool({
    name: "web_fetch",
    description: "Fetch content from a URL via HTTP. Returns the response body text.",
    schema: webFetchSchema,
    requires: [CAP_NETWORK_FETCH],
    riskTier: "READ_ONLY",
    run: async (input): Promise<ToolResult> => {
      const { url, method, headers } = input;
      try {
        const response = await network.fetch({ url, method, headers });
        return {
          modelContent: response.body,
          displayMetadata: {
            status: response.status,
            headers: response.headers,
            bodyLength: response.body.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `web_fetch failed: ${message}`, isError: true };
      }
    },
  });
}
