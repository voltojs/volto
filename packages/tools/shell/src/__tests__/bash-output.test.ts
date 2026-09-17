import { describe, it, expect } from "vitest";
import type { Shell } from "@volto/core";
import { createBashOutputTool, CAP_SHELL_EXEC } from "../index.js";

interface FakeOutput {
  text: string;
  cursor: string;
  overflowed: boolean;
  droppedBytes: number;
}

/**
 * Shell stub whose readProcessOutput is cursor-aware: when the caller
 * repeats the cursor already handed out, it returns empty text — which is
 * exactly the contract the tool must surface as "(no new output)".
 */
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

describe("bash_output tool", () => {
  it("returns process output", async () => {
    const tool = createBashOutputTool(
      shellWithProcesses({
        p1: { text: "log line", cursor: "8", overflowed: false, droppedBytes: 0 },
      }),
    );
    const r = await tool.handler({ process_id: "p1" });
    expect(r.isError).toBeFalsy();
    expect(r.modelContent).toContain("log line");
    expect(r.displayMetadata?.processId).toBe("p1");
    expect(r.displayMetadata?.cursor).toBe("8");
  });

  it("second read with cursor returns empty rather than repeating", async () => {
    const tool = createBashOutputTool(
      shellWithProcesses({
        p1: { text: "log line", cursor: "8", overflowed: false, droppedBytes: 0 },
      }),
    );
    const first = await tool.handler({ process_id: "p1" });
    const cursor = String(first.displayMetadata?.cursor ?? "8");
    const second = await tool.handler({ process_id: "p1", cursor });
    expect(second.isError).toBeFalsy();
    expect(second.modelContent).not.toContain("log line");
    expect(second.modelContent).toContain("no new output");
  });

  it("notes overflow when the ring buffer discarded earlier bytes", async () => {
    const tool = createBashOutputTool(
      shellWithProcesses({
        p1: { text: "tail", cursor: "300", overflowed: true, droppedBytes: 1024 },
      }),
    );
    const r = await tool.handler({ process_id: "p1" });
    expect(r.isError).toBeFalsy();
    expect(r.modelContent).toContain("tail");
    expect(r.modelContent).toContain("earlier output discarded");
    expect(r.modelContent).toContain("1024");
    expect(r.displayMetadata?.overflowed).toBe(true);
    expect(r.displayMetadata?.droppedBytes).toBe(1024);
  });

  it("unknown process_id is an explicit isError", async () => {
    const tool = createBashOutputTool(shellWithProcesses({}));
    const r = await tool.handler({ process_id: "gone" });
    expect(r.isError).toBe(true);
    expect(r.modelContent).toMatch(/not found|已结束/i);
  });

  it("bash_output on an id from a previous host process is an explicit isError", async () => {
    // Host restart / new agent: the process registry is empty, so a stale
    // id from the previous host must surface as isError with a not-found
    // message — never as silent empty output.
    const tool = createBashOutputTool({
      async *exec() {
        yield { type: "exit", code: 0 };
      },
      async readProcessOutput() {
        throw new Error("Process not found: bg-1-1234 (可能已随上次会话结束)");
      },
    });
    const r = await tool.handler({ process_id: "bg-1-1234" });
    expect(r.isError).toBe(true);
    expect(r.modelContent).toMatch(/not found|已结束/i);
    expect(r.modelContent).not.toMatch(/^\(no new output\)$/);
  });

  it("missing readProcessOutput on shell is an explicit isError", async () => {
    const tool = createBashOutputTool({
      async *exec() {
        yield { type: "exit", code: 0 };
      },
    });
    const r = await tool.handler({ process_id: "p1" });
    expect(r.isError).toBe(true);
    expect(r.modelContent).toMatch(/not available/i);
  });

  it("definition requires CAP_SHELL_EXEC and is READ_ONLY", () => {
    const tool = createBashOutputTool(shellWithProcesses({}));
    expect(tool.definition.requires).toEqual([CAP_SHELL_EXEC]);
    expect(tool.definition.riskTier).toBe("READ_ONLY");
    expect(tool.definition.inputSchema.required).toContain("process_id");
  });
});
