/**
 * Reveal a filesystem path in the OS file manager.
 *
 * The browser cannot open Finder/Explorer on the gateway's machine, so the
 * gateway runs the platform's native "show this folder" command itself —
 * same trust model as `directory-picker.ts`: local callers name a path, the
 * gateway hands it to the OS.
 */

import {
  CommandFailedError,
  CommandNotFoundError,
  execFileRunner,
  type CommandRunner,
} from "./command-runner.js";

/** No usable file-manager command on this platform. */
export class RevealUnsupportedError extends Error {}

/** The path is missing, relative, or otherwise not revealable. */
export class RevealInvalidPathError extends Error {}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Absolute-path check that matches the *target* platform, not the host
 * running the code — `path.isAbsolute("C:\\x")` is false on POSIX, and a
 * Windows path is exactly what a win32 revealer will be handed.
 */
function isAbsolutePath(target: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\");
  }
  return target.startsWith("/");
}

/** Parent directory via string ops so Windows paths work on a POSIX host. */
function parentDirectory(target: string): string {
  const cut = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  if (cut <= 0) {
    return target.startsWith("/") ? "/" : target;
  }
  return target.slice(0, cut);
}

/** Candidate commands per platform, tried in order until one is installed. */
function commandFor(
  platform: NodeJS.Platform,
  target: string,
): Array<{ command: string; args: string[] }> {
  switch (platform) {
    case "darwin":
      // `open -R` reveals the item in its enclosing folder.
      return [{ command: "open", args: ["-R", target] }];
    case "linux":
      // xdg-open has no "select" mode; open the containing directory.
      return [{ command: "xdg-open", args: [parentDirectory(target)] }];
    case "win32":
      // `/select,` must be a single argument — no space after the comma.
      return [{ command: "explorer", args: [`/select,${target}`] }];
    default:
      return [];
  }
}

export function createPathRevealer(
  opts: {
    runner?: CommandRunner;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
  } = {},
) {
  const runner = opts.runner ?? execFileRunner;
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    /**
     * Open the OS file manager with `target` selected (or its parent when
     * the platform has no select mode). Resolves when the command exits.
     */
    async reveal(target: string): Promise<void> {
      const trimmed = target.trim();
      if (trimmed === "" || !isAbsolutePath(trimmed, platform)) {
        throw new RevealInvalidPathError("An absolute path is required");
      }

      const candidates = commandFor(platform, trimmed);
      if (candidates.length === 0) {
        throw new RevealUnsupportedError(
          `Cannot reveal a path on platform "${platform}"`,
        );
      }

      let missing = 0;
      for (const candidate of candidates) {
        try {
          await runner(candidate.command, candidate.args, timeoutMs);
          return;
        } catch (error) {
          if (error instanceof CommandNotFoundError) {
            missing += 1;
            continue;
          }
          // explorer.exe exits with code 1 even on success; treat a
          // non-zero exit as success on win32 once the binary itself ran.
          if (error instanceof CommandFailedError && platform === "win32") {
            return;
          }
          throw error;
        }
      }

      throw new RevealUnsupportedError(
        missing === candidates.length
          ? "No file manager command is installed."
          : "Could not reveal the path",
      );
    },
  };
}
