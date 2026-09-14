/**
 * Workspace Git adapter for the headless server.
 *
 * Every Git invocation goes through an injectable `GitRunner` that takes an
 * argv array plus a fixed `cwd` — never a shell-interpolated command string.
 * This keeps the module unit-testable and free of injection surfaces.
 * I/O stays in the imperative shell: nothing here belongs in `@volto/core`.
 */

import { execFile } from "node:child_process";

/** Milliseconds before a Git subprocess is killed. */
export const GIT_TIMEOUT_MS = 10_000;

/** Default number of branches returned when the caller does not pass a limit. */
export const BRANCH_DEFAULT_LIMIT = 200;

/** Default number of graph nodes returned when the caller does not pass a limit. */
export const GRAPH_DEFAULT_LIMIT = 50;

/** Hard ceiling for graph `limit`; non-positive or oversized values clamp here. */
export const GRAPH_MAX_LIMIT = 200;

/**
 * Runs one Git command. The command is always the literal `'git'`; arguments
 * are passed as an array (no shell), and `cwd` is the resolved project path.
 */
export type GitRunner = (
  command: "git",
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<string>;

/** Non-zero git exit; keep stderr for user-facing messages (dirty tree, etc.). */
export class GitCommandFailedError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** The `git` binary is not installed on this machine. */
export class GitNotFoundError extends Error {}

/** The Git command was still running when the timeout elapsed and was killed. */
export class GitTimeoutError extends Error {}

export interface GitRepository {
  isGit: boolean;
  branch: string | null;
  head: string | null;
}

export interface GitBranch {
  name: string;
  kind: "local" | "remote";
  remote?: string;
  upstream?: string;
}

/** Envelope returned by `listBranches`; Task 2 serializes this as JSON. */
export interface GitBranchList {
  branches: GitBranch[];
  truncated: boolean;
}

export interface GitGraphNode {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  authoredAt: string;
  refs: string[];
}

export interface GitGraph {
  nodes: GitGraphNode[];
  truncated: boolean;
}

export interface GitFileChange {
  status: string;
  path: string;
}

export interface GitCommitDetail {
  hash: string;
  parents: string[];
  subject: string;
  body: string;
  author: string;
  authoredAt: string;
  files: GitFileChange[];
}

interface ExecError extends Error {
  killed?: boolean;
  code?: number | string | null;
}

/**
 * Production runner: `execFile` with argv array + cwd. Non-zero exit becomes
 * `GitCommandFailedError` carrying stderr; ENOENT and timeout get their own
 * classes so `gitErrorStatus` can map them to stable 5xx responses.
 */
export const execFileGitRunner: GitRunner = (command, args, cwd, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(command, args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      const err = error as ExecError;
      if (err.killed) {
        reject(new GitTimeoutError(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (err.code === "ENOENT") {
        reject(new GitNotFoundError(`${command} is not installed`));
        return;
      }
      reject(
        new GitCommandFailedError(`${command} exited with ${String(err.code)}`, stderr ?? ""),
      );
    });
  });

const FOR_EACH_REF_FORMAT = "%(refname)%00%(refname:short)%00%(upstream:short)";
const GRAPH_FORMAT = "%H%x1f%P%x1f%s%x1f%an%x1f%aI%x1f%D%x1e";
const SHOW_FORMAT = "%H%x1f%P%x1f%s%x1f%an%x1f%aI%x1f%b%x1e";

/** Hex-only object names; rejects anything that could confuse argv consumers. */
const COMMIT_HASH_RE = /^[0-9a-f]{4,40}$/i;

function clampGraphLimit(limit: number | undefined): number {
  if (limit === undefined) return GRAPH_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0 || limit > GRAPH_MAX_LIMIT) {
    return GRAPH_MAX_LIMIT;
  }
  return Math.floor(limit);
}

function normalizeCommitHash(hash: string): string {
  const trimmed = hash.trim();
  if (!COMMIT_HASH_RE.test(trimmed)) {
    throw new GitCommandFailedError(
      `Invalid commit hash: ${hash}`,
      `Invalid commit hash: ${hash}`,
    );
  }
  return trimmed;
}

/** Probe whether `cwd` is a Git work tree and, if so, its branch and HEAD. */
export async function getRepository(
  cwd: string,
  runner: GitRunner = execFileGitRunner,
): Promise<GitRepository> {
  try {
    const inside = await runner(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      cwd,
      GIT_TIMEOUT_MS,
    );
    if (inside.trim() !== "true") {
      return { isGit: false, branch: null, head: null };
    }
  } catch {
    return { isGit: false, branch: null, head: null };
  }

  let branch: string | null = null;
  try {
    const current = await runner("git", ["branch", "--show-current"], cwd, GIT_TIMEOUT_MS);
    branch = current.trim() || null;
  } catch {
    // Detached HEAD or an older Git without --show-current.
  }

  let head: string | null = null;
  try {
    const rev = await runner("git", ["rev-parse", "HEAD"], cwd, GIT_TIMEOUT_MS);
    head = rev.trim() || null;
  } catch {
    // Empty repository (no commits yet).
  }

  return { isGit: true, branch, head };
}

/**
 * List local and remote-tracking branches. Always truncated to
 * `limit ?? BRANCH_DEFAULT_LIMIT` (even with an empty query) so large
 * monorepos cannot flood the first open.
 */
export async function listBranches(
  cwd: string,
  options: { q?: string; limit?: number } = {},
  runner: GitRunner = execFileGitRunner,
): Promise<GitBranchList> {
  const limit = options.limit ?? BRANCH_DEFAULT_LIMIT;
  const output = await runner(
    "git",
    ["for-each-ref", "refs/heads", "refs/remotes", `--format=${FOR_EACH_REF_FORMAT}`],
    cwd,
    GIT_TIMEOUT_MS,
  );

  const branches: GitBranch[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split("\x00");
    const fullRef = parts[0] ?? "";
    const shortRef = parts[1] ?? "";
    const upstream = parts[2] ?? "";
    if (!shortRef) continue;
    // Skip the symbolic remote HEAD pointer (origin/HEAD → origin/main).
    if (shortRef.endsWith("/HEAD")) continue;

    if (fullRef.startsWith("refs/heads/")) {
      const entry: GitBranch = { name: shortRef, kind: "local" };
      if (upstream) entry.upstream = upstream;
      branches.push(entry);
    } else if (fullRef.startsWith("refs/remotes/")) {
      const slash = shortRef.indexOf("/");
      if (slash <= 0) continue;
      branches.push({
        name: shortRef,
        kind: "remote",
        remote: shortRef.slice(0, slash),
      });
    }
  }

  const needle = (options.q ?? "").trim().toLowerCase();
  const filtered = needle
    ? branches.filter((b) => b.name.toLowerCase().includes(needle))
    : branches;
  const truncated = filtered.length > limit;
  return { branches: filtered.slice(0, limit), truncated };
}

/**
 * Checkout `branch` as returned by `listBranches`.
 * Local → `switch <name>`. Remote → prefer an existing same-named local
 * branch (`switch <localName>`); otherwise create a tracking branch
 * (`switch --track -c <localName> <remote/name>`). Never detached HEAD.
 */
export async function checkoutBranch(
  cwd: string,
  branch: GitBranch,
  runner: GitRunner = execFileGitRunner,
): Promise<GitRepository> {
  if (branch.kind === "local") {
    await runner("git", ["switch", branch.name], cwd, GIT_TIMEOUT_MS);
    return getRepository(cwd, runner);
  }

  const slash = branch.name.indexOf("/");
  if (slash <= 0 || slash === branch.name.length - 1) {
    throw new GitCommandFailedError(
      `Invalid remote branch name: ${branch.name}`,
      `Invalid remote branch name: ${branch.name}`,
    );
  }
  const localName = branch.name.slice(slash + 1);

  const { branches } = await listBranches(cwd, { q: localName }, runner);
  const localExists = branches.some((b) => b.kind === "local" && b.name === localName);

  if (localExists) {
    await runner("git", ["switch", localName], cwd, GIT_TIMEOUT_MS);
  } else {
    await runner(
      "git",
      ["switch", "--track", "-c", localName, branch.name],
      cwd,
      GIT_TIMEOUT_MS,
    );
  }
  return getRepository(cwd, runner);
}

/**
 * Create `name` from the current HEAD and check it out.
 * The ref name is validated by Git itself before the switch.
 */
export async function createAndCheckoutBranch(
  cwd: string,
  name: string,
  runner: GitRunner = execFileGitRunner,
): Promise<GitRepository> {
  await runner("git", ["check-ref-format", "--branch", name], cwd, GIT_TIMEOUT_MS);
  await runner("git", ["switch", "-c", name, "HEAD"], cwd, GIT_TIMEOUT_MS);
  return getRepository(cwd, runner);
}

function parseRefs(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    // Normalize "HEAD -> main" to just "main"; keep tags as "tag: v1".
    .map((r) => {
      const arrow = r.indexOf(" -> ");
      return arrow === -1 ? r : r.slice(arrow + 4).trim();
    });
}

/** Limited topological commit list across all refs, for the read-only graph. */
export async function getGraph(
  cwd: string,
  options: { limit?: number } = {},
  runner: GitRunner = execFileGitRunner,
): Promise<GitGraph> {
  const limit = clampGraphLimit(options.limit);
  // Ask for one extra row so `truncated` is exact rather than "maybe".
  const output = await runner(
    "git",
    ["log", "--all", "--topo-order", `--max-count=${limit + 1}`, `--format=${GRAPH_FORMAT}`],
    cwd,
    GIT_TIMEOUT_MS,
  );

  const nodes: GitGraphNode[] = [];
  for (const record of output.split("\x1e")) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;
    const fields = trimmed.split("\x1f");
    const hash = (fields[0] ?? "").trim();
    if (!hash) continue;
    nodes.push({
      hash,
      parents: (fields[1] ?? "").trim().split(/\s+/).filter(Boolean),
      subject: fields[2] ?? "",
      author: fields[3] ?? "",
      authoredAt: fields[4] ?? "",
      refs: parseRefs(fields[5] ?? ""),
    });
  }

  const truncated = nodes.length > limit;
  return { nodes: nodes.slice(0, limit), truncated };
}

