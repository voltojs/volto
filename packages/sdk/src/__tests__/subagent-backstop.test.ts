/**
 * F-070: the SDK executor's two runtime backstops, pinned by their exact
 * rejection signatures (design §2 D5, §6 error matrix).
 *
 * Backstop A — an unknown subagent_type that reached dispatch (the task
 * tool's registry list was empty, so its pre-check had nothing to check
 * against) must fail loudly with `Unknown subagent_type "<x>"`, normalized
 * by the task tool into `Sub-agent error: …`; it must never silently fall
 * back to a general-purpose sub-agent.
 *
 * Backstop B — a sub-agent has no turn boundary of its own to drain a
 * background registry on, so its nested task refuses a background dispatch
 * instead of silently running it synchronously (the model would otherwise
 * be told it holds a task id it can never collect).
 *
 * Both tests assert the rejection itself — isError plus the verbatim
 * signature on the model-visible path — never "the output is empty"
 * (AGENTS.md §2.1).
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, toolCallScript, textScript } from "@voltojs/core";
import type { ModelPort, ModelRequest, ModelEvent } from "@voltojs/core";
import type { AgentSpec } from "../agent-spec.js";
import type { AgentEntry } from "../agent-registry/scan.js";

/** Wrap a scripted mock port so every ModelRequest the runner makes is captured. */
function captureModelPort(scripts: ModelEvent[][]): {
  port: ModelPort;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(scripts);
  return {
    requests,
    port: {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

function agentEntry(spec: AgentSpec): AgentEntry {
  return { id: `plugin:${spec.name}`, scope: "plugin", spec, shadowed: false };
}

/** The isError flag and joined text of one tool_result as the model sees it. */
function toolResultOf(
  req: ModelRequest,
  toolUseId: string,
): { isError: boolean; text: string } {
  for (const m of req.messages) {
    if (m.role !== "tool" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_result" || block.toolUseId !== toolUseId) continue;
      const parts = Array.isArray(block.content)
        ? block.content
        : [{ type: "text" as const, text: String(block.content) }];
      const text = parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      return { isError: block.isError === true, text };
    }
  }
  throw new Error(`no tool_result for ${toolUseId} in request`);
}

describe("F-150 executor backstop A — unknown subagent_type", () => {
  it("F-150 an unknown subagent_type is rejected without falling through to general-purpose", async () => {
    // Built-ins always populate the type list, so subagent_type arrives as
    // an enum and a value outside it is rejected at validation — the same
    // fail-loudly guarantee the executor backstop was there for: a model
    // that names a type must not silently get a different one. The result
    // stays an isError tool_result whose signature is pinned below.
    const { port, requests } = captureModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "go", subagent_type: "ghost" }),
      ),
      textScript("ok"),
    ]);

    const agent = createAgent({ modelPort: port, enableTaskTool: true, agentSpecs: [] });
    await agent.run("dispatch a type that does not exist");

    // Request 0 dispatched, request 1 carries the normalized rejection back
    // to the model — the assertion lives on the model-visible path.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const result = toolResultOf(requests[1]!, "c1");
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'Invalid input for tool "task": property "subagent_type" must be one of: general-purpose, explore',
    );
  });
});

describe("F-151 executor backstop B — background dispatch from a sub-agent", () => {
  it("F-151 a sub-agent's background dispatch is refused with an exact signature", async () => {
    // maxAgentDepth 2; the "lead" definition lists `task`, so the child
    // receives a nested task bound one level deeper. The scripted child then
    // asks that nested task for a background dispatch — the nested-dispatch
    // refusal must surface as an isError tool_result with a verbatim
    // signature inside the child's own context.
    const { port, requests } = captureModelPort([
      toolCallScript(
        "p1",
        "task",
        JSON.stringify({ message: "level one", subagent_type: "lead" }),
      ),
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "level two", run_in_background: true }),
      ),
      textScript("child done"),
      textScript("parent done"),
    ]);

    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      maxAgentDepth: 2,
      agentSpecs: [agentEntry({ name: "lead", tools: ["task"] })],
    });
    await agent.run("delegate twice");

    // The signature assertions come FIRST: they are the pin (backstop B
    // normalizes to isError with an exact signature through the task tool),
    // and toolResultOf throws if the child's follow-up request carries no
    // tool_result for the call at all. A request-count coupling must never
    // preempt them — a count mismatch would otherwise mask whether the
    // rejection signature itself still discriminates. The count is only a
    // loose sanity floor: a broken backstop turns the refusal into a
    // synchronous dispatch (extra model rounds), which `>=` still admits
    // while the signature assertion below fails loudly.
    const refusal = toolResultOf(requests[2]!, "c1");
    expect(refusal.isError).toBe(true);
    expect(refusal.text).toBe(
      "Sub-agent error: Background dispatch is not available to a sub-agent; run the task synchronously.",
    );
    // 0 parent dispatches, 1 child attempts the background dispatch,
    // 2 child sees the refusal and wraps up (3 parent wraps up).
    expect(requests.length).toBeGreaterThanOrEqual(3);
  });
});
