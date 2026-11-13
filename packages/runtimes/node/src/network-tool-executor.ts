import type { PendingToolCall, ToolResult, Network } from "@voltojs/core";
import type { WebTool } from "@voltojs/tools-web";
import { createWebFetchTool, createWebSearchTool } from "@voltojs/tools-web";
import type { ToolExecutor } from "./runner.js";

export interface CreateNetworkToolExecutorOptions {
  network: Network;
}

export function createNetworkToolExecutor(options: CreateNetworkToolExecutorOptions): ToolExecutor {
  const tools: WebTool[] = [
    createWebFetchTool(options.network),
    createWebSearchTool(options.network),
  ];

  return async (call: PendingToolCall, ctx): Promise<ToolResult> => {
    const tool = tools.find((entry) => entry.definition.name === call.name);
    if (!tool) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }

    // Forward the Runner's abortSignal into the tool call so cancellable
    // network requests can be aborted when the agent is cancelled.
    const input = ctx.abortSignal
      ? { ...call.input, abortSignal: ctx.abortSignal }
      : call.input;

    return tool.handler(input);
  };
}
