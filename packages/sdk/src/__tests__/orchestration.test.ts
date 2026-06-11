import { describe, it, expect } from "vitest";
import type { TopologySpec, ModelPort, ModelRequest } from "@agent-core/core";
import { createMockModelPort, textDelta, modelDone } from "@agent-core/core";
import { createOrchestrator } from "../orchestration.js";
import type { CreateAgentOptions } from "../create-agent.js";

/**
 * Create a ModelPort that calls a callback with the request's system prompt,
 * allowing tests to return different text per node.
 */
function createPerNodeModel(
  nodeResponses: Record<string, string>,
): ModelPort {
  return {
    async *stream(req: ModelRequest) {
      // Find the system prompt to identify which node this is for
      const systemMsg = req.messages.find((m) => m.role === "system");
      const systemContent = systemMsg?.content ?? "";
      // Match against known node responses
      let response = "default";
      for (const [key, val] of Object.entries(nodeResponses)) {
        if (systemContent.includes(key)) { response = val; break; }
      }
      yield textDelta(response);
      yield modelDone("end_turn");
    },
  };
}

function mockAgentOpts(modelPort: ModelPort): CreateAgentOptions {
  return { modelPort, model: "test" };
}

// ── Pipeline topology tests ──────────────────

describe("Orchestrator — pipeline topology", () => {
  it("runs a 3-node pipeline sequentially, feeding output forward", async () => {
    const model = createPerNodeModel({
      "You are A": "A output",
      "You are B": "B output",
      "You are C": "C output",
    });

    const topology: TopologySpec = {
      kind: "pipeline",
      name: "test-pipeline",
      nodes: [
        { name: "a", systemPrompt: "You are A" },
        { name: "b", systemPrompt: "You are B" },
        { name: "c", systemPrompt: "You are C" },
      ],
      order: ["a", "b", "c"],
    };

    const orchestrator = createOrchestrator({
      topology,
      agentOpts: mockAgentOpts(model),
    });

    const result = await orchestrator.run("start");

    expect(result.nodeOutputs["a"]).toBe("A output");
    expect(result.nodeOutputs["b"]).toBe("B output");
    expect(result.nodeOutputs["c"]).toBe("C output");
    expect(result.output).toBe("C output");
  });

  it("throws on unknown node name in order", async () => {
    const model = createMockModelPort([[textDelta("ok"), modelDone("end_turn")]]);

    const topology: TopologySpec = {
      kind: "pipeline",
      name: "bad-pipeline",
      nodes: [{ name: "x", systemPrompt: "X" }],
      order: ["x", "missing-node"],
    };

    const orchestrator = createOrchestrator({
      topology,
      agentOpts: mockAgentOpts(model),
    });

    await expect(orchestrator.run("go")).rejects.toThrow("Node not found");
  });
});

// ── Supervisor topology tests ──────────────────

describe("Orchestrator — supervisor topology", () => {
  it("runs supervisor then workers in parallel", async () => {
    const model = createPerNodeModel({
      "You route work": "Supervisor decision: run workers",
      "You do task 1": "Worker1 result",
      "You do task 2": "Worker2 result",
    });

    const topology: TopologySpec = {
      kind: "supervisor",
      name: "test-supervisor",
      nodes: [
        { name: "supervisor", systemPrompt: "You route work" },
        { name: "worker1", systemPrompt: "You do task 1" },
        { name: "worker2", systemPrompt: "You do task 2" },
      ],
      order: ["supervisor", "worker1", "worker2"],
    };

    const orchestrator = createOrchestrator({
      topology,
      agentOpts: mockAgentOpts(model),
    });

    const result = await orchestrator.run("do work");

    expect(result.nodeOutputs["supervisor"]).toBe("Supervisor decision: run workers");
    expect(result.nodeOutputs["worker1"]).toBe("Worker1 result");
    expect(result.nodeOutputs["worker2"]).toBe("Worker2 result");
    expect(result.output).toContain("Supervisor decision");
    expect(result.output).toContain("[worker1]: Worker1 result");
    expect(result.output).toContain("[worker2]: Worker2 result");
  });

  it("throws on unknown topology kind", async () => {
    const model = createMockModelPort([[textDelta("ok"), modelDone("end_turn")]]);

    const topology = {
      kind: "unknown",
      name: "bad",
      nodes: [],
      order: [],
    } as unknown as TopologySpec;

    const orchestrator = createOrchestrator({
      topology,
      agentOpts: mockAgentOpts(model),
    });

    await expect(orchestrator.run("go")).rejects.toThrow("Unknown topology kind");
  });
});
