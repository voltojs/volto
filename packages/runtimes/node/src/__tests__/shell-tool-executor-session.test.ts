import { describe, it, expect } from "vitest";
import type { Shell } from "@volto/core";
import type { BashSessionLike } from "@volto/tools-shell";
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
