import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type {
  ModelPort,
  ModelRequest,
  ModelEvent,
} from "@volto/core";
import { createMockModelPort, textScript } from "@volto/core";

/** Wrap a mock model port so each request's visible tool names are recorded. */
function recordingModelPort(script: ModelEvent[][]) {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(script);
  const port: ModelPort = {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(req);
      yield* inner.stream(req);
    },
  };
  return { port, requests };
}

describe("maxAgentDepth wiring (F-024 / F-025)", () => {
  it("grants the delegation budget to the main agent by default (maxAgentDepth = 2)", async () => {
    const { port, requests } = recordingModelPort([textScript("ok")]);

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
    });
    await agent.run("hello");

    expect(requests.length).toBeGreaterThanOrEqual(1);
    const toolNames = requests[0]!.tools.map((t) => t.name);
    expect(toolNames).toContain("task");
  });

  it("hides task at the cap: maxAgentDepth 0 leaves the main agent without the budget", async () => {
    const { port, requests } = recordingModelPort([textScript("ok")]);

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      maxAgentDepth: 0,
    });
    await agent.run("hello");

    expect(requests.length).toBeGreaterThanOrEqual(1);
    const toolNames = requests[0]!.tools.map((t) => t.name);
    expect(toolNames).not.toContain("task");
  });

  it("keeps non-delegation tools visible when the budget is exhausted", async () => {
    const { port, requests } = recordingModelPort([textScript("ok")]);

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      maxAgentDepth: 0,
      tools: [],
    });
    await agent.run("hello");

    // ask_user and todo_write are always assembled; they must survive the cap.
    const toolNames = requests[0]!.tools.map((t) => t.name);
    expect(toolNames).toContain("ask_user");
    expect(toolNames).toContain("todo_write");
  });
});
