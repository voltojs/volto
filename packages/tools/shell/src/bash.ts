import type { Shell, ToolResult } from "@voltojs/core";
import { z } from "zod";
import { DEFAULT_TIMEOUTS, defineTool, renderTimeoutSignature } from "@voltojs/tools-common";
import { CAP_SHELL_EXEC } from "./capabilities.js";
import type { BashSessionLike } from "./session-port.js";

const OUTPUT_LIMIT = 100_000;

const bashSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory for command execution"),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Timeout in milliseconds (default: ${DEFAULT_TIMEOUTS.tool}). ` +
        "Raise it for commands you expect to run longer (installs, builds, long tests, sleeps).",
    ),
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
  /**
   * Describe a directory for the cwd confirmation line, e.g.
   * `"/repo-wt (branch: feat/x)"`. The tool layer never asks git itself —
   * the host supplies this, and may resolve it on demand (the note follows
   * the command that moved the shell, so waiting a few ms for the branch is
   * worth more than printing a bare path). Returning undefined makes the note
   * report the bare path rather than invent a branch.
   */
  describeWorkspace?: (cwd: string) => string | undefined | Promise<string | undefined>;
}

export function createBashTool(shell: Shell, options?: BashToolOptions) {
  return defineTool({
    name: "bash",
    description:
      "Execute a shell command. By default this uses a persistent session so " +
      "cd, export, and source effects carry across calls. Pass isolated=true " +
      "for a one-shot process that neither sees nor changes session state. " +
      "Pass run_in_background=true for a long-lived process (use bash_output / " +
      "kill_shell). Output may be truncated when large. A call that outlives " +
      "its timeout is killed (default 120s) — pass timeout for longer commands.",
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
      const effectiveTimeout = timeout ?? DEFAULT_TIMEOUTS.tool;

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
          // A session result flagged timedOut IS a timeout, not a plain
          // failure: classify it as an error and lead with the unified
          // signature (spec D3/§6). The (exit code: N) tail note is kept.
          const sessionTimeoutNote = r.timedOut
            ? `${renderTimeoutSignature("bash", effectiveTimeout)}\n\n`
            : "";
          // Confirm a directory change where the model will read it: the tail
          // of the result for the command that caused it. Appended AFTER the
          // truncation cut (and excluded from OUTPUT_LIMIT) — a cd the model
          // cannot see is worse than a few extra characters.
          // A failing describer must never destroy a successful result: the
          // command already ran, and an isError result would invite a retry
          // with doubled side effects. Degrade to the bare path.
          let cwdNote = "";
          if (r.cwdChanged === true && r.cwdAfter !== undefined) {
            let described: string | undefined;
            try {
              described = await options?.describeWorkspace?.(r.cwdAfter);
            } catch {
              described = undefined;
            }
            cwdNote = `\n\n[cwd: ${described ?? r.cwdAfter}]`;
          }
          return {
            modelContent: `${sessionTimeoutNote}${content}${exitNote}${truncationNote}${resetNote}${backgroundNote}${cwdNote}`,
            ...(r.timedOut ? { isError: true } : {}),
            displayMetadata: {
              exitCode: r.exitCode,
              fromSession: true,
              stateReset: Boolean(r.stateResetReason),
              truncated,
              totalLength: combined.length,
              ...(backgroundUnavailable ? { backgroundFallback: true } : {}),
              ...(r.timedOut ? { timedOut: true } : {}),
              ...(r.cwdAfter !== undefined ? { cwdAfter: r.cwdAfter } : {}),
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

      // Bounded accumulation for the non-session exec path: retain at most
      // OUTPUT_LIMIT chars per stream, keep counting every char the command
      // actually emitted, and keep consuming events after the cap so the
      // producer still drains. show_full_output explicitly asks for the whole
      // text, so that flag opts out of the cap (it is the caller's choice to
      // hold the full buffer, and no truncation is applied to it either).
      let keptStdout = "";
      let keptStderr = "";
      let totalStdout = 0;
      let totalStderr = 0;
      let exitCode = 0;
      // Carried ONLY by the shell adapter's own timeout timer (Task 1);
      // external abort and ordinary exits keep it absent (spec §6).
      let timedOut = false;

      const retain = (kept: string, data: string): string => {
        if (showFullOutput) return kept + data;
        const room = OUTPUT_LIMIT - kept.length;
        return room > 0 ? kept + data.slice(0, room) : kept;
      };

      try {
        // Timeout is handled by the Shell adapter (SIGTERM + SIGKILL grace period).
        // No redundant Promise.race here — the adapter cleans up the child process.
        for await (const event of shell.exec(command, {
          cwd,
          timeout: effectiveTimeout,
        })) {
          if (event.type === "stdout") {
            totalStdout += event.data.length;
            keptStdout = retain(keptStdout, event.data);
          } else if (event.type === "stderr") {
            totalStderr += event.data.length;
            keptStderr = retain(keptStderr, event.data);
          } else if (event.type === "exit") {
            exitCode = event.code;
            if (event.timedOut) timedOut = true;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `bash failed: ${message}`, isError: true };
      }

      const stderrSeparator = totalStderr > 0 ? "\n[stderr]\n" : "";
      const totalCombined = totalStdout + (stderrSeparator ? stderrSeparator.length + totalStderr : 0);
      const keptCombined = keptStdout + stderrSeparator + keptStderr;
      const truncated = totalCombined > OUTPUT_LIMIT && !showFullOutput;
      const content = truncated ? keptCombined.slice(0, OUTPUT_LIMIT) : keptCombined;
      const droppedChars = totalCombined - content.length;
      const truncationNote = truncated
        ? `\n\n(output truncated: ${totalCombined} chars total, showing first ${OUTPUT_LIMIT})`
        : "";
      const exitNote = exitCode !== 0 ? `\n(exit code: ${exitCode})` : "";
      const backgroundNote = backgroundUnavailable
        ? "\n\n(background execution is not available under the active sandbox; ran in the foreground instead)"
        : "";
      // The exit event carrying timedOut:true IS the timeout fact (spec D3/§6):
      // classify as an error and lead with the unified signature. N is the
      // effective per-call timeout (default from DEFAULT_TIMEOUTS.tool). The
      // (exit code: N) tail note is kept when code !== 0.
      const timeoutNote = timedOut
        ? `${renderTimeoutSignature("bash", effectiveTimeout)}\n\n`
        : "";
      const modelContent = `${timeoutNote}${content}${exitNote}${truncationNote}${backgroundNote}`;

      return {
        modelContent,
        ...(timedOut ? { isError: true } : {}),
        displayMetadata: {
          exitCode,
          stdoutLength: totalStdout,
          stderrLength: totalStderr,
          truncated,
          totalLength: totalCombined,
          ...(droppedChars > 0 ? { droppedChars } : {}),
          ...(backgroundUnavailable ? { backgroundFallback: true } : {}),
          ...(timedOut ? { timedOut: true } : {}),
        },
      };
    },
  });
}
