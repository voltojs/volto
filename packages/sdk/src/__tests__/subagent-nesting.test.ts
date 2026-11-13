/**
 * Depth-true nested delegation (design §9).
 *
 * A sub-agent below the depth cap must be able to dispatch its own
 * sub-agent — "a research agent that fans out a few sub-searches" is the
 * two-level shape the cap exists to permit. The inherited `task` instance
 * cannot serve: it is bound to the parent's executor at a fixed depth, so a
 * child must get one bound one level deeper.
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type {
  ModelPort,
  ModelRequest,
  ModelEvent,
  ToolDefinition,
  ToolResult,
} from "@voltojs/core";
import { createMockModelPort, textScript, toolCallScript } from "@voltojs/core";
import type { Tool } from "@voltojs/tools-common";
import type { AgentEntry } from "../agent-registry/index.js";

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

function createEchoTool(): Tool {
  const definition: ToolDefinition = {
    name: "echo",
    description: "echo back",
    inputSchema: { type: "object" },
    requires: [],
    riskTier: "READ_ONLY",
  };
  return {
    definition,
    handler: async (): Promise<ToolResult> => ({ modelContent: "echo" }),
  };
}

function entry(spec: AgentEntry["spec"]): AgentEntry {
  return { id: `project:${spec.name}`, scope: "project", shadowed: false, spec };
}

/** parent → child → grandchild, then each answers back up the chain. */
function twoLevelScript(): ModelEvent[][] {
  return [
    toolCallScript("p1", "task", JSON.stringify({ message: "level one" })),
    toolCallScript("c1", "task", JSON.stringify({ message: "level two" })),
    textScript("grandchild done"),
    textScript("child done"),
    textScript("parent done"),
  ];
}

describe("nested delegation", () => {
  it("lets a first-level sub-agent dispatch its own sub-agent", async () => {
    const { port, requests } = recordingModelPort(twoLevelScript());
    const agent = createAgent({
      modelPort: port,
      tools: [createEchoTool()],
      enableTaskTool: true,
    });

    await agent.run("delegate twice");

    // 0 parent dispatches, 1 child dispatches, 2 grandchild answers,
    // 3 child wraps up on the tool result, 4 parent wraps up.
    expect(requests[1]!.tools.map((t) => t.name)).toContain("task");
    // The grandchild request only exists if the child's dispatch really ran:
    // its opening user message is the message the child sent.
    expect(requests[2]!.messages.map((m) => m.content)).toContain("level two");
    expect(requests).toHaveLength(5);
  });

  it("withdraws task from the sub-agent at the depth cap", async () => {
    const { port, requests } = recordingModelPort(twoLevelScript());
    const agent = createAgent({
      modelPort: port,
      tools: [createEchoTool()],
      enableTaskTool: true,
    });

    await agent.run("delegate twice");

    // Default cap is 2: the grandchild is depth 2 and must not delegate on.
    expect(requests[2]!.tools.map((t) => t.name)).not.toContain("task");
  });

  it("never hands a child the parent's task_output tool", async () => {
    const { port, requests } = recordingModelPort(twoLevelScript());
    const agent = createAgent({
      modelPort: port,
      tools: [createEchoTool()],
      enableTaskTool: true,
    });

    await agent.run("delegate twice");

    // task_output is bound to the parent's background registry; a child
    // holding it could collect tasks it never dispatched.
    expect(requests[1]!.tools.map((t) => t.name)).not.toContain("task_output");
  });

  it("withholds task from a definition whose tool list omits it", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "p1",
        "task",
        JSON.stringify({ message: "go", subagent_type: "reader" }),
      ),
      textScript("child done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      tools: [createEchoTool()],
      enableTaskTool: true,
      agentSpecs: [entry({ name: "reader", tools: ["echo"] })],
    });

    await agent.run("delegate");

    const childToolNames = requests[1]!.tools.map((t) => t.name);
    expect(childToolNames).toEqual(["echo"]);
  });

  it("gives a definition that lists task a working nested dispatch", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "p1",
        "task",
        JSON.stringify({ message: "go", subagent_type: "lead" }),
      ),
      toolCallScript("c1", "task", JSON.stringify({ message: "level two" })),
      textScript("grandchild done"),
      textScript("child done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      tools: [createEchoTool()],
      enableTaskTool: true,
      agentSpecs: [entry({ name: "lead", tools: ["echo", "task"] })],
    });

    await agent.run("delegate");

    expect(requests[1]!.tools.map((t) => t.name).sort()).toEqual(["echo", "task"]);
    expect(requests[2]!.messages.map((m) => m.content)).toContain("level two");
    expect(requests).toHaveLength(5);
  });

  it("refuses a background dispatch from a sub-agent instead of faking it", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript("p1", "task", JSON.stringify({ message: "level one" })),
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "level two", run_in_background: true }),
      ),
      textScript("child done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      tools: [createEchoTool()],
      enableTaskTool: true,
    });

    await agent.run("delegate");

    // The child's next request carries the tool_result for its own call:
    // a named refusal the model can act on, not a fabricated task id.
    const childFollowUp = requests[2]!;
    const rendered = JSON.stringify(childFollowUp.messages);
    expect(rendered).toMatch(/background dispatch is not available/i);
    expect(rendered).not.toMatch(/started in background/i);
  });
});
