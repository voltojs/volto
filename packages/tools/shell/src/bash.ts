import type { Shell, ToolResult } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import { CAP_SHELL_EXEC } from "./capabilities.js";
import type { BashSessionLike } from "./session-port.js";

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
  show_full_output: z
    .boolean()
    .optional()
    .describe("If true, return full output without truncation"),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "If true, launch in background and return immediately with a process ID. " +
        "Not available under every sandbox mode — when unavailable, the command runs " +
        "in the foreground instead and the result says so.",
    ),
  isolated: z
    .boolean()
    .optional()
    .describe(
      "If true, run this command as a one-shot process: it will not see " +
        "and will not modify the persistent session's cd/export/source state.",
    ),
});

export interface BashToolOptions {
  /**
   * Lazy persistent session. When provided and the call is not
   * isolated / run_in_background, bash routes through session.run.
   */
  getSession?: () => BashSessionLike | undefined;
}

export function createBashTool(shell: Shell, options?: BashToolOptions) {
  return defineTool({
    name: "bash",
    description:
      "Execute a shell command. By default this uses a persistent session so " +
      "cd, export, and source effects carry across calls. Pass isolated=true " +
      "for a one-shot process that neither sees nor changes session state. " +
      "Pass run_in_background=true for a long-lived process (use bash_output / " +
      "kill_shell). Output may be truncated when large.",
    schema: bashSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "WRITE_HIGH",
    commandInputs: ["command"],
    run: async (input): Promise<ToolResult> => {
      const {
        command,
        cwd,
        timeout,
        show_full_output: showFullOutput,
        run_in_background: runInBackground,
        isolated,
      } = input;
      const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS;

      // Background mode: launch via Shell.launch() and return PID immediately
      if (runInBackground && shell.launch) {
        try {
          const pid = await shell.launch(command, { cwd });
          return {
            modelContent:
              `Command launched in background (process_id: ${pid}). ` +
              `It is NOT streaming back automatically — use bash_output(process_id) to read ` +
              `output and kill_shell(process_id) when done.`,
            displayMetadata: {
              processId: pid,
              backgroundPid: pid,
              runInBackground: true,
            },
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

      // Default path: a live persistent session keeps cd/export/source
      // across calls. isolated (or no session) falls through to a one-shot
      // shell.exec below.
      const session = options?.getSession?.();
      if (!isolated && session) {
        try {
          const r = await session.run(command, {
            cwd,
            timeout: effectiveTimeout,
          });
          const resetNote = r.stateResetReason
            ? `\n\n[${r.stateResetReason}]`
            : "";
          const combined =
            r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
          // Same OUTPUT_LIMIT / show_full_output policy as the exec path, so a
          // chatty session cannot flood modelContext.
          const truncated = combined.length > OUTPUT_LIMIT && !showFullOutput;
          const content = truncated
            ? combined.slice(0, OUTPUT_LIMIT)
            : combined;
          const truncationNote = truncated
            ? `\n\n(output truncated: ${combined.length} chars total, showing first ${OUTPUT_LIMIT})`
            : "";
          const exitNote =
            r.exitCode !== 0 ? `\n(exit code: ${r.exitCode})` : "";
          // run_in_background was requested but shell.launch is absent — say so
          // on the session path too, or the model keeps expecting a PID.
          const backgroundNote = backgroundUnavailable
            ? "\n\n(background execution is not available under the active sandbox; ran in the persistent session instead)"
            : "";
          return {
            modelContent: `${content}${exitNote}${truncationNote}${resetNote}${backgroundNote}`,
            displayMetadata: {
              exitCode: r.exitCode,
              fromSession: true,
              stateReset: Boolean(r.stateResetReason),
              truncated,
              totalLength: combined.length,
              ...(backgroundUnavailable ? { backgroundFallback: true } : {}),
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            modelContent: `bash session failed: ${message}`,
            isError: true,
          };
        }
      }

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
