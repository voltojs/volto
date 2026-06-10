import { describe, it, expect } from "vitest";
import type { BrowserAdapter } from "../index.js";
import {
  createBrowserNavigateTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserScreenshotTool,
  createBrowserGetPageTextTool,
  BROWSER_TOOL_NAMES,
} from "../index.js";

function createMockBrowser(): BrowserAdapter & { actions: string[] } {
  const actions: string[] = [];
  return {
    actions,
    async navigate(url) { actions.push(`navigate:${url}`); return { title: "Test Page", url }; },
    async click(sel) { actions.push(`click:${sel}`); },
    async type(sel, text) { actions.push(`type:${sel}:${text}`); },
    async screenshot() { actions.push("screenshot"); return { description: "Page looks normal" }; },
    async getPageText() { actions.push("getText"); return { text: "Hello world" }; },
  };
}

describe("BROWSER_TOOL_NAMES", () => {
  it("registers all 5 browser tools", () => {
    expect(BROWSER_TOOL_NAMES.size).toBe(5);
  });
});

describe("browser_navigate", () => {
  it("returns title and url", async () => {
    const browser = createMockBrowser();
    const tool = createBrowserNavigateTool(browser);
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("example.com");
    expect(result.modelContent).toContain("Test Page");
  });
});

describe("browser_click", () => {
  it("calls adapter and returns success", async () => {
    const browser = createMockBrowser();
    const tool = createBrowserClickTool(browser);
    const result = await tool.handler({ selector: "#submit" });
    expect(result.isError).toBeFalsy();
    expect(browser.actions).toContain("click:#submit");
  });

  it("returns isError on adapter failure", async () => {
    const browser: BrowserAdapter = {
      async navigate() { return { title: "", url: "" }; },
      async click() { throw new Error("element not found"); },
      async type() {},
      async screenshot() { return { description: "" }; },
      async getPageText() { return { text: "" }; },
    };
    const tool = createBrowserClickTool(browser);
    const result = await tool.handler({ selector: ".missing" });
    expect(result.isError).toBe(true);
  });
});

describe("browser_type", () => {
  it("calls adapter with text", async () => {
    const browser = createMockBrowser();
    const tool = createBrowserTypeTool(browser);
    const result = await tool.handler({ selector: "input", text: "hello" });
    expect(result.isError).toBeFalsy();
    expect(browser.actions).toContain("type:input:hello");
  });
});

describe("browser_screenshot", () => {
  it("returns description", async () => {
    const browser = createMockBrowser();
    const tool = createBrowserScreenshotTool(browser);
    const result = await tool.handler({});
    expect(result.modelContent).toBe("Page looks normal");
  });
});

describe("browser_get_page_text", () => {
  it("returns page text", async () => {
    const browser = createMockBrowser();
    const tool = createBrowserGetPageTextTool(browser);
    const result = await tool.handler({});
    expect(result.modelContent).toBe("Hello world");
  });
});
