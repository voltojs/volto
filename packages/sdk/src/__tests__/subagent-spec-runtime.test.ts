/**
 * A definition's `systemPrompt` and `model` must reach the child Runner.
 *
 * Parsing them out of frontmatter is not enough: a sub-agent whose prompt
 * never reaches the model is just a tool subset, and a `model:` line the
 * runtime ignores is the "configured it, nothing happened" failure the
 * design (§7) calls out by name.
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
import type { Tool } from "@voltojs/tools/common";
import type { AgentEntry } from "../agent-registry/index.js";

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

/** Wrap a mock port so each request (parent, then child) is observable. */
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

function entry(spec: AgentEntry["spec"]): AgentEntry {
  return { id: `project:${spec.name}`, scope: "project", shadowed: false, spec };
}

/** Parent dispatches `reader` once, the child answers, the parent wraps up. */
function dispatchScript(): ModelEvent[][] {
  return [
    toolCallScript(
      "c1",
      "task",
      JSON.stringify({ message: "find it", subagent_type: "reader" }),
    ),
    textScript("sub done"),
    textScript("parent done"),
  ];
}

describe("sub-agent dispatch result", () => {
  it("reports a real task id and the child session id", async () => {
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const { port } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      chatSessionId: "sess-1",
      eventSink: {
        emit: (event) => {
          events.push(event as { type: string; data?: Record<string, unknown> });
        },
      },
      agentSpecs: [entry({ name: "reader" })],
    });

    await agent.run("delegate");

    const taskResult = events.find(
      (e) => e.type === "tool_result" && e.data?.["name"] === "task",
    );
    const meta = taskResult?.data?.["displayMetadata"] as Record<string, unknown>;
    // "sync" was a placeholder: the UI cannot correlate it with anything, and
    // it collides across every synchronous dispatch in a session.
    expect(meta["taskId"]).not.toBe("sync");
    expect(meta["sessionId"]).toMatch(/^sess-1-sub-/);
  });
});

describe("sub-agent definition at runtime", () => {
  it("seeds the child with the definition's systemPrompt", async () => {
    const { port, requests } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      systemPrompt: "PARENT PROMPT",
      enableTaskTool: true,
      agentSpecs: [
        entry({ name: "reader", systemPrompt: "You are the reader sub-agent." }),
      ],
    });

    await agent.run("delegate");

    const child = requests[1]!;
    expect(child.messages[0]).toMatchObject({
      role: "system",
      content: "You are the reader sub-agent.",
    });
    // The parent's own prompt must not leak in: sub-agents start clean.
    expect(child.messages.map((m) => m.content)).not.toContain("PARENT PROMPT");
  });

  it("leaves the child without a system message when the definition has no body", async () => {
    const { port, requests } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      systemPrompt: "PARENT PROMPT",
      enableTaskTool: true,
      agentSpecs: [entry({ name: "reader" })],
    });

    await agent.run("delegate");

    const child = requests[1]!;
    expect(child.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("calls the child with the model its definition names", async () => {
    const { port, requests } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      agentSpecs: [entry({ name: "reader", model: "reader-model" })],
    });

    await agent.run("delegate");

    expect(requests[0]!.model).toBe("parent-model");
    expect(requests[1]!.model).toBe("reader-model");
  });

  it("keeps the parent model when the definition names none", async () => {
    const { port, requests } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      agentSpecs: [entry({ name: "reader" })],
    });

    await agent.run("delegate");

    expect(requests[1]!.model).toBe("parent-model");
  });

  it("applies the definition's sampling settings to the child request", async () => {
    const { port, requests } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      maxTokens: 4096,
      temperature: 0.9,
      enableTaskTool: true,
      agentSpecs: [
        entry({
          name: "reader",
          maxTokens: 512,
          temperature: 0,
          reasoningEffort: "low",
        }),
      ],
    });

    await agent.run("delegate");

    const child = requests[1]!;
    expect(child.maxTokens).toBe(512);
    expect(child.temperature).toBe(0);
    expect(child.reasoningEffort).toBe("low");
    // The parent's own call keeps the parent's settings.
    expect(requests[0]!.maxTokens).toBe(4096);
    expect(requests[0]!.temperature).toBe(0.9);
  });

  it("applies the definition's responseFormat to the child request", async () => {
    const { port, requests } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      agentSpecs: [
        entry({
          name: "reader",
          responseFormat: {
            type: "json",
            schema: { type: "object", properties: { found: { type: "boolean" } } },
          },
        }),
      ],
    });

    await agent.run("delegate");

    expect(requests[1]!.responseFormat).toEqual({
      type: "json",
      schema: { type: "object", properties: { found: { type: "boolean" } } },
    });
    expect(requests[0]!.responseFormat).toBeUndefined();
  });

  it("caps the child's inner loop with the definition's maxIterations", async () => {
    // The child is scripted to keep calling a tool; only its own iteration
    // cap can stop it. Two child iterations, then the parent wraps up.
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "p1",
        "task",
        JSON.stringify({ message: "loop", subagent_type: "looper" }),
      ),
      toolCallScript("c1", "echo", "{}"),
      toolCallScript("c2", "echo", "{}"),
      toolCallScript("c3", "echo", "{}"),
      toolCallScript("c4", "echo", "{}"),
      toolCallScript("c5", "echo", "{}"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      tools: [createEchoTool()],
      maxIterations: 20,
      enableTaskTool: true,
      agentSpecs: [entry({ name: "looper", tools: ["echo"], maxIterations: 2 })],
    });

    await agent.run("delegate");

    // The definition's tool list makes child requests identifiable: only the
    // parent ever sees `task`.
    const childRequests = requests.filter(
      (r) => !r.tools.some((t) => t.name === "task"),
    );
    // Two model calls, then the child's own runaway guard stops it —
    // without the cap it would keep calling echo until the script ran out.
    expect(childRequests).toHaveLength(2);
  });

  it("lets the same child run on without a maxIterations in its definition", async () => {
    // Control for the cap test above: same script, same tools, no cap — the
    // child keeps calling echo, which is what makes the 2 above meaningful.
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "p1",
        "task",
        JSON.stringify({ message: "loop", subagent_type: "looper" }),
      ),
      toolCallScript("c1", "echo", "{}"),
      toolCallScript("c2", "echo", "{}"),
      toolCallScript("c3", "echo", "{}"),
      toolCallScript("c4", "echo", "{}"),
      toolCallScript("c5", "echo", "{}"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      tools: [createEchoTool()],
      maxIterations: 20,
      enableTaskTool: true,
      agentSpecs: [entry({ name: "looper", tools: ["echo"] })],
    });

    await agent.run("delegate");

    const childRequests = requests.filter(
      (r) => !r.tools.some((t) => t.name === "task"),
    );
    expect(childRequests.length).toBeGreaterThan(2);
  });

  it("keeps the parent model for a general-purpose (untyped) sub-agent", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "find it" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      agentSpecs: [entry({ name: "reader", model: "reader-model" })],
    });

    await agent.run("delegate");

    expect(requests[1]!.model).toBe("parent-model");
  });
});
