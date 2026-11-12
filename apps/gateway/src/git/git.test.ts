// apps/gateway/src/git/git.test.ts
import { describe, it, expect } from "vitest";
import {
  BRANCH_DEFAULT_LIMIT,
  GitCommandFailedError,
  GitNotFoundError,
  GitTimeoutError,
  type GitRunner,
  getRepository,
  listBranches,
  checkoutBranch,
  createAndCheckoutBranch,
  getGraph,
  getCommitDetail,
  gitErrorStatus,
} from "./git.js";

type Call = { args: string[]; cwd: string };

function recorder(
  respond: (args: string[]) => string | Promise<string>,
): { calls: Call[]; runner: GitRunner } {
  const calls: Call[] = [];
  const runner: GitRunner = async (_command, args, cwd, _timeoutMs) => {
    calls.push({ args: [...args], cwd });
    return respond(args);
  };
  return { calls, runner };
}

function repoUpRunner(overrides: Record<string, string> = {}): {
  calls: Call[];
  runner: GitRunner;
} {
  return recorder((args) => {
    const key = args.join(" ");
    if (key in overrides) return overrides[key]!;
    if (key === "rev-parse --is-inside-work-tree") return "true\n";
    if (key === "branch --show-current") return "main\n";
    if (key === "rev-parse HEAD") return "abc123\n";
    return "";
  });
}

describe("getRepository", () => {
  it("returns isGit false when rev-parse fails (not a repository)", async () => {
    const { runner } = recorder(() => {
      throw new GitCommandFailedError("git exited with 128", "fatal: not a git repository");
    });
    await expect(getRepository("/plain", runner)).resolves.toEqual({
      isGit: false,
      branch: null,
      head: null,
    });
  });

  it("returns isGit false when inside-work-tree is not true", async () => {
    const { runner } = recorder((args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return "false\n";
      return "";
    });
    await expect(getRepository("/plain", runner)).resolves.toEqual({
      isGit: false,
      branch: null,
      head: null,
    });
  });

  it("reports current branch and HEAD for a normal repository", async () => {
    const { calls, runner } = repoUpRunner({
      "branch --show-current": "feature/x\n",
      "rev-parse HEAD": "deadbeef\n",
    });
    await expect(getRepository("/repo", runner)).resolves.toEqual({
      isGit: true,
      branch: "feature/x",
      head: "deadbeef",
    });
    expect(calls).toContainEqual({
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: "/repo",
    });
    expect(calls).toContainEqual({ args: ["branch", "--show-current"], cwd: "/repo" });
    expect(calls).toContainEqual({ args: ["rev-parse", "HEAD"], cwd: "/repo" });
  });

  it("reports branch null on detached HEAD", async () => {
    const { runner } = repoUpRunner({
      "branch --show-current": "\n",
    });
    await expect(getRepository("/repo", runner)).resolves.toEqual({
      isGit: true,
      branch: null,
      head: "abc123",
    });
  });
});

describe("listBranches", () => {
  const forEachRefOutput = [
    "refs/heads/main\x00main\x00origin/main",
    "refs/heads/feature/x\x00feature/x\x00",
    "refs/remotes/origin/main\x00origin/main\x00",
    "refs/remotes/origin/feature/x\x00origin/feature/x\x00",
    "refs/remotes/origin/HEAD\x00origin/HEAD\x00",
    "",
  ].join("\n");

  it("parses local and remote refs, skips origin/HEAD, attaches upstream", async () => {
    const { calls, runner } = recorder((args) => {
      if (args[0] === "for-each-ref") return forEachRefOutput;
      return "";
    });
    const result = await listBranches("/repo", {}, runner);
    expect(result.truncated).toBe(false);
    expect(result.branches).toEqual([
      { name: "main", kind: "local", upstream: "origin/main" },
      { name: "feature/x", kind: "local" },
      { name: "origin/main", kind: "remote", remote: "origin" },
      { name: "origin/feature/x", kind: "remote", remote: "origin" },
    ]);
    const refCall = calls.find((c) => c.args[0] === "for-each-ref")!;
    expect(refCall.cwd).toBe("/repo");
    expect(refCall.args).toContain("refs/heads");
    expect(refCall.args).toContain("refs/remotes");
  });

  it("filters by query and still truncates to the default limit when q is empty", async () => {
    const many = Array.from(
      { length: 300 },
      (_, i) => `refs/heads/b${String(i).padStart(3, "0")}\x00b${String(i).padStart(3, "0")}\x00`,
    );
    const { runner } = recorder((args) => {
      if (args[0] === "for-each-ref") return many.join("\n") + "\n";
      return "";
    });
    const empty = await listBranches("/repo", {}, runner);
    expect(empty.truncated).toBe(true);
    expect(empty.branches.length).toBeLessThan(300);
    expect(empty.branches.length).toBeGreaterThan(0);

    const filtered = await listBranches("/repo", { q: "b00" }, runner);
    expect(filtered.branches.every((b) => b.name.includes("b00"))).toBe(true);
    expect(filtered.branches.map((b) => b.name)).toContain("b000");
  });
});

