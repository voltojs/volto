/**
 * Child-process execution for the native directory dialogs.
 *
 * The three failure modes are distinguished here so the picker above can map
 * them to protocol responses. These classifications come from measured
 * `execFile` behaviour: a killed process reports `killed: true`, a missing
 * binary reports `code: "ENOENT"`, and an ordinary non-zero exit reports a
 * numeric `code`.
 */

import { execFile } from "node:child_process";

/** The dialog binary is not installed on this machine. */
export class CommandNotFoundError extends Error {}

/** The command ran and exited non-zero. `stdout` is whatever it printed first. */
export class CommandFailedError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
  ) {
    super(message);
  }
}

/** The command was still running when the timeout elapsed and was killed. */
export class CommandTimeoutError extends Error {}

/** Runs a command and resolves with its stdout. */
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

interface ExecError extends Error {
  killed?: boolean;
  code?: number | string | null;
}

export const execFileRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    // Arguments are passed as an array, never through a shell, so nothing here
    // is subject to shell word-splitting or interpolation.
    execFile(command, args, { timeout: timeoutMs }, (error, stdout) => {
      if (!error) {
        resolve(stdout);
        return;
      }

      const err = error as ExecError;
      if (err.killed) {
        reject(new CommandTimeoutError(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (err.code === "ENOENT") {
        reject(new CommandNotFoundError(`${command} is not installed`));
        return;
      }
      reject(new CommandFailedError(`${command} exited with ${String(err.code)}`, stdout));
    });
  });
