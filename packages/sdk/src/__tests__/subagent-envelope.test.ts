import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
  toolUseStart,
  toolUseDelta,
  modelDone,
  usage,
} from "@volto/core";
import type { ModelPort, ModelRequest, ModelEvent } from "@volto/core";
import type { AgentSpec } from "../agent-spec.js";
import type { AgentEntry } from "../agent-registry/scan.js";

// ──────────────────────────────────────────────
// Helpers (the reference pattern is
// apps/headless-server/src/__tests__/lsp-db-session.test.ts:76 —
// captureModelPort is not exported from @volto/core, so each test file
// defines its own.)
// ──────────────────────────────────────────────

/** Wrap a scripted mock port so every ModelRequest the runner makes is captured. */
function captureModelPort(scripts: ModelEvent[][]): {
  port: ModelPort;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(scripts);
  return {
    requests,
    port: {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

/**
 * Content-routed capture port: the sub-agent's request carries its dispatch
 * message as the latest user message, the parent's never does. Routing on
 * content (not call order) keeps the test deterministic while a detached
 * background sub-agent's model call races the parent's next one.
 */
function routedCapturePort(opts: {
  subMessage: string;
  subScript: ModelEvent[];
  mainScripts: Array<(req: ModelRequest) => ModelEvent[]>;
}): { port: ModelPort; requests: ModelRequest[]; subRequests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const subRequests: ModelRequest[] = [];
  let mainIndex = 0;
  return {
    requests,
    subRequests,
    port: {
      async *stream(req) {
        requests.push(req);
        const users = req.messages.filter((m) => m.role === "user");
        const lastUser = users[users.length - 1];
        const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : "";
        if (lastUserText === opts.subMessage) {
          subRequests.push(req);
          yield* opts.subScript;
          return;
        }
        const step = opts.mainScripts[mainIndex];
        mainIndex++;
        if (!step) throw new Error(`no main script for call ${mainIndex - 1}`);
        yield* step(req);
      },
    },
  };
}

function agentEntry(spec: AgentSpec): AgentEntry {
  return { id: `plugin:${spec.name}`, scope: "plugin", spec, shadowed: false };
}

/**
 * The last JSON envelope block any captured request shows the model: the
 * task / task_output tool_result's second text block. Returns the parsed
 * `{ childSessionId?, status, usage? }` object.
 */
function envelopeFrom(requests: ModelRequest[]): Record<string, unknown> {
  for (let i = requests.length - 1; i >= 0; i--) {
    for (const m of requests[i]!.messages) {
      if (m.role !== "tool" || typeof m.content === "string") continue;
      for (const block of m.content) {
        if (block.type !== "tool_result") continue;
        const blocks = Array.isArray(block.content)
          ? block.content
          : [{ type: "text" as const, text: String(block.content) }];
        if (blocks.length < 2) continue;
        const last = blocks[blocks.length - 1];
        if (last?.type !== "text") continue;
        try {
          const parsed = JSON.parse(last.text) as Record<string, unknown>;
          if (parsed["status"] === "completed") return parsed;
        } catch {
          // Body block, not the envelope.
        }
      }
    }
  }
  throw new Error("no envelope block found in any captured request");
}

/** Extracts the task id the task tool embedded in its tool_result. */
function extractTaskId(req: ModelRequest): string {
  for (const m of req.messages) {
    if (m.role !== "tool" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_result") continue;
      const blocks = Array.isArray(block.content)
        ? block.content
        : [{ type: "text" as const, text: String(block.content) }];
      const text = blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const match = /task_id="([^"]+)"/.exec(text);
      if (match?.[1]) return match[1];
    }
  }
  throw new Error("no task_id in request messages");
}

// ──────────────────────────────────────────────
// F-146: per-dispatch model resolution chain
// task input model → spec model → parent model
// ──────────────────────────────────────────────

describe("F-146 sub-agent model resolution", () => {
  it("F-146 the task input model outranks the agent spec model", async () => {
    const { port, requests } = captureModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "work", subagent_type: "cheap", model: "task-model" }),
      ),
      textScript("child done"),
      textScript("all done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      agentSpecs: [agentEntry({ name: "cheap", model: "spec-model" })],
    });
    await agent.run("dispatch the cheap agent");

    // Request 0 = parent turn 1, request 1 = sub-agent.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]!.model).toBe("task-model");
  });

  it("F-146 without a task input model the spec model wins", async () => {
    const { port, requests } = captureModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "work", subagent_type: "cheap" }),
      ),
      textScript("child done"),
      textScript("all done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      agentSpecs: [agentEntry({ name: "cheap", model: "spec-model" })],
    });
    await agent.run("dispatch the cheap agent");

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]!.model).toBe("spec-model");
  });

  it("F-146 with neither, the child inherits the parent model", async () => {
    const { port, requests } = captureModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "work", subagent_type: "general" })),
      textScript("child done"),
      textScript("all done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      agentSpecs: [agentEntry({ name: "general" })],
    });
    await agent.run("dispatch the general agent");

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]!.model).toBe("parent-model");
    expect(requests[1]!.model).toBe(requests[0]!.model);
  });

  it("F-146 a background dispatch carries the model override too", async () => {
    const SUB_MSG = "background research";
    const { port, subRequests } = routedCapturePort({
      subMessage: SUB_MSG,
      subScript: textScript("bg child done"),
      mainScripts: [
        () =>
          toolCallScript(
            "c1",
            "task",
            JSON.stringify({ message: SUB_MSG, run_in_background: true, model: "bg-model" }),
          ),
        () => textScript("dispatched."),
        // The turn-boundary drain feeds the uncollected completion, which
        // reopens the turn for one final call.
        () => textScript("folded in."),
      ],
    });

    const agent = createAgent({ modelPort: port, enableTaskTool: true });
    await agent.run("start a background task");

    expect(subRequests.length).toBe(1);
    expect(subRequests[0]!.model).toBe("bg-model");
  });
});

