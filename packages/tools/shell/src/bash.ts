import type { Shell, ToolResult } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import { CAP_SHELL_EXEC } from "./capabilities.js";

const OUTPUT_LIMIT = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const bashSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory for command execution"),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`),
  showFullOutput: z
    .boolean()
    .optional()
    .describe("If true, return full output without truncation"),
  runInBackground: z
    .boolean()
    .optional()
    .describe(
      "If true, launch in background and return immediately with a process ID. " +
        "Not available under every sandbox mode — when unavailable, the command runs " +
        "in the foreground instead and the result says so.",
    ),
});

export function createBashTool(shell: Shell) {
  return defineTool({
    name: "bash",
    description:
      "Execute a shell command via child process. Supports timeout and working directory. Output may be truncated when large.",
    schema: bashSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "WRITE_HIGH",
    run: async (input): Promise<ToolResult> => {
      const { command, cwd, timeout, showFullOutput, runInBackground } = input;
      const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS;

      // Background mode: launch via Shell.launch() and return PID immediately
      if (runInBackground && shell.launch) {
        try {
          const pid = await shell.launch(command, { cwd });
          return {
            modelContent: `Command launched in background (PID: ${pid}). Output will stream as it becomes available.`,
            displayMetadata: { backgroundPid: pid, runInBackground: true },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { modelContent: `bash background launch failed: ${message}`, isError: true };
        }
      }

      // Background was requested but the active sandbox has no launch() —
      // fall through to foreground exec below, and say so on the way out
      // (both to the model, so it stops expecting an immediate PID, and to
      // the UI/log channel, so a stalled-looking 30s call is explained).
      const backgroundUnavailable = Boolean(runInBackground) && !shell.launch;

      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      try {
        // Timeout is handled by the Shell adapter (SIGTERM + SIGKILL grace period).
        // No redundant Promise.race here — the adapter cleans up the child process.
        for await (const event of shell.exec(command, {
          cwd,
          timeout: effectiveTimeout,
        })) {
          if (event.type === "stdout") {
            stdout += event.data;
          } else if (event.type === "stderr") {
            stderr += event.data;
          } else if (event.type === "exit") {
            exitCode = event.code;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `bash failed: ${message}`, isError: true };
      }

      const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
      const truncated = combined.length > OUTPUT_LIMIT && !showFullOutput;
      const content = truncated ? combined.slice(0, OUTPUT_LIMIT) : combined;
      const truncationNote = truncated
        ? `\n\n(output truncated: ${combined.length} chars total, showing first ${OUTPUT_LIMIT})`
        : "";
      const exitNote = exitCode !== 0 ? `\n(exit code: ${exitCode})` : "";
      const backgroundNote = backgroundUnavailable
        ? "\n\n(background execution is not available under the active sandbox; ran in the foreground instead)"
        : "";
      const modelContent = `${content}${exitNote}${truncationNote}${backgroundNote}`;

      return {
        modelContent,
        displayMetadata: {
          exitCode,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          truncated,
          totalLength: combined.length,
          ...(backgroundUnavailable ? { backgroundFallback: true } : {}),
        },
      };
    },
  });
}
