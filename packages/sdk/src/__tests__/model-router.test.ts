import { describe, it, expect } from "vitest";
import { createModelRouter } from "../model-router.js";
import type { ModelPort, ModelEvent, ModelRequest } from "@volto/core";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function createMockPort(events: ModelEvent[]): ModelPort {
  return {
    async *stream(): AsyncIterable<ModelEvent> {
      yield* events;
    },
  };
}

function createErrorPort(error: string, retriable: boolean): ModelPort {
  return {
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "error", error, retriable };
    },
  };
}

function createFailingPort(): ModelPort {
  return {
    stream(): AsyncIterable<ModelEvent> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.reject(new Error("Network failure"));
            },
          };
        },
      };
    },
  };
}

async function collect(port: ModelPort, req?: Partial<ModelRequest>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const e of port.stream({
    messages: [],
    tools: [],
    ...req,
  } as ModelRequest)) {
    events.push(e);
  }
  return events;
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("createModelRouter", () => {
  describe("primary route", () => {
    it("should use the primary provider", async () => {
      const primary = createMockPort([
        { type: "text_delta", text: "Hello" },
        { type: "done", stopReason: "end_turn" },
      ]);

      const router = createModelRouter({
        primary: { provider: primary, model: "test-model" },
      });

      const events = await collect(router);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "Hello" });
      expect(events[1]).toMatchObject({ type: "done", stopReason: "end_turn" });
    });
  });

  describe("fallback on retriable error", () => {
    it("should fall back when primary yields retriable error", async () => {
      const primary = createErrorPort("Rate limited", true);
      const fallback = createMockPort([
        { type: "text_delta", text: "Fallback response" },
        { type: "done", stopReason: "end_turn" },
      ]);

      const router = createModelRouter({
        primary: { provider: primary, model: "primary-model" },
        fallbacks: [{ provider: fallback }],
      });

      const events = await collect(router);
      // Retriable error should be swallowed, fallback events yielded
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "Fallback response" });
    });

    it("should fall back on network failure", async () => {
      const primary = createFailingPort();
      const fallback = createMockPort([
        { type: "text_delta", text: "Recovered" },
        { type: "done", stopReason: "end_turn" },
      ]);

      const router = createModelRouter({
        primary: { provider: primary, model: "m" },
        fallbacks: [{ provider: fallback }],
      });

      const events = await collect(router);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ text: "Recovered" });
    });
  });

  describe("non-retriable error stops", () => {
    it("should yield non-retriable error without fallback", async () => {
      const primary = createErrorPort("Auth failed", false);
      const fallback = createMockPort([{ type: "done", stopReason: "end_turn" }]);

      const router = createModelRouter({
        primary: { provider: primary, model: "m" },
        fallbacks: [{ provider: fallback }],
      });

      const events = await collect(router);
      // Non-retriable error is yielded (not swallowed) and no fallback
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", error: "Auth failed", retriable: false });
    });
  });

  describe("fallback model override", () => {
    it("should use fallback's model when specified", async () => {
      let receivedModel = "";
      const fallback: ModelPort = {
        async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
          receivedModel = req.model ?? "";
          yield { type: "done", stopReason: "end_turn" };
        },
      };

      const primary = createErrorPort("overloaded", true);

      const router = createModelRouter({
        primary: { provider: primary, model: "primary-m" },
        fallbacks: [{ provider: fallback, model: "fallback-m" }],
      });

      await collect(router);
      expect(receivedModel).toBe("fallback-m");
    });

    it("should use primary model when fallback doesn't specify one", async () => {
      let receivedModel = "";
      const fallback: ModelPort = {
        async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
          receivedModel = req.model ?? "";
          yield { type: "done", stopReason: "end_turn" };
        },
      };

      const primary = createErrorPort("overloaded", true);

      const router = createModelRouter({
        primary: { provider: primary, model: "primary-m" },
        fallbacks: [{ provider: fallback }],
      });

      await collect(router);
      expect(receivedModel).toBe("primary-m");
    });
  });
});
