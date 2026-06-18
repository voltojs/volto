import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { StepContext, ModelPort, ModelEvent } from "@volto/core";

const ctx: StepContext = { tools: [], model: "test-model" };

function createFailingModelPort(failCount: number, errorMessage = "ECONNRESET"): ModelPort {
  let callCount = 0;
  return {
    stream(): AsyncIterable<ModelEvent> {
      callCount++;
      if (callCount <= failCount) {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error(errorMessage)),
            return: () => Promise.resolve({ done: true, value: undefined }),
          }),
        };
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", text: "OK" };
          yield { type: "done", stopReason: "end_turn" };
        },
      };
    },
  };
}

describe("Runner retry policy", () => {
  it("retries on retriable error and succeeds", async () => {
    // Fails twice, succeeds on third attempt
    const model = createFailingModelPort(2);
    const events: Array<{ type: string; data?: unknown }> = [];
    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      eventSink: { emit(e) { events.push(e as { type: string; data?: unknown }); } },
      retryPolicy: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 },
    });

    const state = await runner.run({ type: "user_message", content: "go" });
    expect(state.status).toBe("done");

    // Should have retry events
    const retryEvents = events.filter((e) => e.type === "model_retry");
    expect(retryEvents.length).toBe(2);
  });

  it("circuit breaker stops retries after threshold", async () => {
    // Always fails
    const model = createFailingModelPort(100);
    const events: Array<{ type: string; data?: unknown }> = [];
    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      eventSink: { emit(e) { events.push(e as { type: string; data?: unknown }); } },
      retryPolicy: { maxRetries: 10, baseDelayMs: 1, circuitBreakerThreshold: 3 },
    });

    const state = await runner.run({ type: "user_message", content: "go" });
    expect(state.status).toBe("done");

    // Circuit breaker should have tripped at 3
    const retryEvents = events.filter((e) => e.type === "model_retry");
    expect(retryEvents.length).toBe(2); // 2 retries before circuit breaker at 3

    // Error event should mention retries
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.some((e) => {
      const data = e.data as Record<string, unknown>;
      return typeof data.error === "string" && data.error.includes("retried");
    })).toBe(true);
  });

  it("no retry when retryPolicy is undefined", async () => {
    const model = createFailingModelPort(5);
    const events: Array<{ type: string; data?: unknown }> = [];
    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      eventSink: { emit(e) { events.push(e as { type: string; data?: unknown }); } },
      // No retryPolicy
    });

    const state = await runner.run({ type: "user_message", content: "go" });
    expect(state.status).toBe("done");

    const retryEvents = events.filter((e) => e.type === "model_retry");
    expect(retryEvents.length).toBe(0);

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(1);
  });

  it("non-retriable error is not retried", async () => {
    const model: ModelPort = {
      stream(): AsyncIterable<ModelEvent> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error("401 Unauthorized")),
            return: () => Promise.resolve({ done: true, value: undefined }),
          }),
        };
      },
    };
    const events: Array<{ type: string; data?: unknown }> = [];
    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      eventSink: { emit(e) { events.push(e as { type: string; data?: unknown }); } },
      retryPolicy: { maxRetries: 3, baseDelayMs: 1 },
    });

    const state = await runner.run({ type: "user_message", content: "go" });
    expect(state.status).toBe("done");

    const retryEvents = events.filter((e) => e.type === "model_retry");
    expect(retryEvents.length).toBe(0);
  });
});
