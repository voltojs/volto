import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type {
  ModelPort,
  ModelRequest,
  ModelEvent,
  ToolDefinition,
  ToolResult,
} from "@voltojs/core";
import type { Tool } from "@voltojs/tools-common";
import { createMockModelPort, textScript, toolCallScript, CAP_AGENT_DEPTH_AVAILABLE } from "@voltojs/core";

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

/**
 * A tool gated purely by the delegation budget — its presence in a model
 * request is a direct readout of whether that agent's capability set holds
 * CAP_AGENT_DEPTH_AVAILABLE.
 */
function createBudgetProbeTool(): Tool {
  const definition: ToolDefinition = {
    name: "depth_probe",
    description: "visible only while the delegation budget is held",
    inputSchema: { type: "object" },
    requires: [CAP_AGENT_DEPTH_AVAILABLE],
    riskTier: "READ_ONLY",
  };
  return {
    definition,
    handler: async (): Promise<ToolResult> => ({ modelContent: "probe" }),
  };
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

describe("child-side depth budget (createSubAgentExecutor)", () => {
  it("withholds the budget from a first-level child when depth >= maxAgentDepth", async () => {
    // maxAgentDepth 1: the main agent (depth 0) holds the budget, but the
    // child it dispatches is depth 1 — not below the cap — so the child's
    // capability set must not contain CAP_AGENT_DEPTH_AVAILABLE.
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [createBudgetProbeTool()],
      enableTaskTool: true,
      maxAgentDepth: 1,
    });
    await agent.run("delegate once");

    // Request 0 = parent (depth 0 < 1 → budget held), request 1 = child.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const parentToolNames = requests[0]!.tools.map((t) => t.name);
    expect(parentToolNames).toContain("depth_probe");
    const childToolNames = requests[1]!.tools.map((t) => t.name);
    expect(childToolNames).not.toContain("depth_probe");
  });

  it("keeps the budget on a first-level child while depth < maxAgentDepth", async () => {
    // Default cap 2: the depth-1 child is still below the cap, so the probe
    // gated by CAP_AGENT_DEPTH_AVAILABLE stays in its visible set.
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [createBudgetProbeTool()],
      enableTaskTool: true,
    });
    await agent.run("delegate once");

    expect(requests.length).toBeGreaterThanOrEqual(2);
    const childToolNames = requests[1]!.tools.map((t) => t.name);
    expect(childToolNames).toContain("depth_probe");
  });
});
