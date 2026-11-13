import { describe, it, expect } from "vitest";
import type { Shell } from "@voltojs/core";
import { createBashTool } from "../index.js";
import type { BashSessionLike, BashSessionRunResult } from "../session-port.js";

/** A shell that must never be reached: every case here goes through a session. */
const forbiddenShell: Shell = {
  // eslint-disable-next-line require-yield
  async *exec() {
    throw new Error("shell.exec must not run on the session path");
  },
};

function fakeSession(
  result: BashSessionRunResult,
): BashSessionLike & { runs: number } {
  return {
    runs: 0,
    async run() {
      this.runs += 1;
      return result;
    },
  };
}

const baseResult: BashSessionRunResult = { stdout: "done", stderr: "", exitCode: 0 };
/** A session result for a command that moved the shell (what the runtime reports). */
const moved = (cwd: string): BashSessionRunResult => ({
  ...baseResult,
  cwdAfter: cwd,
  cwdChanged: true,
});

describe("bash cwd confirmation note", () => {
  it("appends a cwd note when the command moved the session", async () => {
    const session = fakeSession(moved("/repo-wt"));
    const tool = createBashTool(forbiddenShell, { getSession: () => session });
    const r = await tool.handler({ command: "cd ../repo-wt", message: "" });

    expect(String(r.modelContent)).toContain("[cwd: /repo-wt]");
  });

  it("appends no note when the session did not move", async () => {
    // The runtime reports the directory on every command; only `cwdChanged`
    // says whether it moved.
    const session = fakeSession({ ...baseResult, cwdAfter: "/repo", cwdChanged: false });
    const tool = createBashTool(forbiddenShell, { getSession: () => session });
    const r = await tool.handler({ command: "ls", message: "" });

    expect(String(r.modelContent)).not.toContain("[cwd:");
  });

  it("appends no note on the first command of a session", async () => {
    // The spawn cwd and the shell's `$PWD` can spell one directory two ways
    // (macOS `/var` vs `/private/var`); the runtime reports the first command
    // as unchanged so this cannot become noise on every session.
    const session = fakeSession({ ...baseResult, cwdAfter: "/private/repo", cwdChanged: false });
    const tool = createBashTool(forbiddenShell, { getSession: () => session });
    const r = await tool.handler({ command: "pwd", message: "" });

    expect(String(r.modelContent)).not.toContain("[cwd:");
  });

  it("publishes the directory on the display metadata", async () => {
    const session = fakeSession(moved("/repo-wt"));
    const tool = createBashTool(forbiddenShell, { getSession: () => session });
    const r = await tool.handler({ command: "cd ../repo-wt", message: "" });

    expect(r.displayMetadata).toMatchObject({ cwdAfter: "/repo-wt" });
  });

  it("includes the branch when the host can describe the directory", async () => {
    const session = fakeSession(moved("/repo-wt"));
    const tool = createBashTool(forbiddenShell, {
      getSession: () => session,
      describeWorkspace: (cwd) => (cwd === "/repo-wt" ? "/repo-wt (branch: feat/x)" : undefined),
    });
    const r = await tool.handler({ command: "cd ../repo-wt", message: "" });

    expect(String(r.modelContent)).toContain("[cwd: /repo-wt (branch: feat/x)]");
  });

  it("falls back to the bare directory when the host cannot describe it", async () => {
    const session = fakeSession(moved("/repo-wt"));
    const tool = createBashTool(forbiddenShell, {
      getSession: () => session,
      // Cache miss: the host knows the path but not the branch.
      describeWorkspace: () => undefined,
    });
    const r = await tool.handler({ command: "cd ../repo-wt", message: "" });

    expect(String(r.modelContent)).toContain("[cwd: /repo-wt]");
    expect(String(r.modelContent)).not.toContain("branch:");
  });

  it("does not annotate the isolated path", async () => {
    const session = fakeSession(moved("/repo-wt"));
    const tool = createBashTool(forbiddenShell, { getSession: () => session });
    // isolated never consults the session, so it never learns a cwd either.
    const r = await tool.handler({ command: "cd ../repo-wt", message: "", isolated: true });

    expect(String(r.modelContent)).not.toContain("[cwd:");
    expect(session.runs).toBe(0);
  });

  it("keeps the note out of the truncated head", async () => {
    const long = "x".repeat(120_000); // past OUTPUT_LIMIT (100_000)
    const session = fakeSession({
      stdout: long,
      stderr: "",
      exitCode: 0,
      cwdAfter: "/repo-wt",
      cwdChanged: true,
    });
    const tool = createBashTool(forbiddenShell, { getSession: () => session });
    const r = await tool.handler({ command: "cat big", message: "" });

    // The confirmation survives truncation: it is appended after the cut.
    expect(String(r.modelContent)).toContain("[cwd: /repo-wt]");
    expect(String(r.modelContent)).toContain("output truncated");
  });
});