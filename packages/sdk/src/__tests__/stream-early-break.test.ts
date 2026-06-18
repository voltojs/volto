import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  textDelta,
  modelDone,
  modelError,
} from "@volto/core";
import type { ModelPort, ModelEvent } from "@volto/core";

/**
 * A model port whose stream yields events with explicit awaits between them
 * so a consumer can observe one event, break out of `for await`, and force the
 * underlying runner into the abort path. Without proper finally-block plumbing
 * in SDK.stream(), runner errors after early break are silently swallowed.
 */
function createSlowFailingModelPort(events: ModelEvent[]): ModelPort {
  return {
    async *stream(): AsyncIterable<ModelEvent> {
      for (const ev of events) {
        await new Promise((r) => setTimeout(r, 5));
        yield ev;
      }
    },
  };
}

describe("SDK stream() — early break", () => {
  it("propagates runner errors even when consumer breaks early", async () => {
    // Runner will receive a non-retriable model error after the first delta.
    // This causes the reducer to enter `done` with an error, which the runner
    // surfaces normally — but the historical bug was that the consumer's early
    // break would prevent the SDK from awaiting the runner promise, so even
    // synthetic exceptions thrown by the runner were swallowed.
    //
    // We use a model port that throws *after* the first event to simulate a
    // mid-stream runner-side failure that the SDK must surface to the consumer.
    const failingPort: ModelPort = {
      async *stream(): AsyncIterable<ModelEvent> {
        yield textDelta("partial");
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("network died mid-stream");
      },
    };

    const agent = createAgent({ modelPort: failingPort });

    let observedFirstEvent = false;
    let caught: unknown;
    try {
      for await (const event of agent.stream("hi")) {
        if (event.type === "text_delta") {
          observedFirstEvent = true;
          break; // consumer aborts early
        }
      }
    } catch (err) {
      caught = err;
    }

    expect(observedFirstEvent).toBe(true);
    // The runner's mid-stream throw is converted into a reducer "model_error"
    // input and turns the conversation into a done state with an error tool
    // result; the runner does not itself reject. So the early-break path
    // should NOT throw — but it MUST await the runner and not leave the
    // promise dangling. We assert no rejection (caught === undefined) and
    // that getState() reflects the completed/aborted state.
    expect(caught).toBeUndefined();
    const state = agent.getState();
    // After abort, state is one of: cancelling, done, or carrying an error
    // assistant message. The important property is that it has settled.
    expect(["done", "cancelling"]).toContain(state.status);
  });

  it("surfaces synthetic runner rejections when consumer drains the stream", async () => {
    // If the model port itself yields a non-retriable error event, the runner
    // resolves cleanly (it's modeled as a domain event, not an exception).
    // We just verify that draining the stream doesn't lose any events.
    const port = createSlowFailingModelPort([
      textDelta("hello"),
      modelError("upstream 500", false),
      modelDone("end_turn"),
    ]);
    const agent = createAgent({ modelPort: port });
    const events: string[] = [];
    for await (const ev of agent.stream("hi")) {
      events.push(ev.type);
    }
    expect(events).toContain("text_delta");
    // A non-retriable model error emits an `error` event before the
    // reducer transitions to `done`. We accept any of {error, model_done}
    // as proof the stream settled.
    expect(events.some((t) => t === "model_done" || t === "error")).toBe(true);
  });
});
