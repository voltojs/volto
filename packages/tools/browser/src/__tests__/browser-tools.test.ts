import { describe, expect, it } from "vitest";
import type { AttachmentStore } from "@volto/core";
import type { BrowserAdapter } from "../browser-adapter.js";
import type { ActionOutcome, BrowserState } from "../snapshot.js";
import {
  BROWSER_TOOL_NAMES,
  createBrowserClickTool,
  createBrowserDiagnosticsTool,
  createBrowserNavigateTool,
  createBrowserPressKeyTool,
  createBrowserScreenshotTool,
  createBrowserSnapshotTool,
  createBrowserStorageStateTool,
  createBrowserTypeTool,
  createBrowserWaitForTool,
} from "../index.js";

const state: BrowserState = {
  url: "http://localhost:5173/login",
  title: "Sign in",
  status: "live",
  viewport: { width: 1280, height: 800 },
};

function outcome(): ActionOutcome {
  return { state, text: '- button "Save" [ref=e1]', truncated: false };
}

function createFakeAdapter() {
  const calls: string[] = [];
  const adapter: BrowserAdapter = {
    async state() {
      return state;
    },
    async navigate(url) {
      calls.push(`navigate:${url}`);
      return outcome();
    },
    async goBack() {
      calls.push("back");
      return outcome();
    },
    async goForward() {
      calls.push("forward");
      return outcome();
    },
    async reload() {
      calls.push("reload");
      return outcome();
    },
    async snapshot(opts) {
      calls.push(`snapshot:${opts?.textOnly === true ? "text" : "full"}`);
      return { text: "page text", truncated: false };
    },
    async click(ref, opts) {
      calls.push(`click:${ref}:${opts?.button ?? "left"}:${opts?.clickCount ?? 1}`);
      return outcome();
    },
    async type(ref, text, opts) {
      calls.push(`type:${ref}:${text}:${opts?.submit === true ? "submit" : "no-submit"}`);
      return outcome();
    },
    async pressKey(key) {
      calls.push(`press:${key}`);
      return outcome();
    },
    async waitFor(opts) {
      calls.push(`wait:${opts.text ?? ""}:${opts.timeoutMs ?? 0}`);
      return outcome();
    },
    async screenshot(opts) {
      calls.push(`screenshot:${opts?.fullPage === true ? "full" : "viewport"}`);
      return { data: "aGVsbG8=", width: 1280, height: 800 };
    },
    async diagnostics(opts) {
      calls.push(`diagnostics:${opts.kind}:${opts.level ?? "all"}:${opts.limit ?? 0}`);
      return { text: "[error] boom", truncated: false };
    },
    async storageState(action) {
      calls.push(`storage:${action}`);
      return { path: "/tmp/auth.json", savedAt: 1 };
    },
  };
  return { adapter, calls };
}

function createFakeAttachments(): AttachmentStore & { puts: number } {
  const store = {
    puts: 0,
    async put() {
      store.puts += 1;
      return { id: "att-1", mimeType: "image/png", size: 5, width: 1280, height: 800 };
    },
    async get() {
      return undefined;
    },
    async deleteBySession() {},
  };
  return store;
}

describe("BROWSER_TOOL_NAMES", () => {
  it("registers all nine browser tools", () => {
    expect([...BROWSER_TOOL_NAMES].sort()).toEqual([
      "browser_click",
      "browser_diagnostics",
      "browser_navigate",
      "browser_press_key",
      "browser_screenshot",
      "browser_snapshot",
      "browser_storage_state",
      "browser_type",
      "browser_wait_for",
    ]);
  });
});

describe("tool definitions", () => {
  it("all require browser:control and mark output untrusted", () => {
    const { adapter } = createFakeAdapter();
    const tools = [
      createBrowserNavigateTool(adapter),
      createBrowserSnapshotTool(adapter),
      createBrowserClickTool(adapter),
      createBrowserTypeTool(adapter),
      createBrowserPressKeyTool(adapter),
      createBrowserWaitForTool(adapter),
      createBrowserScreenshotTool(adapter),
      createBrowserDiagnosticsTool(adapter),
      createBrowserStorageStateTool(adapter),
    ];
    for (const tool of tools) {
      expect(tool.definition.requires).toEqual(["browser:control"]);
      expect(tool.definition.trust).toBe("untrusted");
    }
  });

  it("click and type no longer expose a CSS selector", () => {
    const { adapter } = createFakeAdapter();
    expect(JSON.stringify(createBrowserClickTool(adapter).definition.inputSchema)).not.toContain("selector");
    expect(JSON.stringify(createBrowserTypeTool(adapter).definition.inputSchema)).not.toContain("selector");
  });
});