describe("createAndCheckoutBranch", () => {
  it("creates and checks out a branch from the current HEAD with argv only", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const runner: GitRunner = async (_command, args, cwd, _timeoutMs) => {
      calls.push({ args, cwd });
      if (args.join(" ") === "check-ref-format --branch feature/x") return "feature/x\n";
      if (args.join(" ") === "switch -c feature/x HEAD") return "";
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return "true\n";
      if (args.join(" ") === "branch --show-current") return "feature/x\n";
      return "abc123\n";
    };
    await createAndCheckoutBranch("/repo", "feature/x", runner);
    expect(calls).toContainEqual({ args: ["switch", "-c", "feature/x", "HEAD"], cwd: "/repo" });
  });

  it("validates the ref name before creating", async () => {
    const calls: Call[] = [];
    const runner: GitRunner = async (_command, args, cwd, _timeoutMs) => {
      calls.push({ args: [...args], cwd });
      if (args.join(" ") === "check-ref-format --branch bad name") {
        throw new GitCommandFailedError("git exited with 1", "fatal: 'bad name' is not a valid branch name");
      }
      return "";
    };
    await expect(createAndCheckoutBranch("/repo", "bad name", runner)).rejects.toBeInstanceOf(
      GitCommandFailedError,
    );
    expect(calls.some((c) => c.args[0] === "switch")).toBe(false);
  });
});

