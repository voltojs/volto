import type { ToolDefinition, ToolResult } from "@agent-core/core";

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

export interface FileTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}
