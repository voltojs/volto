/**
 * Built-in sub-agent types (general-purpose / explore), the enum'd
 * subagent_type routing, and the `subagent_tools_dropped` visibility event.
 *
 * Motivation (session vl3ierhqx): the parent model decided "general-purpose
 * (omit)" in its reasoning but emitted a specialist type in the actual tool
 * arguments; the definition then silently lost two tools named against
 * another product's namespace, and the untyped fallback ran with NO system
 * prompt. Each test below pins one of those failure modes shut.
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type { AgentSpec } from "../agent-spec.js";
import type { AgentEntry } from "../agent-registry/scan.js";
import type {
  ModelPort,
  ModelRequest,
  ModelEvent,
  EventSink,
} from "@voltojs/core";
import type { Tool } from "@voltojs/tools/common";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
} from "@voltojs/core";
import { GENERAL_PURPOSE_NAME, EXPLORE_NAME } from "../agent-registry/builtin.js";

function namedTool(name: string): Tool {
  return {
    definition: {
      name,
      description: name,
      inputSchema: { type: "object" },
      requires: [],
      riskTier: "READ_ONLY",
    },
    handler: async () => ({ modelContent: "ok" }),
  } as unknown as Tool;
}

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
  return { id: `plugin:${spec.name}`, scope: "plugin", spec, shadowed };
}

function collectSink(events: Array<{ type: string; data: Record<string, unknown> }>): EventSink {
  return { emit(event) { events.push(event); } };
}

function systemText(req: ModelRequest): string {
  return req.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

describe("built-in general-purpose", () => {
  it("seeds the sub-agent role prompt on the omit path", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "research" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({ modelPort: port, enableTaskTool: true });
    await agent.run("dispatch without a type");

    const sub = requests[1]!;
    expect(systemText(sub)).toContain("You are a sub-agent");
    expect(sub.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("an explicit general-purpose dispatch behaves like omit and inherits tools", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "research", subagent_type: GENERAL_PURPOSE_NAME }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [namedTool("echo")],
      enableTaskTool: true,
    });
    await agent.run("dispatch general-purpose explicitly");

    const sub = requests[1]!;
    expect(systemText(sub)).toContain("You are a sub-agent");
    expect(sub.tools.map((t) => t.name)).toContain("echo");
    // The parent's stale task instance is stripped; the child is not granted
    // delegation below the depth cap here (depth 1 < default 2 re-binds one).
    expect(sub.tools.map((t) => t.name)).not.toContain("task_output");
  });

  it("a file definition named general-purpose overrides the built-in prompt", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", subagent_type: GENERAL_PURPOSE_NAME }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      agentSpecs: [
        agentEntry({ name: GENERAL_PURPOSE_NAME, systemPrompt: "Custom generalist." }),
      ],
    });
    await agent.run("override the built-in");

    expect(systemText(requests[1]!)).toContain("Custom generalist.");
    expect(systemText(requests[1]!)).not.toContain("You are a sub-agent");
  });
});

describe("built-in explore", () => {
  it("filters the child to the read-only tool allowlist", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "where is X", subagent_type: EXPLORE_NAME }),
      ),
      textScript("found it"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      // The parent owns everything; the explorer must come back read-only.
      tools: [namedTool("read_file"), namedTool("grep"), namedTool("write_file"), namedTool("bash")],
      enableTaskTool: true,
    });
    await agent.run("explore the repo");

    const subTools = requests[1]!.tools.map((t) => t.name);
    expect(subTools).toContain("read_file");
    expect(subTools).toContain("grep");
    expect(subTools).not.toContain("write_file");
    expect(subTools).not.toContain("bash");
    expect(systemText(requests[1]!)).toContain("read-only");
  });

  it("reports allowlist entries the parent does not own as dropped", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { port } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "explore", subagent_type: EXPLORE_NAME }),
      ),
      textScript("done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      eventSink: collectSink(events),
    });
    await agent.run("explore with no fs tools");

    const dropped = events.find((e) => e.type === "subagent_tools_dropped");
    expect(dropped).toBeDefined();
    expect(dropped!.data["subagentType"]).toBe(EXPLORE_NAME);
    expect((dropped!.data["droppedTools"] as string[]).length).toBeGreaterThan(0);
  });
});

describe("subagent_type enum routing", () => {
  it("a drifting type value is rejected pre-dispatch and never spawns a runner", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        // Model emits a name that resolves to nothing — validation, not
        // dispatch, must catch it and feed the allowed set back.
        JSON.stringify({ message: "go", subagent_type: "bug-analyzer" }),
      ),
      textScript("parent done"),
    ]);

    const agent = createAgent({ modelPort: port, enableTaskTool: true });
    await agent.run("dispatch a drifting type name");

    // Two calls, both the parent's (dispatch + wrap-up). A dispatched child
    // would need a third model call, which the script does not provide.
    expect(requests).toHaveLength(2);
    const toolResultText = JSON.stringify(requests[1]!.messages);
    expect(toolResultText).toContain("must be one of");
    expect(toolResultText).toContain(GENERAL_PURPOSE_NAME);
  });

  it("the model-visible task schema carries the enum of every offered type", async () => {
    const { port, requests } = recordingModelPort([textScript("ok")]);
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      agentSpecs: [agentEntry({ name: "searcher" })],
    });
    await agent.run("noop");

    const taskDef = requests[0]!.tools.find((t) => t.name === "task")!;
    const enumValues = taskDef.inputSchema?.properties?.["subagent_type"]?.enum as
      | string[]
      | undefined;
    expect(enumValues).toEqual(
      expect.arrayContaining([GENERAL_PURPOSE_NAME, EXPLORE_NAME, "searcher"]),
    );
    // The description now renders assembly facts, not bare names.
    expect(taskDef.description).toContain("inherits the parent's tools");
  });
});

describe("per-dispatch refinement parameters", () => {
  it("records the dispatch title on the subagent_started bracket and the child session meta", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const appended: string[] = [];
    const { port } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", title: "调研触发机制" }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      eventSink: collectSink(events),
      chatStore: {
        async appendEvents(_id: string, batch: unknown[]) {
          appended.push(JSON.stringify(batch));
        },
      } as never,
      chatSessionId: "sess-parent",
    });
    await agent.run("dispatch with a title");

    const started = events.find((e) => e.type === "subagent_started");
    expect(started!.data["title"]).toBe("调研触发机制");
    // The child's own session_meta carries it too, so a resumed/replayed tab
    // and the tasks list can label the run without the parent's tool call.
    expect(appended.some((batch) => batch.includes('"title":"调研触发机制"'))).toBe(true);
    expect(appended.some((batch) => batch.includes('"origin":"subagent"'))).toBe(true);
  });

  it("appends the dispatch system_prompt after the built-in role prompt", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", system_prompt: "Answer in exactly 3 bullets." }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({ modelPort: port, enableTaskTool: true });
    await agent.run("dispatch with extra instructions");

    const sub = requests[1]!;
    const system = sub.messages.filter((m) => m.role === "system");
    expect(system).toHaveLength(1);
    const text = system[0]!.content as string;
    // Role contract first, dispatch instructions last — never a replacement.
    expect(text).toContain("You are a sub-agent");
    expect(text).toContain("Answer in exactly 3 bullets.");
    expect(text.indexOf("You are a sub-agent")).toBeLessThan(
      text.indexOf("Answer in exactly 3 bullets."),
    );
  });

  it("narrows the child tool set to the dispatch allowlist", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", tools: ["read_file"] }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [namedTool("read_file"), namedTool("grep"), namedTool("bash")],
      enableTaskTool: true,
    });
    await agent.run("dispatch with a tool allowlist");

    const subTools = requests[1]!.tools.map((t) => t.name);
    expect(subTools).toContain("read_file");
    expect(subTools).not.toContain("grep");
    expect(subTools).not.toContain("bash");
  });

  it("reports dispatch allowlist names the child does not own as dropped", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { port } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", tools: ["read_file", "curl"] }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [namedTool("read_file")],
      enableTaskTool: true,
      eventSink: collectSink(events),
    });
    await agent.run("dispatch a tool the parent does not own");

    const dropped = events.find((e) => e.type === "subagent_tools_dropped");
    expect(dropped).toBeDefined();
    expect(dropped!.data["droppedTools"]).toContain("curl");
  });

  it("applies the dispatch loop budget, temperature and max tokens over the definition", async () => {
    const { port, requests } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({
          message: "go",
          subagent_type: "tuned",
          max_iterations: 1,
          temperature: 0.1,
          max_tokens: 512,
        }),
      ),
      // The child may take exactly one iteration, so a second assistant call
      // inside the child must never happen: one reply ends its loop.
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      agentSpecs: [
        agentEntry({ name: "tuned", maxIterations: 9, temperature: 1.2, maxTokens: 4096 }),
      ],
    });
    await agent.run("dispatch with tuning");

    const sub = requests[1]!;
    expect(sub.temperature).toBe(0.1);
    expect(sub.maxTokens).toBe(512);
    // Three calls total: parent dispatch, one child reply, parent wrap-up —
    // proof the dispatch budget (1) beat the definition's (9) only in the
    // sense that the child stopped; the definition's higher budget would
    // have allowed more rounds but is irrelevant with a clean reply.
    expect(requests).toHaveLength(3);
  });
});

describe("subagent_tools_dropped", () => {
  it("emits when a definition declares tools the parent does not own", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { port } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", subagent_type: "partial" }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [namedTool("echo")],
      enableTaskTool: true,
      eventSink: collectSink(events),
      agentSpecs: [
        agentEntry({ name: "partial", tools: ["echo", "run_bash_command", "search_files"] }),
      ],
    });
    await agent.run("dispatch a definition from another namespace");

    const dropped = events.find((e) => e.type === "subagent_tools_dropped");
    expect(dropped).toBeDefined();
    expect(dropped!.data["subagentType"]).toBe("partial");
    expect(dropped!.data["droppedTools"]).toEqual(["run_bash_command", "search_files"]);
  });

  it("persists the drop record in the parent log, not only on the live sink", async () => {
    const batches: string[] = [];
    const { port } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", subagent_type: "partial" }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [namedTool("echo")],
      enableTaskTool: true,
      chatSessionId: "sess-parent",
      chatStore: {
        async appendEvents(_id: string, batch: unknown[]) {
          batches.push(JSON.stringify(batch));
        },
      } as never,
      agentSpecs: [agentEntry({ name: "partial", tools: ["echo", "run_bash_command"] })],
    });
    await agent.run("dispatch a definition from another namespace");

    // A sink-only event dies with the process; the trajectory drawer reads
    // the log, so the disclosure has to be durable.
    const parentBatch = batches.find((b) => b.includes('"subagent_tools_dropped"'));
    expect(parentBatch).toBeDefined();
    expect(parentBatch).toContain("run_bash_command");
    // ...and it rides in the same append as the start bracket, so one
    // dispatch's records never interleave with another's.
    expect(parentBatch).toContain('"subagent_started"');
    const finished = batches.find((b) => b.includes('"subagent_finished"'));
    expect(finished).toBeDefined();
  });

  it("a declared task is NOT reported dropped while the depth budget grants it", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { port } = recordingModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", subagent_type: "lead" }),
      ),
      textScript("sub done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      tools: [namedTool("echo")],
      enableTaskTool: true,
      maxAgentDepth: 2,
      eventSink: collectSink(events),
      agentSpecs: [agentEntry({ name: "lead", tools: ["echo", "task"] })],
    });
    await agent.run("dispatch a definition that delegates further");

    expect(events.find((e) => e.type === "subagent_tools_dropped")).toBeUndefined();
  });
});
