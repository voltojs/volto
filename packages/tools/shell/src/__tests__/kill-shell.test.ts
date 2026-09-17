import { describe, it, expect } from "vitest";
import type { Shell } from "@volto/core";
import { createKillShellTool, CAP_SHELL_EXEC } from "../index.js";

interface FakeOutput {
  text: string;
  cursor: string;
  overflowed: boolean;
  droppedBytes: number;
}

function shellWithProcesses(outputs: Record<string, FakeOutput>): Shell {
  return {
    async *exec() {
      yield { type: "exit", code: 0 };
    },
    async launch() {
      return "p1";
    },
    async readProcessOutput(id, cursor) {
      const o = outputs[id];
      if (!o) throw new Error(`Process not found: ${id}`);
      if (cursor === o.cursor) {
        return { text: "", cursor: o.cursor, overflowed: false, droppedBytes: 0 };
      }
      return o;
    },
    async killProcess(id) {
      if (!outputs[id]) throw new Error(`Process not found: ${id}`);
      delete outputs[id];
    },
    listProcesses() {
      return [];
    },
    async disposeProcesses() {},
  };
}

describe("kill_shell tool", () => {
  it("kills a known process", async () => {
    const shell = shellWithProcesses({
      p1: { text: "", cursor: "0", overflowed: false, droppedBytes: 0 },
    });
    const tool = createKillShellTool(shell);
    const r = await tool.handler({ process_id: "p1" });
    expect(r.isError).toBeFalsy();
    expect(r.modelContent).toContain("p1");
    // The process must actually be gone from the registry, not just "ok".
    await expect(shell.readProcessOutput!("p1")).rejects.toThrow(/not found/i);
  });

  it("unknown process_id is an explicit isError", async () => {
    const tool = createKillShellTool(shellWithProcesses({}));
    const r = await tool.handler({ process_id: "gone" });
    expect(r.isError).toBe(true);
    expect(r.modelContent).toMatch(/not found|已结束/i);
  });

  it("kill_shell on an id from a previous host process is an explicit isError", async () => {
    // Host restart / new agent: the process registry is empty, so a stale
    // id from the previous host must surface as isError with a not-found
    // message — never as a silent success.
    const tool = createKillShellTool({
      async *exec() {
        yield { type: "exit", code: 0 };
      },
      async killProcess() {
        throw new Error("Process not found: bg-1-1234 (可能已随上次会话结束)");
      },
    });
    const r = await tool.handler({ process_id: "bg-1-1234" });
    expect(r.isError).toBe(true);
    expect(r.modelContent).toMatch(/not found|已结束/i);
    expect(r.modelContent).not.toContain("terminated");
  });

  it("missing killProcess on shell is an explicit isError", async () => {
    const tool = createKillShellTool({
      async *exec() {
        yield { type: "exit", code: 0 };
      },
    });
    const r = await tool.handler({ process_id: "p1" });
    expect(r.isError).toBe(true);
    expect(r.modelContent).toMatch(/not available/i);
  });

  it("definition requires CAP_SHELL_EXEC and is WRITE_HIGH", () => {
    const tool = createKillShellTool(shellWithProcesses({}));
    expect(tool.definition.requires).toEqual([CAP_SHELL_EXEC]);
    expect(tool.definition.riskTier).toBe("WRITE_HIGH");
    expect(tool.definition.inputSchema.required).toContain("process_id");
  });
});
