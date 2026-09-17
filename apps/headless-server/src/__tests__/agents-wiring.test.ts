import { describe, it, expect } from "vitest";
import { startRouteTestServer } from "./helpers.js";

describe("agent definitions reach the agent", () => {
  it("offers a newly created definition on the next turn without a restart", async () => {
    const { url, token, captureToolDefinitions, runTurn, close } = await startRouteTestServer();

    await fetch(`${url}/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "project", spec: { name: "hot-added", description: "added mid-session" } }),
    });

    await runTurn("hello");

    const task = captureToolDefinitions().find((t) => t.name === "task");
    expect(task?.description).toContain("hot-added");
    await close();
  });

  it("omits shadowed definitions from the model-facing list", async () => {
    const { writeUserAgent, writeProjectAgent, captureToolDefinitions, runTurn, close } = await startRouteTestServer();
    await writeUserAgent("dup", "user");
    await writeProjectAgent("dup", "project");

    await runTurn("hello");
    const task = captureToolDefinitions().find((t) => t.name === "task");
    // Exactly one occurrence: the winning definition, not both.
    expect((task?.description.match(/dup/g) ?? []).length).toBe(1);
    await close();
  });

  it("offers plugin-provided agents as task-tool subagent types", async () => {
    // Without pluginSpecs in the runtime scan the UI would list an agent the
    // task tool then rejects as Unknown subagent_type — assert the exact
    // plugin name appears in the model-facing description.
    const { captureToolDefinitions, runTurn, close } = await startRouteTestServer({
      pluginAgents: [{ name: "from-plugin", description: "plugin-provided" }],
    });

    await runTurn("hello");
    const task = captureToolDefinitions().find((t) => t.name === "task");
    expect(task?.description).toContain("from-plugin");
    expect(task?.description).toContain("plugin-provided");
    await close();
  });
});
