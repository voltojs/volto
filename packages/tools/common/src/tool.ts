import type { ToolDefinition, ToolResult } from "@volto/core";

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

/** Generic tool: a definition + handler pair. Works for all tool categories. */
export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}
