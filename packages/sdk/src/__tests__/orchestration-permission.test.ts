/**
 * Topology nodes and the shared dispatch permission contract (spec 2026-11-11
 * D9). An author writes the topology by hand, so an over-broad node request
 * NARROWS to the agent's policy instead of failing a build — the opposite of
 * the model-facing task tool, where the model gets an error it can correct.
 */
import { describe, it, expect } from "vitest";
import { createOrchestrator } from "../orchestration.js";
import type { TopologySpec } from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";
import { createMockModelPort, textScript } from "@volto/core";
import type { ToolDefinition } from "@volto/core";

const writeTool: ToolDefinition = {
  name: "write_probe",
  description: "Pretends to write.",
  inputSchema: { type: "object", properties: {}, required: [] },
  requires: [],
  riskTier: "WRITE_HIGH",
};

function writeProbe() {
  return { definition: writeTool, handler: async () => ({ modelContent: "wrote" }) };
}

const irreversibleTool: ToolDefinition = {
  name: "irreversible_probe",
  description: "Above a workspace-write ceiling.",
  inputSchema: { type: "object", properties: {}, required: [] },
  requires: [],
  riskTier: "IRREVERSIBLE",
};

function irreversibleProbe() {
  return { definition: irreversibleTool, handler: async () => ({ modelContent: "boom" }) };
}

function recordingPort(script: Parameters<typeof createMockModelPort>[0]) {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(script);
  const port: ModelPort = {
    async *stream(req) {
      requests.push(req);
      yield* inner.stream(req);
    },
  };
  return { port, requests };
}

const oneNode = (permission?: "read-only" | "ask" | "auto" | "full"): TopologySpec => ({
  name: "solo",
  kind: "pipeline",
  model: "parent-model",
  order: ["only"],
  nodes: [
    {
      name: "only",
      systemPrompt: "you are a node",
      ...(permission !== undefined ? { permission } : {}),
    },
  ],
});

describe("orchestration — node permission", () => {
  it("drops write tools from a read-only node", async () => {
    const { port, requests } = recordingPort([textScript("node done")]);
    const orchestrator = createOrchestrator({
      topology: oneNode("read-only"),
      agentOpts: {
        modelPort: port,
        permissionConfig: { sandbox: "workspace-write", approval: "never" },
      },
      adapterTools: [writeProbe()],
      capabilities: new Set(["test:write"]),
    } as never);

    const result = await orchestrator.run("go");

    expect(result.output).toContain("node done");
    const toolNames = requests[0]!.tools.map((t) => t.name);
    expect(toolNames).not.toContain("write_probe");
  });

  it("keeps a write tool when the node does not narrow", async () => {
    const { port, requests } = recordingPort([textScript("node done")]);
    const orchestrator = createOrchestrator({
      topology: oneNode(),
      agentOpts: {
        modelPort: port,
        permissionConfig: { sandbox: "workspace-write", approval: "never" },
      },
      adapterTools: [writeProbe()],
      capabilities: new Set(["test:write"]),
    } as never);

    await orchestrator.run("go");

    expect(requests[0]!.tools.map((t) => t.name)).toContain("write_probe");
  });

  it("narrows an over-broad node request instead of failing the build", async () => {
    // Author face (D9): `full` on a workspace-write agent collapses to the
    // agent's boundary. A throw here would make an over-declared topology
    // unrunnable for a reason the author cannot observe at runtime.
    const { port, requests } = recordingPort([textScript("node done")]);
    const orchestrator = createOrchestrator({
      topology: oneNode("full"),
      agentOpts: {
        modelPort: port,
        permissionConfig: { sandbox: "workspace-write", approval: "never" },
      },
      adapterTools: [writeProbe(), irreversibleProbe()],
      capabilities: new Set(["test:write"]),
    } as never);

    await orchestrator.run("go");

    // Narrowed to workspace-write. Prove it with a tool above that ceiling —
    // a WRITE_HIGH probe survives BOTH workspace-write and danger-full-access,
    // so the old assertion could not tell the two apart.
    const names = requests[0]!.tools.map((t) => t.name);
    expect(names).not.toContain("irreversible_probe");
    expect(names).toContain("write_probe");
  });
});