import type { PendingToolCall, ToolResult, ToolDefinition, Network } from "@agent-core/core";
import { routeToolCall } from "@agent-core/core";
import type { WebTool } from "@agent-core/tools-web";
import { createWebFetchTool, createWebSearchTool, CAP_NETWORK_FETCH } from "@agent-core/tools-web";
import type { ToolExecutor } from "./runner.js";

export interface CreateNetworkToolExecutorOptions {
  network: Network;
}

export function createNetworkToolExecutor(options: CreateNetworkToolExecutorOptions): ToolExecutor {
  const tools: WebTool[] = [
    createWebFetchTool(options.network),
    createWebSearchTool(options.network),
  ];
  const definitions: ToolDefinition[] = tools.map((entry) => entry.definition);
  const capabilities = new Set<string>([CAP_NETWORK_FETCH]);

  return async (call: PendingToolCall, ctx): Promise<ToolResult> => {
    const routed = routeToolCall(definitions, capabilities, call);
    if (routed.result) return routed.result;

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
