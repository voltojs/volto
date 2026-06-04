import type { PendingToolCall, ToolResult, ToolDefinition, Shell } from "@agent-core/core";
import { routeToolCall } from "@agent-core/core";
import type { ShellTool } from "@agent-core/tools-shell";
import { createBashTool, CAP_SHELL_EXEC } from "@agent-core/tools-shell";
import type { ToolExecutor } from "./runner.js";

export interface CreateShellToolExecutorOptions {
  shell: Shell;
}

export function createShellToolExecutor(options: CreateShellToolExecutorOptions): ToolExecutor {
  const tools: ShellTool[] = [createBashTool(options.shell)];
  const definitions: ToolDefinition[] = tools.map((entry) => entry.definition);
  const capabilities = new Set<string>([CAP_SHELL_EXEC]);

  return async (call: PendingToolCall): Promise<ToolResult> => {
    const routed = routeToolCall(definitions, capabilities, call);
    if (routed.result) return routed.result;

    const tool = tools.find((entry) => entry.definition.name === call.name);
    if (!tool) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }

    return tool.handler(call.input);
  };
}
