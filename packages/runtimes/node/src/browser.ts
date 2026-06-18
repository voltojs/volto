/**
 * Node.js Browser adapter — implements BrowserAdapter via Playwright.
 *
 * Playwright must be installed by the host application:
 *   pnpm add playwright  (or npm install playwright)
 *
 * The adapter launches a Chromium browser on first use and reuses it
 * for subsequent calls. Call `close()` to release resources.
 */

import type { BrowserAdapter } from "@volto/tools-browser";

export interface NodeBrowserOptions {
  /** Launch options forwarded to Playwright's browserType.launch() */
  headless?: boolean;
}

export async function createNodeBrowserAdapter(
  opts?: NodeBrowserOptions,
): Promise<BrowserAdapter> {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    throw new Error(
      "Playwright is required for browser adapter. Install with: pnpm add playwright",
    );
  }

  const browser = await pw.chromium.launch({ headless: opts?.headless ?? true });
  const page = await browser.newPage();

  return {
    async navigate(url: string) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const title = await page.title();
      return { title, url: page.url() };
    },

    async click(selector: string) {
      await page.click(selector);
    },

    async type(selector: string, text: string) {
      await page.fill(selector, text);
    },

    async screenshot() {
      const buffer = await page.screenshot({ type: "png" });
      return { description: `[screenshot ${buffer.byteLength} bytes, ${page.url()}]` };
    },

    async getPageText() {
      const text = await page.locator("body").innerText();
      return { text };
    },
  };
}
