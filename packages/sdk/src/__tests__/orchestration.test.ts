import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Shell, TopologySpec, ModelPort, ModelRequest } from "@volto/core";
import { createMockModelPort, textDelta, modelDone, toolCallScript, textScript } from "@volto/core";
import { createOrchestrator } from "../orchestration.js";
import type { CreateAgentOptions } from "../create-agent.js";
import { createBashTool, CAP_SHELL_EXEC } from "@volto/tools-shell";

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

// ── Tool-result spill wiring (T5 fix round 1) ──────

describe("Orchestrator — tool-result spill", () => {
  it("F-186 a node runner spills an oversized bash result to disk under the agent cwd", async () => {
    // buildNodeRunner is not exported and TopologyResult carries no
    // tool_result, so the spill store's write is the only observable seam.
    // The store is REAL (createNodeSpillStore writes via node:fs, outside any
    // sandbox), so a temp cwd is safe cross-platform — no platform gate.
    const stdout = "o".repeat(20_000);
    const shell: Shell = {
      async *exec() {
        yield { type: "stdout", data: stdout };
        yield { type: "exit", code: 0 };
      },
    };
    const model = createMockModelPort([
      toolCallScript(
        "spill-call-1",
        "bash",
        JSON.stringify({ command: "spill-o", isolated: true }),
      ),
      textScript("done"),
    ]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "volto-orch-spill-"));

    try {
      const orchestrator = createOrchestrator({
        topology: {
          kind: "pipeline",
          name: "spill-pipeline",
          nodes: [{ name: "a", systemPrompt: "You are A" }],
          order: ["a"],
        },
        // shell:exec puts bash in the node's visible set (it requires
        // CAP_SHELL_EXEC); without it the runner filters the tool out.
        agentOpts: { modelPort: model, model: "test", cwd: root, shell },
        capabilities: new Set([CAP_SHELL_EXEC]),
        adapterTools: [createBashTool(shell)],
      });
      const result = await orchestrator.run("run it");

      // The run completed cleanly — spill never interrupts the loop.
      expect(result.output).toBe("done");

      // The full text landed on disk under <cwd>/.volto/spill/<session>/c1.txt.
      // The session id is node-name + Date.now() + random, so match by glob.
      const sessionDir = path.join(root, ".volto", "spill");
      const sessions = await fs.readdir(sessionDir);
      expect(sessions).toHaveLength(1);
      const filePath = path.join(sessionDir, sessions[0]!, "spill-call-1.txt");
      const onDisk = await fs.readFile(filePath, "utf8");
      expect(onDisk).toBe(stdout);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
