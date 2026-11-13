/**
 * browser-tools — nine tools wrapping one BrowserAdapter.
 *
 * The agent sees snapshots with refs, not selectors. Every action returns a
 * fresh snapshot so the next decision starts from current page state.
 */

import { z } from "zod";
import type { AttachmentStore, ToolResult, ToolResultBlock } from "@voltojs/core";
import { defineTool, MAX_IMAGE_BASE64, imageDownscaleHint } from "@voltojs/tools-common";
import type { Tool } from "@voltojs/tools-common";
import { CAP_BROWSER_CONTROL } from "./browser-adapter.js";
import type { BrowserAdapter } from "./browser-adapter.js";
import type { ActionOutcome } from "./snapshot.js";

function failure(tool: string, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const staleRef = /stale|no element has that ref/i.test(message)
    ? " Call browser_snapshot and retry with a current ref."
    : "";
  return { modelContent: `${tool} failed: ${message}${staleRef}`, isError: true };
}

function outcomeText(outcome: ActionOutcome): string {
  return `URL: ${outcome.state.url}\nTitle: ${outcome.state.title}\n\n${outcome.text}`;
}

function emptyPage(text: string): string {
  return text.trim().length > 0 ? text : "(no readable page content; try browser_screenshot)";
}

// ── browser_navigate ──────────────────────────

const navigateSchema = z.object({
  url: z.string().min(1).optional().describe("Absolute http(s) URL to open."),
  action: z.enum(["back", "forward", "reload"]).optional().describe("History action instead of a URL."),
});

export function createBrowserNavigateTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_navigate",
    description:
      "Open an http(s) URL, or move through history with back/forward/reload. Returns the page title, URL, and a fresh snapshot with refs.",
    schema: navigateSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "READ_ONLY",
    trust: "untrusted",
    hostInputs: ["url"],
    run: async ({ url, action }) => {
      try {
        if (action === "back") return { modelContent: outcomeText(await browser.goBack()) };
        if (action === "forward") return { modelContent: outcomeText(await browser.goForward()) };
        if (action === "reload") return { modelContent: outcomeText(await browser.reload()) };
        if (url === undefined) {
          return {
            modelContent: "browser_navigate needs a url or an action (back/forward/reload).",
            isError: true,
          };
        }
        return { modelContent: outcomeText(await browser.navigate(url)) };
      } catch (err) {
        return failure("browser_navigate", err);
      }
    },
  });
}

// ── browser_snapshot ──────────────────────────

const snapshotSchema = z.object({
  textOnly: z.boolean().optional().describe("Return page text without roles/refs; use for long articles."),
});

export function createBrowserSnapshotTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_snapshot",
    description:
      "Read the current page as a compact tree of elements with refs. Refs are only valid until the next page change or snapshot. Prefer this over screenshots.",
    schema: snapshotSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "READ_ONLY",
    trust: "untrusted",
    run: async ({ textOnly }) => {
      try {
        const result = await browser.snapshot(textOnly === true ? { textOnly: true } : undefined);
        return { modelContent: emptyPage(result.text) };
      } catch (err) {
        return failure("browser_snapshot", err);
      }
    },
  });
}

// ── browser_click ─────────────────────────────

const clickSchema = z.object({
  ref: z.string().min(1).describe("Element ref from the latest snapshot, e.g. e12."),
  button: z.enum(["left", "right"]).optional().describe("Mouse button; defaults to left."),
  clickCount: z.union([z.literal(1), z.literal(2)]).optional().describe("1 = click, 2 = double click."),
});

export function createBrowserClickTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_click",
    description:
      "Click an element by its snapshot ref. Returns a fresh snapshot; if the ref is stale, call browser_snapshot again.",
    schema: clickSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "WRITE_LOW",
    trust: "untrusted",
    run: async ({ ref, button, clickCount }) => {
      try {
        const opts = {
          ...(button !== undefined ? { button } : {}),
          ...(clickCount !== undefined ? { clickCount } : {}),
        };
        return { modelContent: outcomeText(await browser.click(ref, opts)) };
      } catch (err) {
        return failure("browser_click", err);
      }
    },
  });
}

// ── browser_type ──────────────────────────────

const typeSchema = z.object({
  ref: z.string().min(1).describe("Input/textarea ref from the latest snapshot."),
  text: z.string().describe("Text to fill into the element."),
  submit: z.boolean().optional().describe("Press Enter after filling."),
});

export function createBrowserTypeTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_type",
    description:
      "Fill an input/textarea by snapshot ref. Set submit=true to press Enter afterwards. Returns a fresh snapshot.",
    schema: typeSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "WRITE_LOW",
    trust: "untrusted",
    run: async ({ ref, text, submit }) => {
      try {
        return {
          modelContent: outcomeText(
            await browser.type(ref, text, submit === true ? { submit: true } : undefined),
          ),
        };
      } catch (err) {
        return failure("browser_type", err);
      }
    },
  });
}

// ── browser_press_key ─────────────────────────

const pressKeySchema = z.object({
  key: z.string().min(1).describe('Key name, e.g. "Enter", "Escape", "Tab", "ArrowDown".'),
});

export function createBrowserPressKeyTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_press_key",
    description: "Press a keyboard key on the focused element or page. Returns a fresh snapshot.",
    schema: pressKeySchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "WRITE_LOW",
    trust: "untrusted",
    run: async ({ key }) => {
      try {
        return { modelContent: outcomeText(await browser.pressKey(key)) };
      } catch (err) {
        return failure("browser_press_key", err);
      }
    },
  });
}

