import { describe, it, expect } from "vitest";
import type { Shell } from "@voltojs/core";
import type { BashSessionLike } from "@voltojs/tools-shell";
import { createShellToolExecutor } from "../shell-tool-executor.js";

/**
 * Regression for the Task 6/7 residual: the abort path used to rebuild
 * createBashTool(abortableShell) WITHOUT options, silently dropping
 * session-routed bash calls onto one-shot shell.exec.
 */
describe("createShellToolExecutor — session routing survives abort path", () => {
  it("forwards getSession into the abortable bash tool", async () => {
    const sessionRuns: string[] = [];
    const getSession = (): BashSessionLike => ({
      async run(cmd: string) {
        sessionRuns.push(cmd);
        return { stdout: "from-session", stderr: "", exitCode: 0 };
      },
    });

    let execCalled = false;
    const shell: Shell = {
      async *exec() {
        execCalled = true;
        yield { type: "stdout", data: "from-exec" };
        yield { type: "exit", code: 0 };
      },
    };

    const executor = createShellToolExecutor({ shell, getSession });
    const ac = new AbortController();
    // Signal present → the executor takes the abortable-tool branch.
    const result = await executor(
      { id: "t1", name: "bash", input: { command: "echo hi" } },
      { readFiles: [], abortSignal: ac.signal },
    );

    expect(sessionRuns).toEqual(["echo hi"]);
    expect(execCalled).toBe(false);
    expect(result.isError).toBeFalsy();
    expect(result.displayMetadata?.fromSession).toBe(true);
    expect(result.modelContent).toContain("from-session");
  });

  it("forwards describeWorkspace so the cwd note can name the branch", async () => {
    // The executor rebuilds the bash tool for abort support; a dropped option
    // here is invisible to the tool's own tests and shows up only as a bare
    // `[cwd: …]` in a real run (found by the end-to-end worktree check).
    const getSession = (): BashSessionLike => ({
      async run() {
        return {
          stdout: "moved",
          stderr: "",
          exitCode: 0,
          cwdAfter: "/repo-wt",
          cwdChanged: true,
        };
      },
    });
    const shell: Shell = {
      // eslint-disable-next-line require-yield
      async *exec() {
        throw new Error("session path only");
      },
    };

    const executor = createShellToolExecutor({
      shell,
      getSession,
      describeWorkspace: async (cwd) => `${cwd} (branch: feat/x)`,
    });
    const ac = new AbortController();
    const result = await executor(
      { id: "t1", name: "bash", input: { command: "cd ../repo-wt" } },
      { readFiles: [], abortSignal: ac.signal },
    );

    expect(result.modelContent).toContain("[cwd: /repo-wt (branch: feat/x)]");
  });

  it("still uses one-shot exec when getSession yields undefined", async () => {
    const getSession = (): BashSessionLike | undefined => undefined;
    let execCmd: string | undefined;
    const shell: Shell = {
      async *exec(cmd: string) {
        execCmd = cmd;
        yield { type: "stdout", data: "from-exec" };
        yield { type: "exit", code: 0 };
      },
    };

    const executor = createShellToolExecutor({ shell, getSession });
    const ac = new AbortController();
    const result = await executor(
      { id: "t1", name: "bash", input: { command: "echo hi" } },
      { readFiles: [], abortSignal: ac.signal },
    );

    expect(execCmd).toBe("echo hi");
    expect(result.displayMetadata?.fromSession).toBeUndefined();
    expect(result.modelContent).toContain("from-exec");
  });
});
