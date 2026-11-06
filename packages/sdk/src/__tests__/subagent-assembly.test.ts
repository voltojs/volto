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
  RiskTier,
} from "@volto/core";
import type { Tool } from "@volto/tools-common";
import { CAP_LSP_QUERY } from "@volto/tools-code";
import { CAP_DB_READ, CAP_DB_WRITE } from "@volto/tools-data";
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
    // The loss is data the caller can surface — never a silent edit of what
    // the definition file says.
    expect(assembled.droppedTools).toEqual(["curl"]);
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
    expect(assembled.droppedCapabilities).toEqual(["shell:exec"]);
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
    const events: Array<{ type: string; data: Record<string, unknown>; time?: number }> = [];
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
    // Envelope stamp: the gateway's frame() drops events without a top-level
    // numeric `time` (sessions.ts asTranscriptEvent).
    expect(typeof downgrade!.time).toBe("number");
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
    // subagent_type is an enum built from the offered types, so a drifting
    // value is rejected at validation — never dispatched — and the error
    // names the allowed set so the model can self-correct.
    expect(firstText).toContain("subagent_type");
    expect(firstText).toContain("general-purpose");
    expect(firstText).toContain("searcher");
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

// ──────────────────────────────────────────────
// F-149 / F-148: inheritance pinning + model orthogonality (T2 Task 3)
// ──────────────────────────────────────────────

/** A tool gated on one capability; visibility in a ModelRequest proves the holder has it. */
function gatedTool(name: string, capability: string, riskTier: RiskTier = "READ_ONLY"): Tool {
  return createNamedTool({
    name,
    description: `${name} (requires ${capability})`,
    inputSchema: { type: "object" },
    requires: [capability],
    riskTier,
  });
}

/**
 * The observable shape of a request's capability gating and ceiling: tool
 * names plus the requires/riskTier each visible tool was admitted under.
 * ModelRequest carries no capabilities field (F-149 controller decision), so
 * "the available capability set" is pinned through this gated visibility.
 */
function gatingShape(req: ModelRequest): Array<{ name: string; requires: string[]; riskTier: string }> {
  return req.tools.map((t) => ({
    name: t.name,
    requires: [...t.requires],
    riskTier: t.riskTier,
  }));
}

describe("F-149 inheritance pinning — omitted means the parent's full set", () => {
  // maxAgentDepth 1: the delegation budget is withdrawn at the cap (the
  // documented exception to capability inheritance), so the general-purpose
  // child's visible set is exactly the parent's custom tools minus the
  // stripped task/task_output instances — the literal shape F-149 pins.
  // (The freshly bound nested task a below-cap child receives instead is
  // pinned in subagent-nesting.test.ts.)
  it("F-149 a general-purpose child inherits the parent's full tool and capability set", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "inspect" })),
      textScript("child done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [
        gatedTool("lsp_definition", CAP_LSP_QUERY),
        gatedTool("db_query", CAP_DB_READ),
        gatedTool("db_exec", CAP_DB_WRITE),
        // Control: the parent owns this tool but never held its capability,
        // so it is invisible to the parent AND the child — proves the requires
        // gate is genuinely applied, not that every tool passes through.
        gatedTool("vault_read", "vault:read"),
      ],
      capabilities: new Set([CAP_LSP_QUERY, CAP_DB_READ, CAP_DB_WRITE]),
      enableTaskTool: true,
      maxAgentDepth: 1,
    });
    await agent.run("inspect the code");

    // Request 0 = parent dispatch, request 1 = sub-agent.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const child = requests[1]!;
    const names = child.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["lsp_definition", "db_query", "db_exec"]),
    );
    // Verbatim capability strings: the three tools are visible only because
    // ToolRouter admitted them on requires ["lsp:query"/"db:read"/"db:write"]
    // — i.e. the child holds exactly these capabilities (the strings ride
    // the real ModelRequest the child's model receives).
    expect(child.tools.find((t) => t.name === "lsp_definition")!.requires).toEqual(["lsp:query"]);
    expect(child.tools.find((t) => t.name === "db_query")!.requires).toEqual(["db:read"]);
    expect(child.tools.find((t) => t.name === "db_exec")!.requires).toEqual(["db:write"]);
    // Gating is real in both directions: the ungranted capability stays hidden.
    expect(names).not.toContain("vault_read");
    // The parent's task / task_output instances never reach the child.
    expect(names).not.toContain("task");
    expect(names).not.toContain("task_output");
  });

  it("F-149 a typed definition omitting tools and capabilities inherits the same full set", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "inspect", subagent_type: "omitter" }),
      ),
      textScript("child done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [
        gatedTool("lsp_definition", CAP_LSP_QUERY),
        gatedTool("db_query", CAP_DB_READ),
        gatedTool("db_exec", CAP_DB_WRITE),
        gatedTool("vault_read", "vault:read"),
      ],
      capabilities: new Set([CAP_LSP_QUERY, CAP_DB_READ, CAP_DB_WRITE]),
      enableTaskTool: true,
      maxAgentDepth: 1,
      agentSpecs: [agentEntry({ name: "omitter", systemPrompt: "You are a generalist." })],
    });
    await agent.run("inspect the code");

    expect(requests.length).toBeGreaterThanOrEqual(2);
    const child = requests[1]!;
    const names = child.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["lsp_definition", "db_query", "db_exec"]),
    );
    expect(child.tools.find((t) => t.name === "lsp_definition")!.requires).toEqual(["lsp:query"]);
    expect(child.tools.find((t) => t.name === "db_query")!.requires).toEqual(["db:read"]);
    expect(child.tools.find((t) => t.name === "db_exec")!.requires).toEqual(["db:write"]);
    expect(names).not.toContain("vault_read");
    expect(names).not.toContain("task");
    expect(names).not.toContain("task_output");
  });

  it("F-149 a typed definition listing tools gets only the intersection", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "query only", subagent_type: "narrow" }),
      ),
      textScript("child done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [
        gatedTool("lsp_definition", CAP_LSP_QUERY),
        gatedTool("db_query", CAP_DB_READ),
        gatedTool("db_exec", CAP_DB_WRITE),
      ],
      capabilities: new Set([CAP_LSP_QUERY, CAP_DB_READ, CAP_DB_WRITE]),
      enableTaskTool: true,
      // "curl" is not among the parent's tools: declaring it must neither
      // conjure it nor raise — the run completes and the child sees the
      // intersection only.
      agentSpecs: [agentEntry({ name: "narrow", tools: ["db_query", "curl"] })],
    });
    await agent.run("query the database");

    // The dispatch really happened (child request captured) with exactly
    // the intersection — no error text, no conjured tool.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]!.tools.map((t) => t.name)).toEqual(["db_query"]);
  });
});

