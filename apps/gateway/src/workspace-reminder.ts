/**
 * Workspace reminders for the gateway (spec 2026-11-10 D4).
 *
 * Turns a directory into the `{key, announce}` pair the SDK injects as a
 * `<system-reminder>`: the key fingerprints "cwd + branch" so an unchanged
 * workspace costs nothing, and the announce text tells the model exactly where
 * it is. Every failure mode degrades to "say less" — a probe that cannot run
 * (no git, timeout, dubious ownership) never fails a turn and never guesses.
 */
import { execFile } from "node:child_process";

export interface WorkspaceReminder {
  /** Fingerprint: changes exactly when the model's answer would change. */
  key: string;
  /** Model-facing text; the host owns this wording. */
  announce: string;
}

/** One git invocation. Returns the exit code instead of throwing on failure. */
export type GitProbe = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const NOT_A_REPO = /not a git repository/i;
const PROBE_TIMEOUT_MS = 2000;

/**
 * The production probe: `git -C <cwd> <args>` with a 2s ceiling. A missing
 * binary rejects; a non-zero exit resolves with its code so the caller can
 * tell "not a repository" from "git could not answer".
 */
export function defaultGitProbe(cwd: string): GitProbe {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        "git",
        ["-C", cwd, ...args],
        { timeout: PROBE_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          // A numeric code means git ran and answered; anything else (ENOENT,
          // a timeout kill) means it could not, which is a different fact.
          if (typeof code === "number") {
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            return;
          }
          reject(error);
        },
      );
    });
}

/**
 * Build the reminder for `cwd`. Undefined only when there is no directory to
 * report: a directory with no git still gets a reminder, because knowing where
 * it is matters more than knowing which branch it is on.
 */
export async function buildWorkspaceReminder(
  cwd: string,
  git: GitProbe = defaultGitProbe(cwd),
): Promise<WorkspaceReminder | undefined> {
  if (cwd === "") return undefined;

  const state = await resolveGitState(git);
  const announce = [
    `Working directory: ${safeInline(cwd)}`,
    ...(state !== undefined ? [state.line] : []),
  ].join("\n");

  return { key: `${cwd}\u0000${state?.fingerprint ?? ""}`, announce };
}

/**
 * Keep a path from breaking out of the `<system-reminder>` wrapper the reducer
 * puts around this text. A directory name is user-controlled input, so `<` and
 * `>` are percent-encoded: the model still reads an unambiguous path, but no
 * name can close the block and add instructions inside it.
 */
function safeInline(value: string): string {
  // Control characters are filtered by code point rather than by a regex
  // range: a control-character character class is exactly what the lint rule
  // `no-control-regex` forbids, and this is clearer about the intent anyway.
  const printable = Array.from(value)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
  return printable.replace(/</g, "%3C").replace(/>/g, "%3E");
}

/** One trustworthy git fact: how it reads to the model, and its key fragment. */
interface GitState {
  line: string;
  fingerprint: string;
}

/**
 * The git state, or undefined when nothing trustworthy can be said. Returns
 * the finished LINE rather than a branch name: "no repository" and "branch X"
 * are different sentences, and letting the caller re-derive them invites
 * writing `Git branch: none`.
 */
async function resolveGitState(git: GitProbe): Promise<GitState | undefined> {
  let head: { code: number; stdout: string; stderr: string };
  try {
    head = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    // git is absent or the probe timed out: report the directory only.
    return undefined;
  }

  if (head.code !== 0) {
    // "Not a repository" is a fact worth stating; any other failure is not
    // diagnosable from here, so it stays silent rather than guessing.
    return NOT_A_REPO.test(head.stderr)
      ? { line: "Git repository: none", fingerprint: "none" }
      : undefined;
  }

  const name = head.stdout.trim();
  if (name === "") return undefined;
  if (name !== "HEAD") return { line: `Git branch: ${name}`, fingerprint: name };

  // Detached: the symbolic name is literally "HEAD", so ask for the sha. A
  // failed second call still says detached, just without the commit.
  try {
    const sha = await git(["rev-parse", "--short", "HEAD"]);
    const short = sha.stdout.trim();
    const label = short === "" ? "(detached)" : `(detached at ${short})`;
    return { line: `Git branch: ${label}`, fingerprint: label };
  } catch {
    return { line: "Git branch: (detached)", fingerprint: "(detached)" };
  }
}