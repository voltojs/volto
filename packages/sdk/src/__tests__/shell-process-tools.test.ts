import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@volto/core";
import type { Shell, ModelRequest, ModelEvent, ModelPort } from "@volto/core";

/**
 * Wrap a base ModelPort so the first request's visible tool names are captured.
 * Captures on every call; single-turn tests only observe the first value.
 */
function capturingModelPort(
  base: ModelPort,
  captured: { tools: string[] },
): ModelPort {
  return {
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      captured.tools = req.tools.map((t) => t.name);
      yield* base.stream(req);
    },
  };
}

function stubShell(overrides: Partial<Shell> = {}): Shell {
  return {
    async *exec() {
      yield { type: "stdout", data: "x" };
      yield { type: "exit", code: 0 };
    },
    async launch() {
      return "bg-1";
    },
    async readProcessOutput() {
      return { text: "out", cursor: "3", overflowed: false, droppedBytes: 0 };
    },
    async killProcess() {},
    listProcesses() {
      return [
        {
          id: "bg-1",
          pid: 1,
          command: "x",
          kind: "background" as const,
          running: false,
        },
      ];
    },
    async disposeProcesses() {},
    ...overrides,
  };
}

describe("shell process tools wiring", () => {
  it("registers bash, bash_output and kill_shell when a shell is provided", async () => {
    const captured = { tools: [] as string[] };
    const agent = createAgent({
      modelPort: capturingModelPort(
        createMockModelPort([textScript("ok")]),
        captured,
      ),
      shell: stubShell(),
    });

    const state = await agent.run("hi");
    expect(state.status).toBe("done");
    expect(captured.tools).toContain("bash");
    expect(captured.tools).toContain("bash_output");
    expect(captured.tools).toContain("kill_shell");
  });

  it("does not register shell process tools when no shell is provided", async () => {
    const captured = { tools: [] as string[] };
    const agent = createAgent({
      modelPort: capturingModelPort(
        createMockModelPort([textScript("ok")]),
        captured,
      ),
    });

    await agent.run("hi");
    expect(captured.tools).not.toContain("bash");
    expect(captured.tools).not.toContain("bash_output");
    expect(captured.tools).not.toContain("kill_shell");
  });

  it("dispose() calls shell.disposeProcesses", async () => {
    let disposed = false;
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      shell: stubShell({
        async disposeProcesses() {
          disposed = true;
        },
      }),
    });

    await agent.dispose();
    expect(disposed).toBe(true);
  });

  it("dispose() is a no-op when no shell is provided", async () => {
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
    });

    await expect(agent.dispose()).resolves.toBeUndefined();
  });

  it("exposes the effective shell on ports.shell", async () => {
    const shell = stubShell();
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      shell,
    });

    expect(agent.ports.shell).toBe(shell);
  });

  it("executes bash_output through the shell tool executor", async () => {
    const reads: Array<{ processId: string; cursor?: string }> = [];
    const shell = stubShell({
      async readProcessOutput(processId: string, cursor?: string) {
        reads.push({ processId, cursor });
        return { text: "hello-bg", cursor: "8", overflowed: false, droppedBytes: 0 };
      },
    });

    const mockModel = createMockModelPort([
      toolCallScript("c1", "bash_output", '{"process_id":"bg-1"}'),
      textScript("read"),
    ]);
    const agent = createAgent({ modelPort: mockModel, shell });

    const state = await agent.run("read the background output");
    expect(state.status).toBe("done");
    expect(reads).toEqual([{ processId: "bg-1", cursor: undefined }]);
    const toolResult = state.messages.find((m) => m.role === "tool");
    expect(toolResult).toBeDefined();
    expect(JSON.stringify(toolResult?.content)).toContain("hello-bg");
  });
});
