/**
 * BrowserAdapter — runtime interface for browser automation.
 * Implementations handle the actual browser I/O (Playwright, Puppeteer, etc.).
 */

export const CAP_BROWSER_CONTROL = "browser:control";

export interface BrowserAdapter {
  /** Navigate to a URL */
  navigate(url: string): Promise<{ title: string; url: string }>;
  /** Click an element identified by selector */
  click(selector: string): Promise<void>;
  /** Type text into an element */
  type(selector: string, text: string): Promise<void>;
  /** Take a screenshot and return a description or path */
  screenshot(): Promise<{ description: string }>;
  /** Get the text content of the page */
  getPageText(): Promise<{ text: string }>;
}
