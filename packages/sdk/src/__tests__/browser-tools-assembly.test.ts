import { describe, expect, it } from "vitest";
import { createDefaultPermissionConfig, textScript } from "@volto/core";
import type { ModelPort, ModelRequest, Network, ToolDefinition } from "@volto/core";
import type { BrowserAdapter } from "@volto/tools-browser";
import { BROWSER_TOOL_NAMES } from "@volto/tools-browser";
import { assembleSubAgent, createAgent } from "../create-agent.js";
import type { Tool } from "@volto/tools-common";

const BROWSER_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_wait_for",
  "browser_screenshot",
  "browser_diagnostics",
  "browser_storage_state",
];

const fakeAdapter: BrowserAdapter = {
  async state() {
    return { url: "about:blank", title: "", status: "live", viewport: { width: 1280, height: 800 } };
  },
  async navigate() { throw new Error("not used"); },
  async goBack() { throw new Error("not used"); },
  async goForward() { throw new Error("not used"); },
  async reload() { throw new Error("not used"); },
  async snapshot() { return { text: "", truncated: false }; },
  async click() { throw new Error("not used"); },
  async type() { throw new Error("not used"); },
  async pressKey() { throw new Error("not used"); },
  async waitFor() { throw new Error("not used"); },
  async screenshot() { return { data: "", width: 1280, height: 800 }; },
  async diagnostics() { return { text: "", truncated: false }; },
  async storageState() { return { path: "", savedAt: 0 }; },
};

const network: Network = {
  async fetch() {
    return { status: 200, headers: {}, body: "ok" };
  },
};

async function visibleTools(adapter?: BrowserAdapter): Promise<string[]> {
  const requests: ModelRequest[] = [];
  const modelPort: ModelPort = {
    async *stream(req) {
      requests.push(req);
      yield* textScript("ok");
    },
  };
  const agent = createAgent({ modelPort, network, ...(adapter !== undefined ? { browserAdapter: adapter } : {}) });
  await agent.run("go");
  return requests[0]!.tools.map((tool) => tool.name);
}

function tool(name: string): Tool {
  const definition: ToolDefinition = {
    name,
    description: "",
    inputSchema: { type: "object" },
    requires: [],
    riskTier: "READ_ONLY",
  };
  return { definition, handler: async () => ({ modelContent: "ok" }) };
}

describe("browser tool assembly", () => {
  it("registers all nine browser tools and keeps web lookup tools visible", async () => {
    const tools = await visibleTools(fakeAdapter);
    for (const name of BROWSER_NAMES) expect(tools).toContain(name);
    expect(tools).toContain("web_fetch");
    expect(tools).toContain("web_search");
    expect(tools.length).toBeLessThanOrEqual(35);
  });

  it("registers no browser tools when no adapter is supplied", async () => {
    const tools = await visibleTools();
    for (const name of BROWSER_NAMES) expect(tools).not.toContain(name);
  });
});

describe("sub-agent inheritance", () => {
  const parentTools = [...BROWSER_NAMES, "read_file"].map(tool);

  it("excludes browser tools from the default inherited set", () => {
    const assembled = assembleSubAgent({
      spec: { name: "explore" },
      parentTools,
      parentPolicy: createDefaultPermissionConfig(),
      parentCapabilities: new Set(["browser:control", "filesystem:read"]),
    });
    const names = assembled.tools.map((t) => t.definition.name);
    expect(names).toContain("read_file");
    for (const name of BROWSER_NAMES) expect(names).not.toContain(name);
  });

  it("keeps browser tools when the spec explicitly lists them", () => {
    const assembled = assembleSubAgent({
      spec: { name: "custom", tools: ["browser_navigate", "read_file"] },
      parentTools,
      parentPolicy: createDefaultPermissionConfig(),
      parentCapabilities: new Set(["browser:control", "filesystem:read"]),
    });
    expect(assembled.tools.map((t) => t.definition.name)).toEqual(["browser_navigate", "read_file"]);
  });
});

describe("BROWSER_TOOL_NAMES", () => {
  it("contains exactly the nine agent tools", () => {
    expect([...BROWSER_TOOL_NAMES].sort()).toEqual([...BROWSER_NAMES].sort());
  });
});
