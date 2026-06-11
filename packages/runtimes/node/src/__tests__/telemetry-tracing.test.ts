import { describe, it, expect } from "vitest";
import type { ToolDefinition, StepContext } from "@agent-core/core";
import {
  createMockModelPort,
  toolUseStart,
  toolUseDelta,
  modelDone,
  textDelta,
} from "@agent-core/core";
import { createRunner } from "../runner.js";
import { InMemoryTelemetry } from "../telemetry.js";

const stubToolDef: ToolDefinition = {
  name: "stub_tool",
  description: "A stub tool for testing",
  inputSchema: { type: "object", properties: { input: { type: "string" } } },
  requires: ["stub"],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [stubToolDef], model: "test" };
const caps = new Set(["stub"]);

function stubToolExecutor() {
  return async () => ({
    modelContent: "stub result",
    displayMetadata: { stub: true },
  });
}

describe("InMemoryTelemetry", () => {
  it("records span attributes and end", () => {
    const telemetry = new InMemoryTelemetry();
    const span = telemetry.startSpan("foo", { a: 1 });
    span.setAttribute("b", 2);
    span.end();

    expect(telemetry.spans).toHaveLength(1);
    const recorded = telemetry.spans[0]!;
    expect(recorded.name).toBe("foo");
    expect(recorded.attributes).toEqual({ a: 1, b: 2 });
    expect(recorded.endedAt).toBeGreaterThan(0);
  });

  it("records metrics", () => {
    const telemetry = new InMemoryTelemetry();
    telemetry.metric("latency", 42, { turn: 1 });
    expect(telemetry.metrics).toHaveLength(1);
    expect(telemetry.metrics[0]).toEqual({ name: "latency", value: 42, attributes: { turn: 1 } });
  });

  it("tracks active span count", () => {
    const telemetry = new InMemoryTelemetry();
    expect(telemetry.activeSpanCount).toBe(0);
    const span = telemetry.startSpan("a");
    expect(telemetry.activeSpanCount).toBe(1);
    span.end();
    expect(telemetry.activeSpanCount).toBe(0);
  });
});

describe("Runner telemetry spans", () => {
  it("produces a turn span for a simple text-only run", async () => {
    const telemetry = new InMemoryTelemetry();
    const model = createMockModelPort([
      [textDelta("Hello"), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      telemetry,
    });

    const final = await runner.run({ type: "user_message", content: "hi" });
    expect(final.status).toBe("done");

    const spanNames = telemetry.spans.map((s) => s.name);
    expect(spanNames).toContain("turn");
    expect(spanNames).toContain("model_call");
  });

  it("produces turn + model_call + tool_execute spans when tool is called", async () => {
    const telemetry = new InMemoryTelemetry();
    const model = createMockModelPort([
      [toolUseStart("t1", "stub_tool"), toolUseDelta("t1", '{"input":"hello"}'), modelDone("tool_use")],
      [textDelta("Done"), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: stubToolExecutor(),
      telemetry,
    });

    const final = await runner.run({ type: "user_message", content: "use stub" });
    expect(final.status).toBe("done");

    const spanNames = telemetry.spans.map((s) => s.name);
    expect(spanNames).toContain("turn");
    expect(spanNames).toContain("model_call");
    expect(spanNames).toContain("tool_execute");

    const toolSpan = telemetry.spans.find((s) => s.name === "tool_execute");
    expect(toolSpan?.attributes["toolName"]).toBe("stub_tool");
  });

  it("marks tool_execute span with error=true when executor throws", async () => {
    const telemetry = new InMemoryTelemetry();
    const model = createMockModelPort([
      [toolUseStart("t1", "stub_tool"), toolUseDelta("t1", '{"input":"hello"}'), modelDone("tool_use")],
      [textDelta("Retry"), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: async () => { throw new Error("executor crashed"); },
      telemetry,
    });

    const final = await runner.run({ type: "user_message", content: "use stub" });
    expect(final.status).toBe("done");

    const toolSpan = telemetry.spans.find((s) => s.name === "tool_execute");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.attributes["error"]).toBe(true);
  });

  it("marks model_call span with error=true on model stream failure", async () => {
    const telemetry = new InMemoryTelemetry();
    const errorModel = {
      stream: () => { throw new Error("model unavailable"); },
    };

    const runner = createRunner({
      modelPort: errorModel as never,
      stepContext: ctx,
      availableCapabilities: caps,
      telemetry,
    });

    const final = await runner.run({ type: "user_message", content: "hi" });
    expect(final.status).toBe("done");

    const modelSpan = telemetry.spans.find((s) => s.name === "model_call");
    expect(modelSpan).toBeDefined();
    expect(modelSpan?.attributes["error"]).toBe(true);
  });

  it("runner works identically when telemetry is not injected", async () => {
    const model = createMockModelPort([
      [textDelta("OK"), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
    });

    const final = await runner.run({ type: "user_message", content: "hi" });
    expect(final.status).toBe("done");
    expect(final.messages.length).toBeGreaterThan(0);
  });

  it("model_call span records model name attribute", async () => {
    const telemetry = new InMemoryTelemetry();
    const model = createMockModelPort([
      [textDelta("OK"), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      telemetry,
    });

    await runner.run({ type: "user_message", content: "hi" });

    const modelSpan = telemetry.spans.find((s) => s.name === "model_call");
    expect(modelSpan).toBeDefined();
    expect(modelSpan?.attributes["model"]).toBe("test");
  });

  it("tool_execute span includes riskTier attribute", async () => {
    const telemetry = new InMemoryTelemetry();
    const model = createMockModelPort([
      [toolUseStart("t1", "stub_tool"), toolUseDelta("t1", '{"input":"x"}'), modelDone("tool_use")],
      [textDelta("Done"), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: stubToolExecutor(),
      telemetry,
    });

    await runner.run({ type: "user_message", content: "go" });

    const toolSpan = telemetry.spans.find((s) => s.name === "tool_execute");
    expect(toolSpan?.attributes["riskTier"]).toBe("READ_ONLY");
  });
});
