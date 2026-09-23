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
  it("refuses a child write attempt at runtime under the narrowed policy (acceptance: denial signature)", async () => {
    // Roadmap 1.4 acceptance 2: "child permissions may only narrow — a
    // write under the narrowed policy is refused; assert the refusal
    // signature (AGENTS.md §2.1)". Assembly-level narrowing and
    // visible-set pruning are pinned elsewhere; this exercises the runtime
    // layer those tests never touch: the scripted child model IGNORES its
    // visible set and calls write_note anyway, and the refusal must come
    // back as an isError tool result carrying a signature — and be present
    // in the child's NEXT model request, i.e. on the model-visible path,
    // not just in a pure function or an event.
    //
    // Config note: the roadmap phrases it as spec danger-full-access under
    // a read-only parent, but a read-only PARENT cannot dispatch at all —
    // task is WRITE_LOW and the read-only ceiling prunes it (fail-closed,
    // documented in plan-visibility.test.ts). The enforceable equivalent
    // pins the same invariant from the child's side: parent workspace-write
    // (can dispatch), child spec read-only (narrowed), child write attempt
    // refused at runtime.
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "write the note", subagent_type: "risky" }),
      ),
      // Child attempt 1: call the pruned write tool anyway.
      toolCallScript("c2", "write_note", JSON.stringify({ text: "pwned" })),
      // Child attempt 2: after the refusal landed in its context.
      textScript("could not write, stopping"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [createNamedTool(echoDef), createNamedTool(writeDef)],
      capabilities: new Set(["test:echo", "test:write"]),
      enableTaskTool: true,
      permissionConfig: { sandbox: "workspace-write", approval: "never" },
      agentSpecs: [
        agentEntry({
          name: "risky",
          tools: ["echo", "write_note"],
          capabilities: ["test:echo", "test:write"],
          policy: { sandbox: "read-only", approval: "never" },
        }),
      ],
    });

    await agent.run("write something");

    expect(requests.length).toBeGreaterThanOrEqual(3);
    // Gate level: the narrowed ceiling pruned the write tool from the child
    // request (spec whitelist and capabilities both name it — only the
    // ceiling can be responsible).
    const childAttempt = requests[1]!;
    const visible = childAttempt.tools.map((t) => t.name);
    expect(visible).toContain("echo");
    expect(visible).not.toContain("write_note");

    // Runtime level: the scripted call still lands — routeToolCall must
    // refuse it, and the refusal must be an isError result carrying a
    // signature (AGENTS.md §2.1: assert the refusal itself, never silence).
    const childAfter = requests[2]!;
    const toolBlocks = childAfter.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) =>
        typeof m.content === "string" ? [] : (m.content as unknown as Array<Record<string, unknown>>),
      );
    const refusal = toolBlocks.find((b) => JSON.stringify(b).includes('"c2"'));
    expect(refusal, "child never saw a tool_result for the refused call").toBeDefined();
    expect(refusal!["isError"]).toBe(true);
    const refusalText = JSON.stringify(refusal!["content"]);
    expect(refusalText).toContain("write_note");
    expect(refusalText).toMatch(/Unknown tool|not available|refused by the permission policy/);
  });
});


