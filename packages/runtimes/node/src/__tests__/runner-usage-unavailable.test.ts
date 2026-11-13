/**
 * usage_unavailable wiring — verify the Runner forwards the provider's
 * "requested usage but never got one" signal to the EventSink exactly once,
 * and that a normal stream (with usage) produces no such emission.
 *
 * This is observability-only: see packages/core/src/ports.ts
 * (ModelEventUsageUnavailable) and packages/providers/openai/src/stream-normalize.ts
 * for where the provider emits it.
 */

import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import { createMockModelPort, textDelta, usage, modelDone } from "@voltojs/core";
import type { StepContext, ToolDefinition, EventSink } from "@voltojs/core";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [readTool], model: "test-model" };
const capabilities = new Set(["filesystem:read"]);

function collectingSink(): { sink: EventSink; events: Array<{ type: string; data: Record<string, unknown> }> } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    sink: { emit: (event) => events.push(event as { type: string; data: Record<string, unknown> }) },
    events,
  };
}

describe("Runner usage_unavailable wiring", () => {
  it("emits exactly one usage_unavailable EventSink event when the stream ends without usage", async () => {
    const mockModel = createMockModelPort([
      [textDelta("Hi"), { type: "usage_unavailable" }, modelDone("end_turn")],
    ]);
    const { sink, events } = collectingSink();

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      availableCapabilities: capabilities,
      eventSink: sink,
    });

    await runner.run({ type: "user_message", content: "Hi" });

    const unavailableEvents = events.filter((e) => e.type === "usage_unavailable");
    expect(unavailableEvents).toHaveLength(1);
    expect(unavailableEvents[0]?.data).toMatchObject({ model: "test-model" });
  });

  it("emits no usage_unavailable event when the stream reports usage", async () => {
    const mockModel = createMockModelPort([
      [textDelta("Hi"), usage(10, 5), modelDone("end_turn")],
    ]);
    const { sink, events } = collectingSink();

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      availableCapabilities: capabilities,
      eventSink: sink,
    });

    await runner.run({ type: "user_message", content: "Hi" });

    expect(events.filter((e) => e.type === "usage_unavailable")).toHaveLength(0);
  });
});
