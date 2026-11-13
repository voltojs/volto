import type { PendingToolCall, ToolResult, Shell, ShellExecOptions, ShellEvent } from "@voltojs/core";
import type { ShellTool, BashToolOptions, BashSessionLike } from "@voltojs/tools-shell";
import { createBashTool, createBashOutputTool, createKillShellTool } from "@voltojs/tools-shell";
import type { ToolExecutor } from "./runner.js";

export interface CreateShellToolExecutorOptions {
  shell: Shell;
  /**
   * Lazy persistent session for bash. When provided, non-isolated bash
   * calls route through session.run — including the abortable branch below.
   * Without this, abort used to rebuild createBashTool(shell) with no
   * options and silently drop session-routed calls onto one-shot exec.
   */
  getSession?: () => BashSessionLike | undefined;
  /**
   * Forwarded to the bash tool so the cwd confirmation line can name the
   * branch. The executor rebuilds the bash tool for abort support, and a
   * dropped option here is invisible in the tool's own tests — it only shows
   * up as a bare `[cwd: …]` in a real run.
   */
  describeWorkspace?: BashToolOptions["describeWorkspace"];
}

export function createShellToolExecutor(options: CreateShellToolExecutorOptions): ToolExecutor {
  const bashOptions: BashToolOptions | undefined =
    options.getSession || options.describeWorkspace
      ? {
          ...(options.getSession ? { getSession: options.getSession } : {}),
          ...(options.describeWorkspace
            ? { describeWorkspace: options.describeWorkspace }
            : {}),
        }
      : undefined;
  const tools: ShellTool[] = [
    createBashTool(options.shell, bashOptions),
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
      // Forward bashOptions so the abort path does not drop session routing.
      return createBashTool(abortableShell, bashOptions).handler(call.input);
    }

    const tool = tools.find((entry) => entry.definition.name === call.name);
    if (!tool) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }

    return tool.handler(call.input);
  };
}