// ──────────────────────────────────────────────
// F-147: usage accumulation across the whole child run
// ──────────────────────────────────────────────

const echoToolDef = {
  name: "echo",
  description: "Echo back the input",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  requires: ["test:echo"],
  riskTier: "READ_ONLY" as const,
};

describe("F-147 sub-agent usage envelope", () => {
  it("F-147 sums usage across every model call of the child run", async () => {
    const { port, requests } = captureModelPort([
      // Parent: dispatch a general-purpose task.
      toolCallScript("c1", "task", JSON.stringify({ message: "count tokens" })),
      // Child call 1: usage then a tool_use.
      [
        toolUseStart("s1", "echo"),
        toolUseDelta("s1", JSON.stringify({ message: "ping" })),
        usage(100, 10),
        modelDone("tool_use"),
      ],
      // Child call 2: usage then the final text.
      textScript("child final", 50, 20),
      // Parent: folds the result in.
      textScript("summarized."),
    ]);

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      tools: [
        {
          definition: echoToolDef,
          handler: async (input: Record<string, unknown>) => ({
            modelContent: `echo: ${String(input["message"])}`,
          }),
        },
      ],
      capabilities: new Set(["test:echo"]),
    });
    await agent.run("run the task and count its tokens");

    // Sum, not the last call: 100+50 input, 10+20 output. No cache buckets
    // were reported, so the envelope must omit those keys entirely.
    expect(envelopeFrom(requests)).toEqual({
      status: "completed",
      usage: { inputTokens: 150, outputTokens: 30 },
    });
  });
});

// ──────────────────────────────────────────────
// F-145: the registry stores the full outcome;
// task_output recovers childSessionId and usage
// ──────────────────────────────────────────────

describe("F-145 background outcome recovery", () => {
  it("F-145 a background task recovers childSessionId and usage through task_output", async () => {
    const SUB_MSG = "long-running scan";
    let collectedTaskId = "";
    const { port, requests } = routedCapturePort({
      subMessage: SUB_MSG,
      subScript: textScript("scan result", 7, 3),
      mainScripts: [
        () =>
          toolCallScript(
            "c1",
            "task",
            JSON.stringify({ message: SUB_MSG, run_in_background: true }),
          ),
        (req) => {
          collectedTaskId = extractTaskId(req);
          return toolCallScript("c2", "task_output", JSON.stringify({ task_id: collectedTaskId }));
        },
        () => textScript("collected."),
      ],
    });

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      chatSessionId: "sess",
    });
    await agent.run("background scan then collect");

    const envelope = envelopeFrom(requests);
    expect(envelope["childSessionId"]).toMatch(/-sub-/);
    expect(envelope["status"]).toBe("completed");
    expect(envelope["usage"]).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("F-145 an unknown background task id still errors as plain text", async () => {
    const { port } = routedCapturePort({
      subMessage: "never dispatched",
      subScript: textScript("unused"),
      mainScripts: [
        () => toolCallScript("c1", "task_output", JSON.stringify({ task_id: "nope" })),
        () => textScript("Acknowledged."),
      ],
    });

    const agent = createAgent({ modelPort: port, enableTaskTool: true });
    const state = await agent.run("collect a task that does not exist");

    // State normalizes tool results to block arrays: a single plain-text
    // block with the exact message, never an envelope.
    const result = state.messages.find((m) => m.role === "tool")!.content[0]!;
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "unknown task: nope" }]);
  });
});