// ── browser_wait_for ──────────────────────────

const waitForSchema = z.object({
  text: z.string().min(1).optional().describe("Wait until this text appears on the page."),
  timeoutMs: z.number().int().positive().optional().describe("Maximum wait; defaults to 5000."),
});

export function createBrowserWaitForTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_wait_for",
    description:
      "Wait for text to appear (or for a timeout when text is omitted), then return a fresh snapshot. Use for async UI instead of sleeping.",
    schema: waitForSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "READ_ONLY",
    trust: "untrusted",
    run: async ({ text, timeoutMs }) => {
      try {
        const opts = {
          ...(text !== undefined ? { text } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        };
        return { modelContent: outcomeText(await browser.waitFor(opts)) };
      } catch (err) {
        return failure("browser_wait_for", err);
      }
    },
  });
}

// ── browser_screenshot ────────────────────────

const screenshotSchema = z.object({
  fullPage: z.boolean().optional().describe("Capture the full scrollable page instead of the viewport."),
});

export interface BrowserScreenshotToolOptions {
  attachments?: AttachmentStore;
  /** False when the resolved model declares no image input. */
  visionSupported?: boolean;
}

export function createBrowserScreenshotTool(
  browser: BrowserAdapter,
  opts: BrowserScreenshotToolOptions = {},
): Tool {
  return defineTool({
    name: "browser_screenshot",
    description:
      "Capture a PNG of the page. Use for visual layout or evidence; prefer browser_snapshot for locating elements.",
    schema: screenshotSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "READ_ONLY",
    trust: "untrusted",
    run: async ({ fullPage }) => {
      if (!opts.attachments) {
        return {
          modelContent: "browser_screenshot cannot return images: no attachment store is configured.",
          isError: true,
        };
      }
      if (opts.visionSupported === false) {
        return {
          modelContent:
            "The current model does not support image input. Use browser_snapshot { textOnly: true } instead.",
          isError: true,
        };
      }
      try {
        const shot = await browser.screenshot(fullPage === true ? { fullPage: true } : undefined);
        if (shot.data.length > MAX_IMAGE_BASE64) {
          return {
            modelContent: `Screenshot is too large to send (${shot.data.length} base64 bytes).`,
            isError: true,
          };
        }
        const stored = await opts.attachments.put(shot.data, "image/png", { name: "screenshot.png" });
        const width = stored.width ?? shot.width;
        const height = stored.height ?? shot.height;
        const hint = imageDownscaleHint(width, height);
        const blocks: ToolResultBlock[] = [
          {
            type: "text",
            text: `Screenshot (${width}x${height})${hint ? `\n${hint}` : ""}`,
          },
          {
            type: "image",
            source: { type: "ref", id: stored.id, mediaType: stored.mimeType },
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
          },
        ];
        return {
          modelContent: blocks,
          displayMetadata: {
            screenshot: true,
            width,
            height,
            fullPage: fullPage === true,
          },
        };
      } catch (err) {
        return failure("browser_screenshot", err);
      }
    },
  });
}

// ── browser_diagnostics ───────────────────────

const diagnosticsSchema = z.object({
  kind: z.enum(["console", "network"]).describe("console/pageerror entries, or failed/4xx/5xx requests."),
  level: z.enum(["error", "warning", "info"]).optional().describe("Filter console entries by level."),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum entries; defaults to 50."),
});

export function createBrowserDiagnosticsTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_diagnostics",
    description:
      "Read recent console/page errors or failed/4xx/5xx network requests. Use this before guessing why a page did not react. Response bodies are not captured.",
    schema: diagnosticsSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "READ_ONLY",
    trust: "untrusted",
    run: async ({ kind, level, limit }) => {
      try {
        const result = await browser.diagnostics({
          kind,
          ...(level !== undefined ? { level } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        const empty = kind === "console" ? "No console entries." : "No failed or 4xx/5xx requests.";
        const text = result.text.trim().length > 0 ? result.text : empty;
        return {
          modelContent: result.truncated
            ? `${text}\n... [truncated: showing the most recent entries only]`
            : text,
        };
      } catch (err) {
        return failure("browser_diagnostics", err);
      }
    },
  });
}

// ── browser_storage_state ─────────────────────

const storageStateSchema = z.object({
  action: z.literal("save").describe("Save cookies/localStorage to the configured path."),
});

export function createBrowserStorageStateTool(browser: BrowserAdapter): Tool {
  return defineTool({
    name: "browser_storage_state",
    description:
      "Save the current browser context's storage state (cookies + localStorage) to the path configured by the host. Use after a test login so later sessions can reuse it.",
    schema: storageStateSchema,
    requires: [CAP_BROWSER_CONTROL],
    riskTier: "WRITE_HIGH",
    trust: "untrusted",
    run: async ({ action }) => {
      try {
        const result = await browser.storageState(action);
        return {
          modelContent: `Saved storage state to ${result.path} (${new Date(result.savedAt).toISOString()}).`,
          displayMetadata: { path: result.path, savedAt: result.savedAt },
        };
      } catch (err) {
        return failure("browser_storage_state", err);
      }
    },
  });
}

export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_wait_for",
  "browser_screenshot",
  "browser_diagnostics",
  "browser_storage_state",
]);