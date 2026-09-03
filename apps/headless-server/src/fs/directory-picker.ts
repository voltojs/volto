/**
 * Native directory selection.
 *
 * The browser cannot supply an absolute path — `webkitdirectory` only exposes
 * a path relative to the chosen folder, and `showDirectoryPicker()` exposes no
 * path at all. So the gateway opens the dialog on the machine it runs on and
 * returns the absolute path itself.
 *
 * Consequence: this only works where the gateway has a graphical session. A
 * headless environment never hangs — that guarantee holds regardless — but
 * what it reports depends on whether a dialog binary is installed: an
 * unknown platform, or a platform with no candidate binary present, throws
 * `PickerUnsupportedError`; a platform where the binary IS installed (e.g. an
 * SSH session into a Linux box with `zenity`) but has no graphical session to
 * attach to typically has that binary exit non-zero with no output, which
 * `pick()` cannot distinguish from a real cancellation — see the note beside
 * that branch below.
 */

import {
  CommandFailedError,
  CommandNotFoundError,
  execFileRunner,
  type CommandRunner,
} from "./command-runner.js";

/** A dialog is already open; opening a second one would confuse the user. */
export class PickerBusyError extends Error {}

/** No usable dialog command on this platform (or no graphical session). */
export class PickerUnsupportedError extends Error {}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The dialog prompt is a constant on purpose. `osascript -e` evaluates its
 * argument as AppleScript, so any caller-controlled text here would be an
 * injection vector. `pick()` deliberately takes no parameters.
 */
const PROMPT = "选择项目目录";

const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms;",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
  // PROMPT is interpolated into a PowerShell single-quoted string literal: a
  // future PROMPT containing `'` would break the script's syntax. Safe today
  // because PROMPT is a module constant with no quote in it (see the comment
  // on PROMPT above) — same constraint as the AppleScript branch below.
  `$d.Description = '${PROMPT}';`,
  "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
].join(" ");

/** Candidate commands per platform, tried in order until one is installed. */
function candidatesFor(platform: NodeJS.Platform): Array<{ command: string; args: string[] }> {
  switch (platform) {
    case "darwin":
      return [
        {
          command: "osascript",
          args: ["-e", `POSIX path of (choose folder with prompt "${PROMPT}")`],
        },
      ];
    case "linux":
      return [
        { command: "zenity", args: ["--file-selection", "--directory", `--title=${PROMPT}`] },
        { command: "kdialog", args: ["--getexistingdirectory", process.env["HOME"] ?? "/"] },
      ];
    case "win32":
      return [
        {
          command: "powershell",
          args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
        },
      ];
    default:
      return [];
  }
}

/**
 * Trim whitespace and drop a trailing slash.
 *
 * macOS returns `/Users/leo/demo/`; without this the same directory would be
 * stored twice under two spellings and would not match the agent's cwd.
 */
export function normalizeDirectoryPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

export function createDirectoryPicker(
  opts: {
    runner?: CommandRunner;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
  } = {},
) {
  const runner = opts.runner ?? execFileRunner;
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let open = false;

  return {
    /** Resolves to the chosen absolute path, or null when the user cancels. */
    async pick(): Promise<string | null> {
      if (open) {
        throw new PickerBusyError("A directory picker is already open");
      }

      const candidates = candidatesFor(platform);
      if (candidates.length === 0) {
        throw new PickerUnsupportedError(
          `No native directory dialog is available on platform "${platform}"`,
        );
      }

      open = true;
      try {
        let missing = 0;
        for (const candidate of candidates) {
          try {
            const stdout = await runner(candidate.command, candidate.args, timeoutMs);
            const normalized = normalizeDirectoryPath(stdout);
            // Windows' FolderBrowserDialog exits 0 with empty stdout on
            // cancel (unlike macOS/Linux, which exit non-zero — see the
            // CommandFailedError branch below). Without this, a cancel would
            // resolve here as `{ path: "" }` instead of the documented
            // `{ path: null }`.
            return normalized === "" ? null : normalized;
          } catch (error) {
            if (error instanceof CommandNotFoundError) {
              missing += 1;
              continue;
            }
            // A non-zero exit with nothing on stdout is how every one of these
            // dialogs reports "the user closed me without choosing". This is
            // a heuristic, not a certainty: the same signature (non-zero,
            // empty stdout) is also what the binary produces when it is
            // installed but fails to open at all (e.g. no graphical session
            // to attach to, such as a plain SSH login). We cannot tell those
            // two apart from here, so a dialog that never appeared is
            // reported to the caller as `{ path: null }`, indistinguishable
            // from a genuine cancellation.
            if (error instanceof CommandFailedError && error.stdout.trim() === "") {
              return null;
            }
            throw error;
          }
        }

        throw new PickerUnsupportedError(
          missing === candidates.length
            ? "No directory dialog is installed. A graphical session is required."
            : "Could not open a directory dialog",
        );
      } finally {
        open = false;
      }
    },
  };
}