describe("browser_navigate", () => {
  it("returns url, title, and the new snapshot", async () => {
    const { adapter, calls } = createFakeAdapter();
    const result = await createBrowserNavigateTool(adapter).handler({ url: "http://localhost:5173/" });
    expect(calls).toEqual(["navigate:http://localhost:5173/"]);
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("http://localhost:5173/login");
    expect(result.modelContent).toContain("Sign in");
    expect(result.modelContent).toContain('button "Save"');
  });

  it("routes back/forward/reload actions", async () => {
    const { adapter, calls } = createFakeAdapter();
    await createBrowserNavigateTool(adapter).handler({ action: "back" });
    await createBrowserNavigateTool(adapter).handler({ action: "forward" });
    await createBrowserNavigateTool(adapter).handler({ action: "reload" });
    expect(calls).toEqual(["back", "forward", "reload"]);
  });

  it("rejects an empty call", async () => {
    const { adapter } = createFakeAdapter();
    const result = await createBrowserNavigateTool(adapter).handler({});
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("url");
  });
});

describe("browser_snapshot", () => {
  it("forwards textOnly", async () => {
    const { adapter, calls } = createFakeAdapter();
    const result = await createBrowserSnapshotTool(adapter).handler({ textOnly: true });
    expect(calls).toEqual(["snapshot:text"]);
    expect(result.modelContent).toBe("page text");
  });
});

describe("browser_click", () => {
  it("passes ref and button options", async () => {
    const { adapter, calls } = createFakeAdapter();
    const result = await createBrowserClickTool(adapter).handler({ ref: "e5", button: "right", clickCount: 2 });
    expect(calls).toEqual(["click:e5:right:2"]);
    expect(result.modelContent).toContain('button "Save"');
  });
});

describe("browser_type", () => {
  it("passes text and submit", async () => {
    const { adapter, calls } = createFakeAdapter();
    await createBrowserTypeTool(adapter).handler({ ref: "e3", text: "a@b.c", submit: true });
    expect(calls).toEqual(["type:e3:a@b.c:submit"]);
  });
});

describe("browser_press_key", () => {
  it("forwards the key", async () => {
    const { adapter, calls } = createFakeAdapter();
    await createBrowserPressKeyTool(adapter).handler({ key: "Escape" });
    expect(calls).toEqual(["press:Escape"]);
  });
});

describe("browser_wait_for", () => {
  it("forwards text and timeout", async () => {
    const { adapter, calls } = createFakeAdapter();
    await createBrowserWaitForTool(adapter).handler({ text: "Dashboard", timeoutMs: 5000 });
    expect(calls).toEqual(["wait:Dashboard:5000"]);
  });
});

describe("browser_screenshot", () => {
  it("stores the png and returns text plus an image block", async () => {
    const { adapter } = createFakeAdapter();
    const attachments = createFakeAttachments();
    const result = await createBrowserScreenshotTool(adapter, { attachments }).handler({});
    expect(attachments.puts).toBe(1);
    expect(Array.isArray(result.modelContent)).toBe(true);
    const blocks = result.modelContent as Array<{ type: string }>;
    expect(blocks.map((block) => block.type)).toEqual(["text", "image"]);
  });

  it("fails clearly without an attachment store", async () => {
    const { adapter } = createFakeAdapter();
    const result = await createBrowserScreenshotTool(adapter).handler({});
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("attachment store");
  });

  it("fails clearly when the model has no vision", async () => {
    const { adapter } = createFakeAdapter();
    const result = await createBrowserScreenshotTool(adapter, {
      attachments: createFakeAttachments(),
      visionSupported: false,
    }).handler({});
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("does not support image input");
  });
});

describe("browser_diagnostics", () => {
  it("forwards kind, level, and limit", async () => {
    const { adapter, calls } = createFakeAdapter();
    const result = await createBrowserDiagnosticsTool(adapter).handler({ kind: "network", level: "error", limit: 20 });
    expect(calls).toEqual(["diagnostics:network:error:20"]);
    expect(result.modelContent).toContain("boom");
  });
});

describe("browser_storage_state", () => {
  it("saves and returns the configured path", async () => {
    const { adapter, calls } = createFakeAdapter();
    const tool = createBrowserStorageStateTool(adapter);
    const result = await tool.handler({ action: "save" });
    expect(tool.definition.riskTier).toBe("WRITE_HIGH");
    expect(calls).toEqual(["storage:save"]);
    expect(result.modelContent).toContain("/tmp/auth.json");
  });
});

describe("error normalization", () => {
  it("turns adapter throws into isError results", async () => {
    const { adapter } = createFakeAdapter();
    adapter.click = async () => {
      throw new Error('ref "e9" is stale');
    };
    const result = await createBrowserClickTool(adapter).handler({ ref: "e9" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("stale");
    expect(result.modelContent).toContain("browser_snapshot");
  });
});