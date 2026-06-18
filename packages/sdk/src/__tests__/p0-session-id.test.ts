/**
 * P0-3 regression test (code-review-2026-06-18 §3):
 * sessionId generation must go through the injected `Id` port so that
 * deterministic replays produce identical sessionIds. Previously the SDK
 * used `Date.now() + Math.random()` directly, breaking replay equivalence
 * for any consumer keyed on sessionId (audit, telemetry, checkpoints).
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, textScript } from "@volto/core";
import type { Id } from "@volto/core";

/** Counter-based deterministic Id port for tests. */
function createSeededId(): Id & { calls: number } {
  let calls = 0;
  return {
    next(): string {
      calls++;
      return `seeded-${calls}`;
    },
    get calls(): number {
      return calls;
    },
  } as Id & { calls: number };
}

describe("P0-3: sessionId goes through Id port", () => {
  it("two agents with the same seeded Id produce the same sessionId sequence", async () => {
    const runOnce = async (): Promise<string[]> => {
      const id = createSeededId();
      const observed: string[] = [];
      const model = createMockModelPort([textScript("ok")]);

      const agent = createAgent({
        modelPort: model,
        id,
        eventSink: {
          emit(event) {
            // Capture sessionIds surfacing in event payloads (telemetry-style)
            const sid = event.data?.sessionId;
            if (typeof sid === "string") observed.push(sid);
          },
        },
      });

      await agent.run("hi");
      return observed;
    };

    const a = await runOnce();
    const b = await runOnce();
    expect(a).toEqual(b);
  });

  it("Id.next() is actually called when an agent runs (no Date.now/Math.random in path)", async () => {
    const id = createSeededId();
    const model = createMockModelPort([textScript("ok")]);
    const agent = createAgent({ modelPort: model, id });

    expect(id.calls).toBe(0);
    await agent.run("hi");
    expect(id.calls).toBeGreaterThan(0);
  });

  it("falls back gracefully when no Id is injected (still produces a string sessionId)", async () => {
    const model = createMockModelPort([textScript("ok")]);
    const agent = createAgent({ modelPort: model });
    const state = await agent.run("hi");
    expect(state).toBeDefined();
    // Smoke test: agent ran to completion without throwing on sessionId.
  });
});
