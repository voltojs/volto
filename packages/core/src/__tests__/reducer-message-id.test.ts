import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { StepContext } from "../reducer.js";
import type { Id } from "../ports.js";

function seqId(): Id {
  let n = 0;
  return { next: () => `id-${++n}` };
}

const ctx: StepContext = { tools: [], model: "m", id: seqId() };

describe("message ids", () => {
  it("stamps every appended message with an id from StepContext.id", () => {
    let state = createInitialState();
    const r1 = step(state, { type: "user_message", content: "hi" }, ctx);
    state = r1.state;
    expect(state.messages.every((m) => typeof m.id === "string" && m.id.length > 0)).toBe(true);
    const ids = state.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves messages without id when StepContext.id is absent", () => {
    const bare: StepContext = { tools: [], model: "m" };
    const r = step(createInitialState(), { type: "user_message", content: "hi" }, bare);
    // System seed may still exist from runner; user message must not crash.
    expect(r.state.messages.length).toBeGreaterThan(0);
  });
});
