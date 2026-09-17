import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@volto/core";
import type { Shell } from "@volto/core";
import type { SessionSpawnHandle } from "@volto/runtime-node";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Bare `/bin/bash -s` spawner used as the default (no sandboxConfig) path.
 * Mirrors createSandboxSessionSpawner({ mode: "danger-full-access" }) so
 * tests exercise the same spawn shape createAgent uses.
 */
function bareBashSpawner(opts: { cwd: string }): SessionSpawnHandle {
  return {
    child: spawn("/bin/bash", ["-s"], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }),
  };
}

function stubShell(overrides: Partial<Shell> = {}): Shell {
  return {
    async *exec() {
      yield { type: "stdout", data: "exec-path" };
      yield { type: "exit", code: 0 };
    },
    ...overrides,
  };
}

describe("shell session wiring (B-2 Task 9)", () => {
  it("bash without isolated reports session output, not shell.exec", async () => {
    const agent = createAgent({
      modelPort: createMockModelPort([
        toolCallScript("t1", "bash", JSON.stringify({ command: "echo from-session" })),
        textScript("ok"),
      ]),
      shell: stubShell(),
    });

    try {
      const state = await agent.run("hi");
      expect(state.status).toBe("done");
      const flat = JSON.stringify(state);
      // Session-path stdout must reach the tool result; the one-shot
      // shell.exec stub's "exec-path" must never appear for a non-isolated call.
      expect(flat).toContain("from-session");
      expect(flat).not.toContain("exec-path");
    } finally {
      await agent.dispose();
    }
  });

  it("dispose kills the session and calls shell.disposeProcesses", async () => {
    let spawnCount = 0;
    let lastChild: ChildProcess | undefined;
    let bgDisposed = false;

    const agent = createAgent({
      modelPort: createMockModelPort([
        toolCallScript("t1", "bash", JSON.stringify({ command: "echo alive" })),
        textScript("ok"),
      ]),
      shell: stubShell({
        async disposeProcesses() {
          bgDisposed = true;
        },
      }),
      sessionSpawner: (opts) => {
        spawnCount += 1;
        const handle = bareBashSpawner(opts);
        lastChild = handle.child;
        return handle;
      },
    });

    const state = await agent.run("run a command");
    expect(state.status).toBe("done");
    expect(spawnCount).toBe(1);
    expect(lastChild).toBeDefined();

    await agent.dispose();
    expect(bgDisposed).toBe(true);
    // Session kill must have actually terminated the child process.
    const child = lastChild!;
    expect(
      child.killed || child.signalCode !== null || child.exitCode !== null,
    ).toBe(true);
  });

  it("dispose is idempotent and safe without a shell", async () => {
    const noShell = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
    });
    await expect(noShell.dispose()).resolves.toBeUndefined();
    await expect(noShell.dispose()).resolves.toBeUndefined();

    const withShell = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      shell: stubShell(),
    });
    await expect(withShell.dispose()).resolves.toBeUndefined();
    await expect(withShell.dispose()).resolves.toBeUndefined();
  });

  it("getSession is a singleton — repeated bash calls spawn one session", async () => {
    let spawnCount = 0;
    const agent = createAgent({
      modelPort: createMockModelPort([
        toolCallScript("t1", "bash", JSON.stringify({ command: "echo one" })),
        toolCallScript("t2", "bash", JSON.stringify({ command: "echo two" })),
        textScript("ok"),
      ]),
      shell: stubShell(),
      sessionSpawner: (opts) => {
        spawnCount += 1;
        return bareBashSpawner(opts);
      },
    });

    try {
      const state = await agent.run("two bash calls");
      expect(state.status).toBe("done");
      const flat = JSON.stringify(state);
      expect(flat).toContain("one");
      expect(flat).toContain("two");
      // Concurrency limit = 1: both calls share a single persistent session.
      expect(spawnCount).toBe(1);
    } finally {
      await agent.dispose();
    }
  });
});
