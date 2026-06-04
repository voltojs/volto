import type { Network, ToolResult } from "@agent-core/core";
import { z } from "zod";
import { defineFileTool } from "@agent-core/tools-fs";
import { CAP_NETWORK_FETCH } from "./capabilities.js";

const webSearchSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  numResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of results to return (default: 5)"),
});

export function createWebSearchTool(network: Network) {
  return defineFileTool({
    name: "web_search",
    description:
      "Search the web via a search API endpoint. Returns search results as text.",
    schema: webSearchSchema,
    requires: [CAP_NETWORK_FETCH],
    riskTier: "READ_ONLY",
    run: async (input): Promise<ToolResult> => {
      const { query, numResults } = input;
      try {
        const maxResults = numResults ?? 5;
        const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
        const response = await network.fetch({
          url: searchUrl,
          method: "GET",
          headers: { Accept: "application/json" },
        });
        return {
          modelContent: response.body,
          displayMetadata: {
            status: response.status,
            bodyLength: response.body.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `web_search failed: ${message}`, isError: true };
      }
    },
  });
}
