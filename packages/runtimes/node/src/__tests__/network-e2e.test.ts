import { describe, it, expect } from "vitest";
import type { Network, StepContext, ToolDefinition } from "@agent-core/core";
import { createMockModelPort, toolUseStart, toolUseDelta, modelDone, textDelta, UNTRUSTED_PREFIX } from "@agent-core/core";
import { createWebFetchTool, CAP_NETWORK_FETCH } from "@agent-core/tools-web";
import { createRunner } from "../runner.js";
import { createNetworkToolExecutor } from "../network-tool-executor.js";

function stubNetwork(responseBody: string, status = 200): Network {
  return {
    async fetch() {
      return { status, headers: { "content-type": "text/plain" }, body: responseBody };
    },
  };
}

const webToolDefs: ToolDefinition[] = [
  createWebFetchTool(stubNetwork("page content")).definition,
];
const ctx: StepContext = { tools: webToolDefs, model: "test" };
const caps = new Set([CAP_NETWORK_FETCH]);

describe("network end-to-end via Runner (executor + reducer loop)", () => {
  it("web_fetch dispatches through executor and body feeds back to model", async () => {
    const model = createMockModelPort([
      [toolUseStart("c1", "web_fetch"), toolUseDelta("c1", '{"url":"https://example.com"}'), modelDone("tool_use")],
      [textDelta("Done."), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createNetworkToolExecutor({ network: stubNetwork("page content") }),
    });

    const final = await runner.run({ type: "user_message", content: "fetch page" });
    expect(final.status).toBe("done");
    const toolMsg = final.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "c1",
      content: `${UNTRUSTED_PREFIX}page content`,
    });
  });

  it("web_fetch error returns isError ToolResult to model", async () => {
    const model = createMockModelPort([
      [toolUseStart("c1", "web_fetch"), toolUseDelta("c1", '{"url":"https://fail.com"}'), modelDone("tool_use")],
      [textDelta("Done."), modelDone("end_turn")],
    ]);

    const failingNetwork: Network = {
      async fetch() { throw new Error("Connection refused"); },
    };

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createNetworkToolExecutor({ network: failingNetwork }),
    });

    const final = await runner.run({ type: "user_message", content: "fetch fail" });
    expect(final.status).toBe("done");
    const toolMsg = final.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content[0]).toMatchObject({ isError: true });
  });
});
