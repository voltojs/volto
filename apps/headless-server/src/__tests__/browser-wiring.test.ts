import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModelPort, textScript } from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";
import type { BrowserHost, LiveBrowserPage } from "@volto/runtime-node";
import { BROWSER_GUIDANCE, createWiredAgent } from "../wiring.js";
import { createServer } from "../server.js";

let configDir: string;
let projectDir: string;
let oldConfigDir: string | undefined;
let oldHome: string | undefined;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-wiring-config-"));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-wiring-project-"));
  oldConfigDir = process.env["VOLTO_CONFIG_DIR"];
  oldHome = process.env["HOME"];
  process.env["VOLTO_CONFIG_DIR"] = configDir;
  process.env["HOME"] = configDir;
});

afterEach(async () => {
  if (oldConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = oldConfigDir;
  if (oldHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = oldHome;
  await fs.rm(configDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

const fakeAdapter: LiveBrowserPage = {
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
  async close() {},
};

function fakeHost(): BrowserHost & { readonly pages: Array<{ id: string; egress: unknown }>; close: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  const pages: Array<{ id: string; egress: unknown }> = [];
  return {
    pages,
    page(id, opts) {
      pages.push({ id, egress: opts?.egressPolicy });
      return fakeAdapter;
    },
    close: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

function captureModel(): { modelPort: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort([textScript("ok")]);
  return {
    requests,
    modelPort: {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

describe("browser wiring", () => {
  it("adds the browser guidance and all nine tools for a session with a host", async () => {
    const host = fakeHost();
    const { modelPort, requests } = captureModel();
    const agent = await createWiredAgent({
      modelPort,
      cwd: projectDir,
      chatSessionId: "session-1",
      browserHost: host,
    });
    try {
      await agent.run("test the login page");
    } finally {
      await agent.dispose();
    }
    const names = requests[0]!.tools.map((tool) => tool.name);
    for (const name of [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press_key",
      "browser_wait_for",
      "browser_screenshot",
      "browser_diagnostics",
      "browser_storage_state",
    ]) {
      expect(names, `missing ${name}`).toContain(name);
    }
    expect(host.pages).toEqual([{ id: "session-1", egress: undefined }]);
    const system = requests[0]!.messages
      .filter((message) => message.role === "system")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(system).toContain(BROWSER_GUIDANCE);
  });

  it("leaves prompt and tools untouched without a host", async () => {
    const { modelPort, requests } = captureModel();
    const agent = await createWiredAgent({ modelPort, cwd: projectDir, chatSessionId: "session-2" });
    try {
      await agent.run("hi");
    } finally {
      await agent.dispose();
    }
    const names = requests[0]!.tools.map((tool) => tool.name);
    expect(names).not.toContain("browser_snapshot");
    const system = requests[0]!.messages
      .filter((message) => message.role === "system")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(system).not.toContain(BROWSER_GUIDANCE);
  });

  it("disposes the host when the server closes", async () => {
    const host = fakeHost();
    const server = await createServer({ port: 0, modelPort: createMockModelPort([textScript("ok")]), browserHost: host });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await vi.waitFor(() => expect(host.dispose).toHaveBeenCalled());
  });
});
