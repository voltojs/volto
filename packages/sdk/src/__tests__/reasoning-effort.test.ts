import { describe, it, expect } from "vitest";
import { createMockModelPort, modelDone, type ModelRequest } from "@volto/core";
import { createAgent } from "../create-agent.js";

describe("sdk forwards the reasoning effort", () => {
  it("puts the configured effort on the model request", async () => {
    const seen: ModelRequest[] = [];
    const mock = createMockModelPort([[modelDone("end_turn")]]);
    const port = {
      async *stream(req: ModelRequest) {
        seen.push(req);
        yield* mock.stream(req);
      },
    };

    const agent = createAgent({ modelPort: port, model: "thinker", reasoningEffort: "high" });
    await agent.run("hi");

    expect(seen[0]?.reasoningEffort).toBe("high");
  });

  it("leaves the request untouched when no effort is configured", async () => {
    const seen: ModelRequest[] = [];
    const mock = createMockModelPort([[modelDone("end_turn")]]);
    const port = {
      async *stream(req: ModelRequest) {
        seen.push(req);
        yield* mock.stream(req);
      },
    };

    const agent = createAgent({ modelPort: port, model: "plain" });
    await agent.run("hi");

    expect(seen[0]?.reasoningEffort).toBeUndefined();
  });
});
