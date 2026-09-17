import type { PendingToolCall, ToolResult, Shell, ShellExecOptions, ShellEvent } from "@volto/core";
import type { ShellTool } from "@volto/tools-shell";
import { createBashTool, createBashOutputTool, createKillShellTool } from "@volto/tools-shell";
import type { ToolExecutor } from "./runner.js";

export interface CreateShellToolExecutorOptions {
  shell: Shell;
}

export function createShellToolExecutor(options: CreateShellToolExecutorOptions): ToolExecutor {
  const tools: ShellTool[] = [
    createBashTool(options.shell),
    createBashOutputTool(options.shell),
    createKillShellTool(options.shell),
  ];

  return async (call: PendingToolCall, ctx: import("./runner.js").ToolExecutorContext): Promise<ToolResult> => {
    // Forward abortSignal into bash's exec/launch only. bash_output and
    // kill_shell are short registry lookups with no streaming to cancel, so
    // they use the original shell as-is.
    if (call.name === "bash" && ctx.abortSignal) {
      const abortableShell: Shell = {
        ...options.shell,
        exec: (cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent> =>
          options.shell.exec(cmd, { ...opts, abortSignal: ctx.abortSignal }),
      };
      return createBashTool(abortableShell).handler(call.input);
    }

    const tool = tools.find((entry) => entry.definition.name === call.name);
    if (!tool) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }

    return tool.handler(call.input);
  };
}
