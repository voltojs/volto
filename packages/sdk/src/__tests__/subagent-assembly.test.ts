import { describe, it, expect } from "vitest";
import { assembleSubAgent, createAgent } from "../create-agent.js";
import type { AgentSpec } from "../agent-spec.js";
import type { AgentEntry } from "../agent-registry/scan.js";
import type { PermissionConfig } from "@volto/core";
import type {
  ToolDefinition,
  ToolResult,
  ModelPort,
  ModelRequest,
  ModelEvent,
  EventSink,
} from "@volto/core";
import type { Tool } from "@volto/tools-common";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
} from "@volto/core";

function tool(name: string): Tool {
  return {
    definition: {
      name,
      description: name,
      inputSchema: { type: "object" },
      requires: [],
      riskTier: "READ_ONLY",
    },
    handler: async () => ({ modelContent: "" }),
  } as unknown as Tool;
}

const parentTools = [tool("read_file"), tool("write_file"), tool("bash")];
const parentPolicy: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };

describe("sub-agent assembly", () => {
  it("gives the sub-agent only the tools its definition declares", () => {
    const spec: AgentSpec = { name: "searcher", tools: ["read_file"] };
    const assembled = assembleSubAgent({
      spec,
      parentTools,
      parentPolicy,
      parentCapabilities: new Set(["filesystem:read"]),
    });
    expect(assembled.tools.map((t) => t.definition.name)).toEqual(["read_file"]);
  });

  it("intersects tools rather than trusting the definition", () => {
    // "curl" is not among the parent's tools; declaring it must not conjure it.
    const spec: AgentSpec = { name: "x", tools: ["read_file", "curl"] };
    const assembled = assembleSubAgent({
      spec,
      parentTools,
      parentPolicy,
      parentCapabilities: new Set(),
    });
    expect(assembled.tools.map((t) => t.definition.name)).toEqual(["read_file"]);
  });

  it("intersects capabilities", () => {
    const spec: AgentSpec = { name: "x", capabilities: ["filesystem:read", "shell:exec"] };
    const assembled = assembleSubAgent({
      spec,
      parentTools,
      parentPolicy,
      parentCapabilities: new Set(["filesystem:read"]),
    });
    expect([...assembled.capabilities]).toEqual(["filesystem:read"]);
  });

  it("refuses to widen the sandbox and reports the downgrade", () => {
    const spec: AgentSpec = {
      name: "x",
      policy: { sandbox: "danger-full-access", approval: "never" },
    };
    const assembled = assembleSubAgent({
      spec,
      parentTools,
      parentPolicy,
      parentCapabilities: new Set(),
    });
    expect(assembled.permissionConfig.sandbox).toBe("workspace-write");
    expect(assembled.permissionConfig.approval).toBe("ask");
    expect(assembled.downgrades).toContainEqual(
      expect.objectContaining({
        field: "sandbox",
        requested: "danger-full-access",
        effective: "workspace-write",
      }),
    );
  });

  it("reports no downgrade when the definition is already stricter", () => {
    const spec: AgentSpec = {
      name: "x",
      policy: { sandbox: "read-only", approval: "ask" },
    };
    const assembled = assembleSubAgent({
      spec,
      parentTools,
      parentPolicy,
      parentCapabilities: new Set(),
    });
    expect(assembled.permissionConfig.sandbox).toBe("read-only");
    expect(assembled.downgrades).toEqual([]);
  });

  it("inherits every parent tool when the definition names none", () => {
    const spec: AgentSpec = { name: "general" };
    const assembled = assembleSubAgent({
      spec,
      parentTools,
      parentPolicy,
      parentCapabilities: new Set(["filesystem:read"]),
    });
    expect(assembled.tools.map((t) => t.definition.name)).toEqual([
      "read_file",
      "write_file",
      "bash",
    ]);
    expect([...assembled.capabilities]).toEqual(["filesystem:read"]);
  });

  it("gives no tools when the definition declares an empty list", () => {
    const spec: AgentSpec = { name: "silent", tools: [] };
    const assembled = assembleSubAgent({
      spec,
      parentTools,
      parentPolicy,
      parentCapabilities: new Set(["filesystem:read"]),
    });
    expect(assembled.tools).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// Wiring: createAgent + task dispatch
// ──────────────────────────────────────────────

const echoDef: ToolDefinition = {
  name: "echo",
  description: "Echo back the input",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  requires: ["test:echo"],
  riskTier: "READ_ONLY",
};

const writeDef: ToolDefinition = {
  name: "write_note",
  description: "Write a note",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  requires: ["test:write"],
  riskTier: "WRITE_LOW",
};

function createNamedTool(def: ToolDefinition): Tool {
  return {
    definition: def,
    handler: async (input: Record<string, unknown>): Promise<ToolResult> => ({
      modelContent: `${def.name}: ${JSON.stringify(input)}`,
    }),
  };
}

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

function agentEntry(spec: AgentSpec, shadowed = false): AgentEntry {
  return {
    id: `plugin:${spec.name}`,
    scope: "plugin",
    spec,
    shadowed,
  };
}

describe("typed sub-agent dispatch wiring", () => {
  it("hands the child runner only the tools the definition declares (F-021)", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "search", subagent_type: "searcher" }),
      ),
      // Sub-agent turn: text only.
      textScript("found it"),
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [createNamedTool(echoDef), createNamedTool(writeDef)],
      capabilities: new Set(["test:echo", "test:write"]),
      enableTaskTool: true,
      agentSpecs: [
        agentEntry({ name: "searcher", tools: ["echo"], capabilities: ["test:echo"] }),
      ],
    });

    await agent.run("search something");

    // Request 0 = parent turn 1, request 1 = sub-agent, request 2 = parent turn 1 continue.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const subRequest = requests[1]!;
    const subToolNames = subRequest.tools.map((t) => t.name);
    expect(subToolNames).toContain("echo");
    expect(subToolNames).not.toContain("write_note");
    expect(subToolNames).not.toContain("task");
  });

  it("emits a downgrade event when the definition asks for wider permissions (F-023)", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const sink: EventSink = {
      emit(event) {
        events.push(event);
      },
    };

    const mock = createMockModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", subagent_type: "risky" }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: mock,
      enableTaskTool: true,
      eventSink: sink,
      permissionConfig: { sandbox: "workspace-write", approval: "ask" },
      agentSpecs: [
        agentEntry({
          name: "risky",
          policy: { sandbox: "danger-full-access", approval: "never" },
        }),
      ],
    });

    await agent.run("do the risky thing");

    const downgrade = events.find((e) => e.type === "subagent_permission_downgraded");
    expect(downgrade).toBeDefined();
    const downgrades = downgrade!.data["downgrades"] as Array<{
      field: string;
      requested: string;
      effective: string;
    }>;
    expect(downgrades).toContainEqual(
      expect.objectContaining({
        field: "sandbox",
        requested: "danger-full-access",
        effective: "workspace-write",
      }),
    );
    expect(downgrade!.data["subagentType"]).toBe("risky");
  });

  it("surfaces an unknown subagent_type as a tool error, not a crash", async () => {
    const mock = createMockModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", subagent_type: "nope" }),
      ),
      textScript("ok"),
    ]);

    const agent = createAgent({
      modelPort: mock,
      enableTaskTool: true,
      agentSpecs: [agentEntry({ name: "searcher", tools: ["echo"] })],
    });

    const state = await agent.run("use an unknown type");
    const toolMsg = state.messages.find((m) => m.role === "tool") as
      | { content: Array<{ content: string | Array<{ type: string; text?: string }>; isError?: boolean }> }
      | undefined;
    expect(toolMsg).toBeDefined();
    const first = toolMsg!.content[0]!;
    const firstText =
      typeof first.content === "string"
        ? first.content
        : first.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    expect(first.isError).toBe(true);
    expect(firstText).toContain("nope");
  });

  it("ignores shadowed entries when resolving a type", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", subagent_type: "searcher" }),
      ),
      textScript("sub"),
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [createNamedTool(echoDef), createNamedTool(writeDef)],
      capabilities: new Set(["test:echo", "test:write"]),
      enableTaskTool: true,
      agentSpecs: [
        // Shadowed loser: would grant write_note.
        agentEntry({ name: "searcher", tools: ["echo", "write_note"] }, true),
        // Winner: only echo.
        agentEntry({ name: "searcher", tools: ["echo"] }),
      ],
    });

    await agent.run("search");
    const subRequest = requests[1]!;
    const subToolNames = subRequest.tools.map((t) => t.name);
    expect(subToolNames).toContain("echo");
    expect(subToolNames).not.toContain("write_note");
  });
});