/**
 * Full detail for one commit: subject, body, parents, and a name-status
 * file list. The hash is hex-validated before it ever reaches argv.
 */
export async function getCommitDetail(
  cwd: string,
  hash: string,
  runner: GitRunner = execFileGitRunner,
): Promise<GitCommitDetail> {
  const safeHash = normalizeCommitHash(hash);
  const output = await runner(
    "git",
    ["show", `--format=${SHOW_FORMAT}`, "--name-status", "--no-renames", safeHash, "--"],
    cwd,
    GIT_TIMEOUT_MS,
  );

  const rs = output.indexOf("\x1e");
  if (rs === -1) {
    throw new GitCommandFailedError("Unexpected git show output", output);
  }
  const header = output.slice(0, rs);
  const rest = output.slice(rs + 1);
  const fields = header.split("\x1f");

  const files: GitFileChange[] = [];
  for (const line of rest.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    // name-status with --no-renames is STATUS\tpath
    const tab = trimmedLine.indexOf("\t");
    if (tab <= 0) continue;
    files.push({
      status: trimmedLine.slice(0, tab),
      path: trimmedLine.slice(tab + 1),
    });
  }

  return {
    hash: (fields[0] ?? "").trim(),
    parents: (fields[1] ?? "").trim().split(/\s+/).filter(Boolean),
    subject: fields[2] ?? "",
    author: fields[3] ?? "",
    authoredAt: fields[4] ?? "",
    body: (fields[5] ?? "").replace(/\n+$/, ""),
    files,
  };
}

/**
 * Map this module's domain errors onto HTTP statuses; null = not ours (500).
 * Invalid refs / rejected switches → 400 with the Git stderr text.
 * Missing Git, timeouts, and pre-`switch` versions → 500.
 */
export function gitErrorStatus(err: unknown): { status: number; message: string } | null {
  if (err instanceof GitNotFoundError) {
    return { status: 500, message: "Git is not installed" };
  }
  if (err instanceof GitTimeoutError) {
    return { status: 500, message: "Git command timed out" };
  }
  if (err instanceof GitCommandFailedError) {
    if (err.stderr.includes("unknown subcommand") && err.stderr.includes("switch")) {
      return { status: 500, message: "Git version too old (requires git >= 2.23)" };
    }
    const text = err.stderr.trim() || err.message;
    return { status: 400, message: text };
  }
  if (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return { status: 500, message: "Git is not installed" };
  }
  return null;
}
