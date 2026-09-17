/**
 * Plugin-registered agent definitions must reach the task tool.
 *
 * `collectPlugins()` has gathered `agentSpecs` since M13 Phase 2, but nothing
 * consumed them: a plugin could register a sub-agent that no model could ever
 * select. They rank below every file source — a project or user definition of
 * the same name shadows the plugin's.
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type { Plugin } from "../plugin.js";
import type { ModelPort, ModelRequest, ModelEvent } from "@volto/core";
import { createMockModelPort, textScript, toolCallScript } from "@volto/core";
import type { AgentEntry } from "../agent-registry/index.js";

function recordingModelPort(script: ModelEvent[][]) {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(script);
  const port: ModelPort = {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(req);
      yield* inner.stream(req);
    },
  };
  return { port, requests };
}

const reviewerPlugin: Plugin = {
  name: "agent-plugin",
  register(r) {
    r.addAgentSpec({
      name: "reviewer",
      systemPrompt: "PLUGIN REVIEWER PROMPT",
      model: "plugin-model",
    });
  },
};

function dispatchScript(): ModelEvent[][] {
  return [
    toolCallScript(
      "p1",
      "task",
      JSON.stringify({ message: "review it", subagent_type: "reviewer" }),
    ),
    textScript("sub done"),
    textScript("parent done"),
  ];
}

describe("plugin-registered agent definitions", () => {
  it("offers them as subagent_type values on the task tool", async () => {
    const { port, requests } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      plugins: [reviewerPlugin],
    });

    await agent.run("delegate");

    const taskDef = requests[0]!.tools.find((t) => t.name === "task")!;
    expect(taskDef.description).toContain("reviewer");
  });

  it("dispatches one with its own prompt and model", async () => {
    const { port, requests } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      plugins: [reviewerPlugin],
    });

    await agent.run("delegate");

    const child = requests[1]!;
    expect(child.messages[0]).toMatchObject({
      role: "system",
      content: "PLUGIN REVIEWER PROMPT",
    });
    expect(child.model).toBe("plugin-model");
  });

  it("lets a file-sourced definition of the same name outrank the plugin's", async () => {
    const fileEntry: AgentEntry = {
      id: "project:reviewer",
      scope: "project",
      shadowed: false,
      spec: { name: "reviewer", systemPrompt: "PROJECT REVIEWER PROMPT" },
    };
    const { port, requests } = recordingModelPort(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      plugins: [reviewerPlugin],
      agentSpecs: [fileEntry],
    });

    await agent.run("delegate");

    const child = requests[1]!;
    expect(child.messages[0]).toMatchObject({
      role: "system",
      content: "PROJECT REVIEWER PROMPT",
    });
    // Listed once, not twice: the shadowed plugin entry stays out of the
    // model-facing set.
    const taskDef = requests[0]!.tools.find((t) => t.name === "task")!;
    expect(taskDef.description.match(/reviewer/g)).toHaveLength(1);
  });
});
