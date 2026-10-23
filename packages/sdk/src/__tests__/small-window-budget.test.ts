import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type { ModelPort } from "@volto/core";

/** A minimal text model; the test is about construction, not model behavior. */
const modelPort: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "ok" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

describe("small-window compaction budget", () => {
  it("constructs a 32k-window agent with the default compaction config", async () => {
    const agent = createAgent({
      modelPort,
      contextWindow: 32_000,
      compaction: { recentKeepCount: 2 },
    });

    const state = await agent.run("hi");
    expect(state.status).toBe("done");
  });
});
