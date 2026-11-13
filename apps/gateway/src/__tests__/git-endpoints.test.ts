import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelPort } from "@voltojs/core";
import { createStore } from "@voltojs/stores/jsonl";
import { createServer, type HeadlessServer } from "../server.js";

const execFileAsync = promisify(execFile);

/**
 * Env that forces a deterministic author/committer, overriding any host
 * GIT_AUTHOR_* / GIT_COMMITTER_* vars that would otherwise leak into commits.
 */
const GIT_TEST_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: GIT_TEST_ENV });
  return stdout;
}

const MODEL_PORT: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

describe("GET/POST /git/* endpoints", () => {
  let base = "";
  let launchToken = "";
  let closeServer = async (): Promise<void> => {};
  let plainDir: string;
  let gitDir: string;
  let bareDir: string;
  let plainProjectId: string;
  let gitProjectId: string;

  beforeEach(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-endpoints-"));
    process.env["VOLTO_CONFIG_DIR"] = tempDir;

    // Plain non-git project directory
    plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-plain-"));
    await fs.writeFile(path.join(plainDir, "README.md"), "not a repo");

    // Bare repo acting as origin so `git switch --track` has a real remote
    bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-bare-"));
    await git(["init", "--bare", "-b", "main"], bareDir);

    // Real git repository with two commits and a remote-tracking branch
    gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-repo-"));
    await git(["init", "-b", "main"], gitDir);
    await git(["config", "user.email", "test@example.com"], gitDir);
    await git(["config", "user.name", "Test User"], gitDir);
    await git(["remote", "add", "origin", bareDir], gitDir);
    await fs.writeFile(path.join(gitDir, "a.txt"), "one\n");
    await git(["add", "a.txt"], gitDir);
    await git(["commit", "-m", "first commit"], gitDir);
    await fs.writeFile(path.join(gitDir, "b.txt"), "two\n");
    await git(["add", "b.txt"], gitDir);
    await git(["commit", "-m", "second commit"], gitDir);
    await git(["push", "-u", "origin", "main"], gitDir);
    // Push a feature branch to origin, then fetch so origin/feature/x appears
    await git(["push", "origin", "HEAD:refs/heads/feature/x"], gitDir);
    await git(["fetch", "origin"], gitDir);

    const instance: HeadlessServer = await createServer({
      port: 0,
      modelPort: MODEL_PORT,
      chatStore: createStore({ directory: tempDir }),
    });
    await new Promise<void>((resolve) => instance.on("listening", resolve));
    const addr = instance.address();
    base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
    launchToken = instance.launchToken;
    closeServer = () => new Promise<void>((resolve) => instance.close(() => resolve()));

    // Register both projects
    const createProject = async (name: string, projectPath: string): Promise<string> => {
      const res = await fetch(`${base}/projects`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${launchToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name, path: projectPath }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    plainProjectId = await createProject("plain", plainDir);
    gitProjectId = await createProject("git-repo", gitDir);
  });

  afterEach(async () => {
    await closeServer();
  });

  async function request(
    requestPath: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: string }> {
    const response = await fetch(`${base}${requestPath}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${launchToken}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    return { status: response.status, body: await response.text() };
  }

  it("GET /git/summary returns isGit false for a non-repo project", async () => {
    const res = await request(`/git/summary?projectId=${plainProjectId}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ isGit: false, branch: null, head: null });
  });

  it("GET /git/summary returns isGit true with branch and head for a repo", async () => {
    const res = await request(`/git/summary?projectId=${gitProjectId}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { isGit: boolean; branch: string; head: string };
    expect(body.isGit).toBe(true);
    expect(body.branch).toBe("main");
    expect(body.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("GET /git/summary answers 404 for an unknown project", async () => {
    const res = await request("/git/summary?projectId=nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Unknown project: nope");
  });

  it("GET /git/branches lists main and origin/feature/x with truncated flag", async () => {
    const res = await request(`/git/branches?projectId=${gitProjectId}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      branches: Array<{ name: string; kind: string }>;
      truncated: boolean;
    };
    const names = body.branches.map((b) => b.name);
    expect(names).toContain("main");
    expect(names).toContain("origin/feature/x");
    expect(typeof body.truncated).toBe("boolean");
  });

  it("POST /git/checkout switches to a remote branch and creates a local tracking branch", async () => {
    const res = await request("/git/checkout", {
      method: "POST",
      body: JSON.stringify({ projectId: gitProjectId, name: "origin/feature/x", kind: "remote" }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { branch: string };
    expect(body.branch).toBe("feature/x");
    const actual = await git(["branch", "--show-current"], gitDir);
    expect(actual.trim()).toBe("feature/x");
  });

  it("POST /git/checkout reuses an existing local branch when checking out the remote", async () => {
    // First checkout creates local feature/x
    const first = await request("/git/checkout", {
      method: "POST",
      body: JSON.stringify({ projectId: gitProjectId, name: "origin/feature/x", kind: "remote" }),
    });
    expect(first.status).toBe(200);
    // Switch back to main
    await git(["switch", "main"], gitDir);
    // Second checkout should land on existing local feature/x without recreating
    const second = await request("/git/checkout", {
      method: "POST",
      body: JSON.stringify({ projectId: gitProjectId, name: "origin/feature/x", kind: "remote" }),
    });
    expect(second.status).toBe(200);
    const body = JSON.parse(second.body) as { branch: string };
    expect(body.branch).toBe("feature/x");
    const actual = await git(["branch", "--show-current"], gitDir);
    expect(actual.trim()).toBe("feature/x");
  });

  it("POST /git/branches creates a new branch and summary stays consistent", async () => {
    const res = await request("/git/branches", {
      method: "POST",
      body: JSON.stringify({ projectId: gitProjectId, name: "new-feature" }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { branch: string; head: string };
    expect(body.branch).toBe("new-feature");

    const summary = await request(`/git/summary?projectId=${gitProjectId}`);
    expect(summary.status).toBe(200);
    const summaryBody = JSON.parse(summary.body) as { branch: string; head: string };
    expect(summaryBody.branch).toBe("new-feature");
    expect(summaryBody.head).toBe(body.head);
  });

  it("POST /git/checkout rejects dirty worktree with non-2xx and leaves branch unchanged", async () => {
    // Create a branch with different content for a.txt
    await git(["switch", "-c", "conflict-branch"], gitDir);
    await fs.writeFile(path.join(gitDir, "a.txt"), "changed\n");
    await git(["add", "a.txt"], gitDir);
    await git(["commit", "-m", "change a.txt"], gitDir);
    await git(["switch", "main"], gitDir);

    // Dirty the worktree on main
    await fs.writeFile(path.join(gitDir, "a.txt"), "dirty\n");
    const branchBefore = (await git(["branch", "--show-current"], gitDir)).trim();

    const res = await request("/git/checkout", {
      method: "POST",
      body: JSON.stringify({ projectId: gitProjectId, name: "conflict-branch", kind: "local" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBeTruthy();

    const branchAfter = (await git(["branch", "--show-current"], gitDir)).trim();
    expect(branchAfter).toBe(branchBefore);
  });

  it("GET /git/graph returns nodes with parent edges", async () => {
    const res = await request(`/git/graph?projectId=${gitProjectId}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      nodes: Array<{ hash: string; parents: string[]; subject: string }>;
      truncated: boolean;
    };
    expect(body.nodes.length).toBeGreaterThanOrEqual(2);
    // The older commit should have no parents (root), the newer one has a parent
    const root = body.nodes.find((n) => n.parents.length === 0);
    expect(root).toBeDefined();
    const child = body.nodes.find((n) => n.parents.length > 0);
    expect(child).toBeDefined();
    expect(child!.parents).toContain(root!.hash);
  });

  it("GET /git/commits/:hash returns author, parents, and files", async () => {
    const head = (await git(["rev-parse", "HEAD"], gitDir)).trim();
    const res = await request(`/git/commits/${head}?projectId=${gitProjectId}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      hash: string;
      parents: string[];
      author: string;
      files: Array<{ status: string; path: string }>;
    };
    expect(body.hash).toBe(head);
    expect(body.author).toBe("Test User");
    expect(body.parents.length).toBeGreaterThanOrEqual(1);
    expect(body.files).toContainEqual({ status: "A", path: "b.txt" });
  });

  it("requires auth like every other route", async () => {
    const response = await fetch(`${base}/git/summary?projectId=${gitProjectId}`);
    expect(response.status).toBe(401);
  });
});
