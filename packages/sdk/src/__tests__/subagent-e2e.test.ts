import { describe, it, expect } from "vitest";
import { createAgent } from "../index.js";
import type { ModelPort, ModelRequest } from "@volto/core";
import {
  toolUseStart,
  toolUseDelta,
  modelDone,
  textScript,
} from "@volto/core";

describe("sub-agent end to end", () => {
  it("exposes configured definitions in the task tool description", () => {
    const agent = createAgent({
      modelPort: {} as ModelPort,
      enableTaskTool: true,
      agentSpecs: [
        {
          id: "user:searcher",
          scope: "user",
          shadowed: false,
          spec: { name: "searcher", description: "finds things" },
        },
        // Shadowed: must not appear in the model-facing list — offering a
        // name whose behaviour comes from a different file would be worse
        // than not offering it.
        {
          id: "plugin:searcher",
          scope: "plugin",
          shadowed: true,
          spec: { name: "searcher", description: "stale duplicate" },
        },
      ],
    });
    const task = agent.tools?.find((t) => t.definition.name === "task");
    expect(task?.definition.description).toContain("searcher");
    expect(task?.definition.description).toContain("finds things");
    expect(task?.definition.description).not.toContain("stale duplicate");
  });

  it("runs two task calls concurrently", async () => {
    // Regression guard: released tools already execute through
    // Promise.allSettled, and this must not silently become sequential.
    // Each sub-agent records its model-call start time and sleeps; overlapping
    // start times prove concurrency (sequential execution would stagger them
    // by the full sleep duration).
    const SUB_SLEEP_MS = 60;
    const started: number[] = [];
    let parentTurn = 0;
    const modelPort: ModelPort = {
      async *stream(req: ModelRequest) {
        const users = req.messages.filter((m) => m.role === "user");
        const lastUser = users[users.length - 1];
        const lastUserText =
          typeof lastUser?.content === "string" ? lastUser.content : "";
        if (lastUserText === "a" || lastUserText === "b") {
          // Sub-agent dispatch: record start, hold the turn open so a
          // sequential runner would stagger the sibling by ≥ SUB_SLEEP_MS.
          started.push(Date.now());
          await new Promise((r) => setTimeout(r, SUB_SLEEP_MS));
          yield* textScript(`sub ${lastUserText} done`);
          return;
        }
        if (parentTurn++ === 0) {
          // Both tool calls in ONE assistant message (one stream, single
          // done) so the runner executes them as a parallel batch.
          yield toolUseStart("c1", "task");
          yield toolUseDelta("c1", JSON.stringify({ message: "a" }));
          yield toolUseStart("c2", "task");
          yield toolUseDelta("c2", JSON.stringify({ message: "b" }));
          yield modelDone("tool_use");
        } else {
          yield* textScript("both done");
        }
      },
    } as ModelPort;

    const agent = createAgent({ modelPort, enableTaskTool: true });
    const state = await agent.run("do both");

    expect(state.status).toBe("done");
    // Both dispatches reached the model (neither silently dropped).
    expect(started.length).toBe(2);
    // Overlapping starts prove concurrency: sequential execution would
    // stagger them by at least SUB_SLEEP_MS (60ms).
    expect(Math.abs((started[1] ?? 0) - (started[0] ?? 0))).toBeLessThan(50);
  });
});
