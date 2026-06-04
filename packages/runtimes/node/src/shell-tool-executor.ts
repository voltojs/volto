import type { PendingToolCall, ToolResult, Shell, ShellExecOptions, ShellEvent } from "@agent-core/core";
import type { ShellTool } from "@agent-core/tools-shell";
import { createBashTool } from "@agent-core/tools-shell";
import type { ToolExecutor } from "./runner.js";

export interface CreateShellToolExecutorOptions {
  shell: Shell;
}

export function createShellToolExecutor(options: CreateShellToolExecutorOptions): ToolExecutor {
  const tools: ShellTool[] = [createBashTool(options.shell)];

  return async (call: PendingToolCall, ctx: import("./runner.js").ToolExecutorContext): Promise<ToolResult> => {
    const tool = tools.find((entry) => entry.definition.name === call.name);
    if (!tool) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }

    // Forward abortSignal by wrapping the shell adapter rather than passing
    // through the Zod schema (AbortSignal can't round-trip JSON Schema).
    if (ctx.abortSignal) {
      const abortableShell: Shell = {
        exec: (cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent> =>
          options.shell.exec(cmd, { ...opts, abortSignal: ctx.abortSignal }),
        launch: options.shell.launch
          ? (cmd: string, opts?: Omit<ShellExecOptions, "runInBackground">): Promise<string> =>
              options.shell.launch!(cmd, opts)
          : undefined,
      };
      const abortableTool = createBashTool(abortableShell);
      return abortableTool.handler(call.input);
    }

    return tool.handler(call.input);
  };
}
