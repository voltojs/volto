import { describe, it, expect } from "vitest";
import { createAgent } from "@agent-core/sdk";
import { createMockModelPort, textScript } from "@agent-core/core";
import { createRenderingEventSink } from "../render.js";

/**
 * Smoke test: assemble a minimal agent the same way `main.ts` does
 * (modelPort + tools + renderer event sink) and run one turn. Asserts that
 * the renderer received and rendered the model's text — proving the host
 * wiring as a whole works end-to-end without touching real stdio.
 */
describe("reference CLI smoke", () => {
  it("runs a turn end-to-end and renders the model's reply to stdout", async () => {
    const stdout: string[] = [];
    const sink = createRenderingEventSink({ stdout: (s) => stdout.push(s) });

    const model = createMockModelPort([
      textScript("Hello from the agent."),
    ]);

    const agent = createAgent({
      modelPort: model,
      eventSink: sink,
    });

    const state = await agent.run("hi");
    expect(state.status).toBe("done");

    const rendered = stdout.join("");
    expect(rendered).toContain("Hello from the agent.");
    expect(rendered.endsWith("\n")).toBe(true);
  });
});
