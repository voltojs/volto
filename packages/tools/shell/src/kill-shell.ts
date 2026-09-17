import type { Shell, ToolResult } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import { CAP_SHELL_EXEC } from "./capabilities.js";

const killShellSchema = z.object({
  process_id: z.string().describe("Process id returned by bash runInBackground"),
});

export function createKillShellTool(shell: Shell) {
  return defineTool({
    name: "kill_shell",
    description:
      "Terminate a background process previously started with bash(runInBackground=true). " +
      "Use this when a process is no longer needed or the background limit is reached.",
    schema: killShellSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "WRITE_HIGH",
    run: async (input): Promise<ToolResult> => {
      if (!shell.killProcess) {
        return {
          modelContent: "kill_shell is not available: the active shell has no process registry.",
          isError: true,
        };
      }
      try {
        await shell.killProcess(input.process_id);
        return { modelContent: `Process ${input.process_id} terminated.` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `kill_shell failed: ${message}`, isError: true };
      }
    },
  });
}
