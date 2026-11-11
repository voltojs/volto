/**
 * Per-dispatch permission for sub-agents (spec 2026-11-11).
 *
 * A dispatch may ASK for a preset; it can never exceed the parent's sandbox
 * boundary. Asking for more is the caller's own mistake, so it fails loudly
 * (the model can self-correct against the listed presets) and — critically —
 * before any child runner or provider I/O exists.
 */
import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type {
  EventSink,
  ModelEvent,
  ModelPort,
  ModelRequest,
  ToolDefinition,
  TranscriptEventInput,
} from "@volto/core";
import { createMockModelPort, textScript, toolCallScript } from "@volto/core";

function rec(script: ModelEvent[][]) {
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

function textOf(modelContent: unknown): string {
  if (typeof modelContent === "string") return modelContent;
  if (Array.isArray(modelContent)) {
    return modelContent.map((b) => (b as { text?: string }).text ?? "").join("");
  }
  return "";
}

const writeTool: ToolDefinition = {
  name: "write_probe",
  description: "Pretends to write. Risk tier is what the sandbox gate reads.",
  inputSchema: { type: "object", properties: {}, required: [] },
  requires: [],
  riskTier: "WRITE_HIGH",
};

function writeProbeTool() {
  return {
    definition: writeTool,
    handler: async () => ({ modelContent: "wrote" }),
  };
}

function dispatchScript(): ModelEvent[][] {
  return [
    toolCallScript("c1", "task", JSON.stringify({ message: "look", permission: "read-only" })),
    textScript("child done"),
    textScript("parent done"),
  ];
}

describe("sub-agent dispatch permission", () => {
  it("passes the requested preset to the child and tells the child about it", async () => {
    const { port, requests } = rec(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      permissionConfig: { sandbox: "workspace-write", approval: "never" },
    });

    await agent.run("delegate");

    const childAll = (requests[1]?.messages ?? [])
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    // G1: the child's context carries the boundary announcement, so the model
    // knows it may not write instead of learning it by being refused. The
    // wording is derived from the matrix, not from the preset name.
    expect(childAll).toContain("Permission boundary for this session");
    expect(childAll).toContain("cannot write to the filesystem");
  });

  it("removes a write tool from the child's visible set under a read-only dispatch", async () => {
    const childRequests: ModelRequest[] = [];
    const { port } = rec([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "write something", permission: "read-only", tools: ["write_probe"] }),
      ),
      toolCallScript("c2", "write_probe", JSON.stringify({})),
      textScript("child done"),
      textScript("parent done"),
    ]);
    const recording: ModelPort = {
      async *stream(req) {
        childRequests.push(req);
        yield* port.stream(req);
      },
    };
    const agent = createAgent({
      modelPort: recording,
      enableTaskTool: true,
      tools: [writeProbeTool()],
      permissionConfig: { sandbox: "workspace-write", approval: "never" },
    });

    await agent.run("delegate a write");

    // Decisive form: the ceiling strips the tool from what the child is even
    // offered, so there is nothing for it to call. (Asserting only "did not
    // write" would also pass if the child never ran at all.)
    const childRequest = childRequests[1]!;
    const childToolNames = childRequest.tools.map((t) => t.name);
    expect(childToolNames).not.toContain("write_probe");
    // The parent still had it — the drop is the dispatch's doing.
    expect(childRequests[0]!.tools.map((t) => t.name)).toContain("write_probe");
  });

  it("rejects a widening request before any child runner exists", async () => {
    const { port, requests } = rec([
      toolCallScript("c1", "task", JSON.stringify({ message: "look", permission: "full" })),
      textScript("parent recovered"),
    ]);
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      permissionConfig: { sandbox: "workspace-write", approval: "ask" },
    });

    const state = await agent.run("delegate");

    const toolText = state.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .map((b) => (b as { content?: unknown }).content)
      .map((c) => textOf(c))
      .join("\n");
    expect(toolText).toMatch(/read-only/);
    expect(toolText).toMatch(/ask/);
    // Parent call + the recovery call only: no child ever reached the model.
    expect(requests).toHaveLength(2);
  });

  it("lets a definition tighten further than the dispatch", async () => {
    const { port } = rec([
      toolCallScript("c1", "task", JSON.stringify({ message: "w", subagent_type: "locky", permission: "auto" })),
      textScript("child done"),
      textScript("parent done"),
    ]);
    const sinkEvents: TranscriptEventInput[] = [];
    const sink: EventSink = { emit: (e) => sinkEvents.push(e as TranscriptEventInput) };
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      eventSink: sink,
      chatSessionId: "sess-parent",
      permissionConfig: { sandbox: "workspace-write", approval: "never" },
      agentSpecs: [
        {
          id: "plugin:locky",
          scope: "plugin",
          shadowed: false,
          spec: {
            name: "locky",
            description: "read-only reviewer",
            systemPrompt: "be careful",
            // AgentSpec calls the declaration `policy`; it resolves to
            // `permissionConfig` through assembleSubAgent.
            policy: { sandbox: "read-only", approval: "never" },
          },
        },
      ] as never,
    });

    await agent.run("delegate to the locked agent");

    const started = sinkEvents.find((e) => e.type === "subagent_started");
    expect(started).toBeDefined();
    expect((started!.data as { permission?: { sandbox: string } }).permission?.sandbox).toBe(
      "read-only",
    );
  });

  it("publishes the effective permission on the start bracket", async () => {
    const { port } = rec(dispatchScript());
    const sinkEvents: TranscriptEventInput[] = [];
    const sink: EventSink = { emit: (e) => sinkEvents.push(e as TranscriptEventInput) };
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      eventSink: sink,
      chatSessionId: "sess-parent",
      permissionConfig: { sandbox: "workspace-write", approval: "never" },
    });

    await agent.run("delegate");

    const started = sinkEvents.find((e) => e.type === "subagent_started");
    expect((started!.data as { permission?: unknown }).permission).toMatchObject({
      sandbox: "read-only",
      approval: "never",
      preset: "read-only",
    });
  });
});