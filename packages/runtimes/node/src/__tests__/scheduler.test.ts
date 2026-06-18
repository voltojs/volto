import { describe, it, expect } from "vitest";
import { createNodeScheduler } from "@volto/runtime-node";
import { createSeededClock } from "@volto/eval";

describe("createNodeScheduler", () => {
  describe("schedule + cancel", () => {
    it("schedule returns a task id", async () => {
      const clock = createSeededClock({ startMs: 0, stepMs: 100 });
      const scheduler = createNodeScheduler({ clock });
      const id = await scheduler.schedule(1000, "wake-up-ref");
      expect(id).toMatch(/^sched-\d+$/);
      // Cancel immediately
      await scheduler.cancel(id);
    });

    it("cancel returns true for existing task", async () => {
      const clock = createSeededClock({ startMs: 0 });
      const scheduler = createNodeScheduler({ clock });
      const id = await scheduler.schedule(60_000, "ref");
      const result = await scheduler.cancel(id);
      expect(result).toBe(true);
    });

    it("cancel returns false for unknown task", async () => {
      const clock = createSeededClock({ startMs: 0 });
      const scheduler = createNodeScheduler({ clock });
      const result = await scheduler.cancel("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("sleep", () => {
    it("sleep resolves after delay", async () => {
      const clock = createSeededClock({ startMs: 0 });
      const scheduler = createNodeScheduler({ clock });
      const start = Date.now();
      await scheduler.sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40); // some tolerance
    });

    it("sleep with zero resolves immediately", async () => {
      const clock = createSeededClock({ startMs: 0 });
      const scheduler = createNodeScheduler({ clock });
      await scheduler.sleep(0); // should not hang
    });

    it("sleep respects abort signal", async () => {
      const clock = createSeededClock({ startMs: 0 });
      const scheduler = createNodeScheduler({ clock });
      const controller = new AbortController();

      // Abort after 20ms
      setTimeout(() => controller.abort(), 20);

      const start = Date.now();
      await scheduler.sleep(10_000, controller.signal);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000); // aborted early
    });
  });
});