describe("checkoutBranch", () => {
  it("validates the local branch name and switches with switch -- <name>", async () => {
    const { calls, runner } = repoUpRunner();
    await expect(
      checkoutBranch(
        "/repo",
        { name: "main", kind: "local" },
        runner,
      ),
    ).resolves.toEqual({ isGit: true, branch: "main", head: "abc123" });
    expect(calls).toContainEqual({
      args: ["check-ref-format", "--branch", "main"],
      cwd: "/repo",
    });
    expect(calls).toContainEqual({ args: ["switch", "--", "main"], cwd: "/repo" });
    expect(calls.some((c) => c.args.includes("-c"))).toBe(false);
  });

  it("rejects option-like local branch names before any switch", async () => {
    for (const name of ["-b", "--track", "-c"]) {
      const { calls, runner } = recorder((args) => {
        if (args.join(" ") === `check-ref-format --branch ${name}`) {
          throw new GitCommandFailedError(
            "git exited with 128",
            `fatal: '${name}' is not a valid branch name`,
          );
        }
        return "";
      });
      await expect(
        checkoutBranch("/repo", { name, kind: "local" }, runner),
      ).rejects.toBeInstanceOf(GitCommandFailedError);
      expect(calls.some((c) => c.args[0] === "switch")).toBe(false);
    }
  });

  it("creates a tracking branch when show-ref reports the local ref missing", async () => {
    const { calls, runner } = recorder((args) => {
      const key = args.join(" ");
      if (key === "check-ref-format --branch feature/x") return "feature/x\n";
      if (key === "show-ref --verify --quiet refs/heads/feature/x") {
        throw new GitCommandFailedError("git exited with 1", "");
      }
      if (key === "switch --track -c feature/x -- origin/feature/x") return "";
      if (key === "rev-parse --is-inside-work-tree") return "true\n";
      if (key === "branch --show-current") return "feature/x\n";
      if (key === "rev-parse HEAD") return "abc123\n";
      return "";
    });
    await checkoutBranch(
      "/repo",
      { name: "origin/feature/x", kind: "remote", remote: "origin" },
      runner,
    );
    expect(calls).toContainEqual({
      args: ["check-ref-format", "--branch", "feature/x"],
      cwd: "/repo",
    });
    expect(calls).toContainEqual({
      args: ["show-ref", "--verify", "--quiet", "refs/heads/feature/x"],
      cwd: "/repo",
    });
    expect(calls).toContainEqual({
      args: ["switch", "--track", "-c", "feature/x", "--", "origin/feature/x"],
      cwd: "/repo",
    });
  });

  it("switches to the existing local branch when show-ref finds it", async () => {
    const { calls, runner } = recorder((args) => {
      const key = args.join(" ");
      if (key === "check-ref-format --branch feature/x") return "feature/x\n";
      if (key === "show-ref --verify --quiet refs/heads/feature/x") return "";
      if (key === "switch -- feature/x") return "";
      if (key === "rev-parse --is-inside-work-tree") return "true\n";
      if (key === "branch --show-current") return "feature/x\n";
      if (key === "rev-parse HEAD") return "abc123\n";
      return "";
    });
    await checkoutBranch(
      "/repo",
      { name: "origin/feature/x", kind: "remote", remote: "origin" },
      runner,
    );
    expect(calls).toContainEqual({ args: ["switch", "--", "feature/x"], cwd: "/repo" });
    expect(calls.some((c) => c.args.includes("-c"))).toBe(false);
  });

  it("uses show-ref rather than the truncated branch list to detect a local ref", async () => {
    // for-each-ref returns 200+ branches and the exact localName is NOT among
    // the first 200 after a substring filter would still miss it; show-ref
    // must be the source of truth so checkout does not try --track -c.
    const localName = "zebra-target";
    const manyOtherLocals = Array.from(
      { length: BRANCH_DEFAULT_LIMIT + 50 },
      (_, i) =>
        `refs/heads/other-${String(i).padStart(3, "0")}\x00other-${String(i).padStart(3, "0")}\x00`,
    );
    const forEachRefWithoutTarget = [...manyOtherLocals, ""].join("\n");
    const { calls, runner } = recorder((args) => {
      const key = args.join(" ");
      if (args[0] === "for-each-ref") return forEachRefWithoutTarget;
      if (key === `check-ref-format --branch ${localName}`) return `${localName}\n`;
      if (key === `show-ref --verify --quiet refs/heads/${localName}`) return "";
      if (key === `switch -- ${localName}`) return "";
      if (key === "rev-parse --is-inside-work-tree") return "true\n";
      if (key === "branch --show-current") return `${localName}\n`;
      if (key === "rev-parse HEAD") return "abc123\n";
      return "";
    });
    await checkoutBranch(
      "/repo",
      { name: `origin/${localName}`, kind: "remote", remote: "origin" },
      runner,
    );
    // Exact local exists per show-ref → plain switch, never --track -c.
    expect(calls).toContainEqual({ args: ["switch", "--", localName], cwd: "/repo" });
    expect(calls.some((c) => c.args.includes("--track"))).toBe(false);
    // for-each-ref must not be consulted for this existence check.
    expect(calls.some((c) => c.args[0] === "for-each-ref")).toBe(false);
  });

  it("rejects a remote name with no slash or a trailing slash", async () => {
    const { runner } = repoUpRunner();
    await expect(
      checkoutBranch("/repo", { name: "origin/", kind: "remote" }, runner),
    ).rejects.toBeInstanceOf(GitCommandFailedError);
    await expect(
      checkoutBranch("/repo", { name: "noslash", kind: "remote" }, runner),
    ).rejects.toBeInstanceOf(GitCommandFailedError);
  });
});

