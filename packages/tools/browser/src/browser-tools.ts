/**
 * browser-tools — 5 browser automation tools wrapping BrowserAdapter.
 */

import { z } from "zod";
import { defineTool } from "@agent-core/tools-common";
import type { Tool } from "@agent-core/tools-common";
import { CAP_BROWSER_CONTROL } from "./browser-adapter.js";
import type { BrowserAdapter } from "./browser-adapter.js";

// ── browser_navigate ──────────────────────────

const navigateSchema = z.object({
  url: z.string().describe("URL to navigate to."),
});

export function createBrowserNavigateTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_navigate",
    description: "Navigate the browser to a URL and return the page title.",
    schema: navigateSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "READ_ONLY",
    run: async ({ url }) => {
      try {
        const { title, url: finalUrl } = await browser.navigate(url);
        return {
          modelContent: `Navigated to: ${finalUrl}\nTitle: ${title}`,
          displayMetadata: { url: finalUrl, title },
        };
      } catch (err) {
        return { modelContent: `browser_navigate failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ── browser_click ─────────────────────────────

const clickSchema = z.object({
  selector: z.string().describe("CSS selector for the element to click."),
});

export function createBrowserClickTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_click",
    description: "Click an element on the page identified by a CSS selector.",
    schema: clickSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "WRITE_LOW",
    run: async ({ selector }) => {
      try {
        await browser.click(selector);
        return {
          modelContent: `Clicked: ${selector}`,
          displayMetadata: { selector },
        };
      } catch (err) {
        return { modelContent: `browser_click failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ── browser_type ──────────────────────────────

const typeSchema = z.object({
  selector: z.string().describe("CSS selector for the input element."),
  text: z.string().describe("Text to type into the element."),
});

export function createBrowserTypeTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_type",
    description: "Type text into an input element on the page.",
    schema: typeSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "WRITE_LOW",
    run: async ({ selector, text }) => {
      try {
        await browser.type(selector, text);
        return {
          modelContent: `Typed into ${selector}: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`,
          displayMetadata: { selector, textLength: text.length },
        };
      } catch (err) {
        return { modelContent: `browser_type failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ── browser_screenshot ────────────────────────

export function createBrowserScreenshotTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_screenshot",
    description: "Take a screenshot of the current page and return a description of what's visible.",
    schema: z.object({}),
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "READ_ONLY",
    run: async () => {
      try {
        const { description } = await browser.screenshot();
        return {
          modelContent: description,
          displayMetadata: { screenshot: true },
        };
      } catch (err) {
        return { modelContent: `browser_screenshot failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ── browser_get_page_text ─────────────────────

export function createBrowserGetPageTextTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_get_page_text",
    description: "Get the text content of the current page.",
    schema: z.object({}),
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "READ_ONLY",
    run: async () => {
      try {
        const { text } = await browser.getPageText();
        const truncated = text.length > 20000;
        const content = truncated ? text.slice(0, 20000) + "\n... [truncated]" : text;
        return {
          modelContent: content,
          displayMetadata: { textLength: text.length, truncated },
        };
      } catch (err) {
        return { modelContent: `browser_get_page_text failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_get_page_text",
]);
