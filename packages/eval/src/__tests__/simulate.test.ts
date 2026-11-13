import { describe, it, expect } from "vitest";
import {
  createSeededClock,
  createSeededId,
  createSeededRandom,
  createScriptedModelPort,
  createSimulation,
  simulateTrajectory,
} from "../simulate.js";
import { replayTrajectory } from "../replay.js";

describe("createSeededClock", () => {
  it("returns deterministic timestamps", () => {
    const clock = createSeededClock({ startMs: 1000, stepMs: 100 });
    expect(clock.now()).toBe(1000);
    expect(clock.now()).toBe(1100);
    expect(clock.now()).toBe(1200);
  });

  it("two clocks with same seed produce same sequence", () => {
    const c1 = createSeededClock({ startMs: 0, stepMs: 50 });
    const c2 = createSeededClock({ startMs: 0, stepMs: 50 });
    for (let i = 0; i < 10; i++) {
      expect(c1.now()).toBe(c2.now());
    }
  });
});

describe("createSeededId", () => {
  it("generates sequential IDs", () => {
    const id = createSeededId("test");
    expect(id.next()).toBe("test-0");
    expect(id.next()).toBe("test-1");
    expect(id.next()).toBe("test-2");
  });

  it("default prefix", () => {
    const id = createSeededId();
    expect(id.next()).toBe("eval-id-0");
  });
});

describe("createSeededRandom", () => {
  it("produces values between 0 and 1", () => {
    const rand = createSeededRandom(42);
    for (let i = 0; i < 100; i++) {
      const val = rand.next();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it("same seed produces same sequence", () => {
    const r1 = createSeededRandom(42);
    const r2 = createSeededRandom(42);
    for (let i = 0; i < 50; i++) {
      expect(r1.next()).toBe(r2.next());
    }
  });
});

describe("createScriptedModelPort", () => {
  it("replays scripted events", async () => {
    const port = createScriptedModelPort([
      [{ type: "text_delta", text: "Hello" }, { type: "done", stopReason: "end_turn" }],
    ]);

    const events: string[] = [];
    for await (const event of port.stream({ messages: [], tools: [] })) {
      events.push(`${event.type}`);
    }

    expect(events).toEqual(["text_delta", "done"]);
  });

  it("yields done when no more batches", async () => {
    const port = createScriptedModelPort([]);
    const events: string[] = [];
    for await (const event of port.stream({ messages: [], tools: [] })) {
      events.push(`${event.type}`);
    }
    expect(events).toEqual(["done"]);
  });

  it("handles multiple batches", async () => {
    const port = createScriptedModelPort([
      [{ type: "text_delta", text: "A" }, { type: "done", stopReason: "tool_use" }],
      [{ type: "text_delta", text: "B" }, { type: "done", stopReason: "end_turn" }],
    ]);

    const events: string[] = [];
    for await (const event of port.stream({ messages: [], tools: [] })) {
      const label = event.type === "text_delta" ? `text_delta:${event.text}` : event.type;
      events.push(label);
    }

    expect(events).toEqual(["text_delta:A", "done", "text_delta:B", "done"]);
  });
});

describe("createSimulation", () => {
  it("creates all deterministic ports", () => {
    const sim = createSimulation({ seed: 42 });
    expect(sim.clock.now()).toBe(0);
    expect(sim.id.next()).toBe("eval-id-0");
    expect(typeof sim.random.next()).toBe("number");
  });

  it("produces deterministic results", () => {
    const s1 = createSimulation({ seed: 42 });
    const s2 = createSimulation({ seed: 42 });
    expect(s1.clock.now()).toBe(s2.clock.now());
    expect(s1.random.next()).toBe(s2.random.next());
    expect(s1.id.next()).toBe(s2.id.next());
  });
});

describe("simulateTrajectory", () => {
  const ctx = { model: "fixture-model", maxTokens: 100, tools: [] };
  const inputs = [
    { type: "user_message", content: "hello" },
    { type: "model_done", stopReason: "end_turn" },
  ] as const;

  it("records the full (state, effects) pair and replays strictly", () => {
    const traj = simulateTrajectory("sim", structuredClone(inputs) as never, ctx);
    expect(traj.stepContext).toEqual(ctx);
    expect(traj.expected).toHaveLength(inputs.length);
    expect(traj.expected[0]!.fullState).toBeDefined();
    expect(traj.expected[0]!.fullEffects).toBeDefined();

    const result = replayTrajectory(traj, ctx, { strict: true });
    expect(result.passed).toBe(true);
    expect(result.firstUndecidableIndex).toBe(-1);
  });
});