describe("getGraph", () => {
  const logOutput =
    "bbb222\x1f" +
    "aaa111\x1f" +
    "second commit\x1f" +
    "Alice\x1f" +
    "2024-01-02T10:00:00+00:00\x1f" +
    "HEAD -> main, tag: v1\x1e" +
    "\n" +
    "aaa111\x1f\x1f" +
    "first commit\x1f" +
    "Bob\x1f" +
    "2024-01-01T09:00:00+00:00\x1f" +
    "\x1e" +
    "\n";

  it("parses parents, subject, author, date and refs", async () => {
    const { calls, runner } = recorder((args) => {
      if (args[0] === "log") return logOutput;
      return "";
    });
    const graph = await getGraph("/repo", { limit: 50 }, runner);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]).toEqual({
      hash: "bbb222",
      parents: ["aaa111"],
      subject: "second commit",
      author: "Alice",
      authoredAt: "2024-01-02T10:00:00+00:00",
      refs: ["main", "tag: v1"],
    });
    expect(graph.nodes[1]!.parents).toEqual([]);
    expect(graph.truncated).toBe(false);
    const logCall = calls.find((c) => c.args[0] === "log")!;
    expect(logCall.cwd).toBe("/repo");
    expect(logCall.args).toContain("--all");
    expect(logCall.args).toContain("--topo-order");
  });

  it("clamps non-positive or oversized limits to the maximum", async () => {
    const { calls, runner } = recorder((args) => {
      if (args[0] === "log") return logOutput;
      return "";
    });
    await getGraph("/repo", { limit: 0 }, runner);
    await getGraph("/repo", { limit: 10_000 }, runner);
    const maxCounts = calls
      .filter((c) => c.args[0] === "log")
      .map((c) => c.args.find((a) => a.startsWith("--max-count="))!);
    expect(maxCounts[0]).toBe(maxCounts[1]);
    expect(maxCounts[0]).toMatch(/^--max-count=\d+$/);
  });
});

describe("getCommitDetail", () => {
  const showOutput =
    "bbb222\x1f" +
    "aaa111\x1f" +
    "second commit\x1f" +
    "Alice\x1f" +
    "2024-01-02T10:00:00+00:00\x1f" +
    "This is the full body\nspanning lines.\x1e" +
    "\n" +
    "M\tsrc/a.ts\n" +
    "A\tsrc/b.ts\n";

  it("parses body and name-status file list", async () => {
    const { calls, runner } = recorder((args) => {
      if (args[0] === "show") return showOutput;
      return "";
    });
    const detail = await getCommitDetail("/repo", "bbb222", runner);
    expect(detail).toEqual({
      hash: "bbb222",
      parents: ["aaa111"],
      subject: "second commit",
      body: "This is the full body\nspanning lines.",
      author: "Alice",
      authoredAt: "2024-01-02T10:00:00+00:00",
      files: [
        { status: "M", path: "src/a.ts" },
        { status: "A", path: "src/b.ts" },
      ],
    });
    const showCall = calls.find((c) => c.args[0] === "show")!;
    expect(showCall.cwd).toBe("/repo");
    expect(showCall.args).toContain("--name-status");
    expect(showCall.args).toContain("--no-renames");
    expect(showCall.args).toContain("bbb222");
    expect(showCall.args[showCall.args.length - 1]).toBe("--");
  });

  it("rejects hashes that are not hex before calling git", async () => {
    const calls: Call[] = [];
    const runner: GitRunner = async (_command, args, cwd, _timeoutMs) => {
      calls.push({ args: [...args], cwd });
      return "";
    };
    await expect(getCommitDetail("/repo", "abc; rm -rf /", runner)).rejects.toThrow(
      /invalid commit hash/i,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("gitErrorStatus", () => {
  it("maps GitCommandFailedError to 400 with stderr text", () => {
    const err = new GitCommandFailedError("git exited with 1", "error: Your local changes would be overwritten");
    expect(gitErrorStatus(err)).toEqual({
      status: 400,
      message: "error: Your local changes would be overwritten",
    });
  });

  it("maps pre-2.23 'is not a git command' for switch to 500 version-too-old", () => {
    // Real git < 2.23 stderr, verbatim shape.
    const err = new GitCommandFailedError(
      "git exited with 1",
      "git: 'switch' is not a git command. See 'git --help'.",
    );
    const mapped = gitErrorStatus(err)!;
    expect(mapped.status).toBe(500);
    expect(mapped.message).toMatch(/version too old/i);
  });

  it("maps unknown switch subcommand to 500 with a version hint", () => {
    const err = new GitCommandFailedError(
      "git exited with 1",
      "error: unknown subcommand `switch'",
    );
    const mapped = gitErrorStatus(err)!;
    expect(mapped.status).toBe(500);
    expect(mapped.message).toMatch(/version too old/i);
  });

  it("maps missing git and timeouts to 500", () => {
    expect(gitErrorStatus(new GitNotFoundError("git is not installed"))?.status).toBe(500);
    expect(gitErrorStatus(new GitTimeoutError("git timed out"))?.status).toBe(500);
  });

  it("returns null for unmapped errors", () => {
    expect(gitErrorStatus(new Error("boom"))).toBeNull();
  });
});