describe("F-148 model is an orthogonal axis (regression through the new dispatch path)", () => {
  it("F-148 a model override changes nothing but the model", async () => {
    // Same script twice: once plain, once with a per-dispatch model. The
    // tool/capability/ceiling axes must be item-for-item identical; only the
    // model field may differ. db_migrate (IRREVERSIBLE) is pruned by the
    // workspace-write ceiling in BOTH children, so the ceiling comparison is
    // non-vacuous rather than "both lists happen to be equal".
    const tools = () => [
      gatedTool("lsp_definition", CAP_LSP_QUERY),
      gatedTool("db_query", CAP_DB_READ),
      gatedTool("db_exec", CAP_DB_WRITE, "WRITE_LOW"),
      gatedTool("db_migrate", CAP_DB_WRITE, "IRREVERSIBLE"),
    ];
    const capabilities = () => new Set([CAP_LSP_QUERY, CAP_DB_READ, CAP_DB_WRITE]);

    const dispatchChild = async (taskInput: Record<string, unknown>): Promise<ModelRequest> => {
      const { port, requests } = recordingModelPort([
        toolCallScript("c1", "task", JSON.stringify({ message: "work", ...taskInput })),
        textScript("child done"),
        textScript("parent done"),
      ]);
      const agent = createAgent({
        modelPort: port,
        model: "parent-model",
        tools: tools(),
        capabilities: capabilities(),
        permissionConfig: { sandbox: "workspace-write", approval: "never" },
        enableTaskTool: true,
      });
      await agent.run("do the work");
      expect(requests.length).toBeGreaterThanOrEqual(2);
      return requests[1]!;
    };

    const plain = await dispatchChild({});
    const overridden = await dispatchChild({ model: "X" });

    // The only difference on the whole child request is the model.
    expect(plain.model).toBe("parent-model");
    expect(overridden.model).toBe("X");
    // Tools, requires and risk tiers — item-for-item equal across dispatches.
    expect(gatingShape(overridden)).toEqual(gatingShape(plain));
    // Capability-gated visibility identical: the gated tools are visible in
    // both children…
    const names = overridden.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["lsp_definition", "db_query", "db_exec"]),
    );
    // …and the ceiling derived from the (identical) permissionConfig prunes
    // the IRREVERSIBLE tool from both.
    expect(names).not.toContain("db_migrate");
    expect(plain.tools.map((t) => t.name)).not.toContain("db_migrate");
  });

  it("F-148 a definition requesting a wider policy still downgrades through the new dispatch path", async () => {
    // Config note: the F-008 wording pairs the wider request with a
    // read-only parent, but a read-only PARENT cannot dispatch at all — task
    // is WRITE_LOW and the read-only ceiling prunes it from the parent's
    // visible set (fail-closed; documented in plan-visibility.test.ts and in
    // the runtime-refusal test above). The enforceable equivalent keeps the
    // parent at workspace-write and pins the same invariant through the new
    // dispatch path: the wider request lands in the downgrade event AND the
    // effective (stricter) policy's ceiling prunes the above-ceiling tool
    // from the child's real ModelRequest.
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const sink: EventSink = {
      emit(event) {
        events.push(event);
      },
    };

    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go", subagent_type: "risky" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [
        gatedTool("db_query", CAP_DB_READ),
        gatedTool("db_exec", CAP_DB_WRITE, "WRITE_LOW"),
        // Visible only under danger-full-access; the downgraded child must
        // never see it — if the policy took the requested value, it would.
        gatedTool("db_migrate", CAP_DB_WRITE, "IRREVERSIBLE"),
      ],
      capabilities: new Set([CAP_DB_READ, CAP_DB_WRITE]),
      permissionConfig: { sandbox: "workspace-write", approval: "never" },
      enableTaskTool: true,
      eventSink: sink,
      agentSpecs: [agentEntry({ name: "risky", policy: { sandbox: "danger-full-access", approval: "never" } })],
    });
    await agent.run("do the risky thing");

    // The wider request is reported, not silently granted.
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

    // Ceiling assertion on the child's real request (same shape as
    // plan-visibility.test.ts): read/write-under-ceiling tools visible,
    // the above-ceiling IRREVERSIBLE tool pruned.
    const childNames = requests[1]!.tools.map((t) => t.name);
    expect(childNames).toContain("db_query");
    expect(childNames).not.toContain("db_migrate");
  });
});


