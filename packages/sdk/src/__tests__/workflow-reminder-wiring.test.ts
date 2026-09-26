/**
 * SDK pass-through for the workflow-mode reminder (spec 2026-09-25):
 * options reach the reducer untouched, and the fingerprint seed suppresses
 * a re-announce on a fresh instance.
 */
import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, textScript } from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";

const ENTER = "You are in plan mode (plan). wf-sdk-text";

function capturingPort(): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort([textScript("one"), textScript("two")]);
  return {
    port: {
      async *stream(req) {
        requests.push(structuredClone(req));
        yield* inner.stream(req);
      },
    },
    requests,
  };
}

function reminderCount(request: ModelRequest): number {
  return JSON.stringify(request.messages).split(ENTER).length - 1;
}

describe("workflowReminder pass-through", () => {
  it("injects on a fresh instance and does not re-inject on the next turn", async () => {
    const { port, requests } = capturingPort();
    const agent = createAgent({
      modelPort: port,
      workflowReminder: { key: "plan", announce: ENTER },
    });
    await agent.run("one");
    await agent.run("two");
    expect(reminderCount(requests[0]!)).toBe(1);
    // Turn 2 resends full history: still exactly one copy (no re-announce).
    expect(reminderCount(requests[1]!)).toBe(1);
  });

  it("initialAnnouncedWorkflowMode suppresses the announce on a fresh instance", async () => {
    const { port, requests } = capturingPort();
    const agent = createAgent({
      modelPort: port,
      workflowReminder: { key: "plan", announce: ENTER },
      initialAnnouncedWorkflowMode: "plan",
    });
    await agent.run("one");
    expect(reminderCount(requests[0]!)).toBe(0);
  });
});
