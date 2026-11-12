/**
 * Node browser host — one Chromium process, one isolated context per chat
 * session, lazy page creation, serialized actions, and idle/LRU eviction.
 *
 * Playwright is an optional peer dependency: the host imports it only when a
 * page is first needed. A missing install is reported as
 * BrowserUnavailableError with the install command, never as a crash.
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type {
  ActionOutcome,
  BrowserAdapter,
  BrowserDiagnosticsOptions,
  BrowserScreenshot,
  BrowserState,
  DiagnosticsOutcome,
  SnapshotNode,
  SnapshotOutcome,
  StorageStateOutcome,
} from "@volto/tools-browser";
import { formatSnapshot, SNAPSHOT_SCRIPT } from "@volto/tools-browser";
import { createDiagnosticsBuffer, type DiagnosticsBuffer } from "./browser-diagnostics.js";
import { isHostAllowed, type EgressPolicy } from "./egress.js";

export interface BrowserHostOptions {
  /** Default false; Linux without a display falls back to headless. */
  headless?: boolean;
  /** Close an unused context after this many milliseconds. Default 600000. */
  idleTimeoutMs?: number;
  /** Maximum live contexts. Default 4. */
  maxContexts?: number;
  /** Optional Playwright storage state file loaded into new contexts. */
  storageStatePath?: string;
  /** Optional Chromium executable override. */
  executablePath?: string;
}

export interface PageOptions {
  /** Updating this clears the previous policy when it is null/undefined. */
  egressPolicy?: EgressPolicy | null;
}

export interface LiveBrowserPage extends BrowserAdapter {
  close(): Promise<void>;
}

export interface BrowserHost {
  page(sessionId: string, opts?: PageOptions): LiveBrowserPage;
  close(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export class BrowserUnavailableError extends Error {
  constructor() {
    super(
      "Playwright is required for the browser host. Install it with: pnpm exec playwright install chromium",
    );
    this.name = "BrowserUnavailableError";
  }
}

/** Default headed off Linux; Linux without a display runs headless. */
export function resolveHeadless(
  requested: boolean | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  if (requested !== undefined) return requested;
  if (platform === "linux" && env["DISPLAY"] === undefined && env["WAYLAND_DISPLAY"] === undefined) {
    return true;
  }
  return false;
}

/** Expand a leading `~` or `~/` to `home`; other paths pass through. */
export function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

/** One FIFO queue for one page's actions. Rejections never poison the queue. */
export function createSerialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const METADATA_HOSTS = new Set(["169.254.169.254", "100.100.100.200"]);

function normalizedHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Top-level navigation policy: http(s), no credentials, egress, no metadata. */
export function isNavigationAllowed(url: string, policy: EgressPolicy | undefined): boolean {
  if (url === "about:blank") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const host = normalizedHost(parsed.hostname);
  if (METADATA_HOSTS.has(host) || host.startsWith("169.254.")) return false;
  return isHostAllowed(host, policy ?? {});
}

interface SessionEntry {
  readonly id: string;
  readonly queue: ReturnType<typeof createSerialQueue>;
  readonly diagnostics: DiagnosticsBuffer;
  live: LivePage;
  context?: BrowserContext;
  page?: Page;
  ready?: Promise<{ context: BrowserContext; page: Page }>;
  egressPolicy?: EgressPolicy;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
  crashed: boolean;
  closed: boolean;
}

interface HostCallbacks {
  ensure(entry: SessionEntry): Promise<{ context: BrowserContext; page: Page }>;
  touch(entry: SessionEntry): void;
  close(sessionId: string): Promise<void>;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => undefined);
}

async function readSnapshot(page: Page, textOnly = false): Promise<SnapshotOutcome> {
  const nodes = (await page.evaluate(SNAPSHOT_SCRIPT)) as SnapshotNode[];
  return formatSnapshot(nodes, { maxChars: 8000, ...(textOnly ? { textOnly: true } : {}) });
}

async function readState(page: Page): Promise<BrowserState> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  return {
    url: page.url(),
    title: await page.title(),
    status: "live",
    viewport,
  };
}

async function outcomeOf(page: Page, textOnly = false): Promise<ActionOutcome> {
  const [state, snapshot] = await Promise.all([readState(page), readSnapshot(page, textOnly)]);
  return { state, ...snapshot };
}

function locatorFor(page: Page, ref: string) {
  if (!/^e\d+$/.test(ref)) throw new Error(`invalid ref "${ref}"`);
  return page.locator(`[data-volto-ref="${ref}"]`).first();
}

class LivePage implements LiveBrowserPage {
  private readonly entry: SessionEntry;
  private readonly host: HostCallbacks;
  private readonly storageStatePath?: string;

  constructor(entry: SessionEntry, host: HostCallbacks, storageStatePath: string | undefined) {
    this.entry = entry;
    this.host = host;
    this.storageStatePath = storageStatePath;
  }

  private run<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.entry.closed) {
      throw new Error("Browser session closed. Use a browser tool again to start a new page.");
    }
    this.host.touch(this.entry);
    return this.entry.queue(async () => {
      const { page } = await this.host.ensure(this.entry);
      return fn(page);
    });
  }

  async state(): Promise<BrowserState> {
    return this.run((page) => readState(page));
  }

  async navigate(url: string): Promise<ActionOutcome> {
    return this.run(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
      return outcomeOf(page);
    });
  }

  async goBack(): Promise<ActionOutcome> {
    return this.run(async (page) => {
      const response = await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
      if (response === null) throw new Error("No previous page in history. Use browser_navigate.");
      await settle(page);
      return outcomeOf(page);
    });
  }

  async goForward(): Promise<ActionOutcome> {
    return this.run(async (page) => {
      const response = await page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 });
      if (response === null) throw new Error("No next page in history. Use browser_navigate.");
      await settle(page);
      return outcomeOf(page);
    });
  }

  async reload(): Promise<ActionOutcome> {
    return this.run(async (page) => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
      return outcomeOf(page);
    });
  }

  async snapshot(opts?: { textOnly?: boolean }): Promise<SnapshotOutcome> {
    return this.run((page) => readSnapshot(page, opts?.textOnly === true));
  }

  async click(
    ref: string,
    opts?: { button?: "left" | "right"; clickCount?: 1 | 2 },
  ): Promise<ActionOutcome> {
    return this.run(async (page) => {
      const locator = locatorFor(page, ref);
      if ((await locator.count()) === 0) {
        throw new Error(`ref "${ref}" is stale: no element has that ref. Call browser_snapshot.`);
      }
      await locator.click({
        timeout: 5000,
        ...(opts?.button !== undefined ? { button: opts.button } : {}),
        ...(opts?.clickCount !== undefined ? { clickCount: opts.clickCount } : {}),
      });
      await settle(page);
      return outcomeOf(page);
    });
  }

  async type(ref: string, text: string, opts?: { submit?: boolean }): Promise<ActionOutcome> {
    return this.run(async (page) => {
      const locator = locatorFor(page, ref);
      if ((await locator.count()) === 0) {
        throw new Error(`ref "${ref}" is stale: no element has that ref. Call browser_snapshot.`);
      }
      await locator.fill(text, { timeout: 5000 });
      if (opts?.submit === true) await page.keyboard.press("Enter");
      await settle(page);
      return outcomeOf(page);
    });
  }

  async pressKey(key: string): Promise<ActionOutcome> {
    return this.run(async (page) => {
      await page.keyboard.press(key);
      await settle(page);
      return outcomeOf(page);
    });
  }

  async waitFor(opts: { text?: string; timeoutMs?: number }): Promise<ActionOutcome> {
    return this.run(async (page) => {
      const timeout = opts.timeoutMs ?? 5000;
      if (opts.text !== undefined) {
        await page.getByText(opts.text, { exact: false }).first().waitFor({
          state: "visible",
          timeout,
        });
      } else {
        await page.waitForTimeout(timeout);
      }
      return outcomeOf(page);
    });
  }

  async screenshot(opts?: { fullPage?: boolean }): Promise<BrowserScreenshot> {
    return this.run(async (page) => {
      const data = await page.screenshot({
        type: "png",
        fullPage: opts?.fullPage === true,
      });
      const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
      return { data: data.toString("base64"), width: viewport.width, height: viewport.height };
    });
  }

  async diagnostics(opts: BrowserDiagnosticsOptions): Promise<DiagnosticsOutcome> {
    return this.run(async () => this.entry.diagnostics.format(opts.kind, {
      ...(opts.level !== undefined ? { level: opts.level } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    }));
  }

  async storageState(_action: "save"): Promise<StorageStateOutcome> {
    return this.run(async () => {
      if (this.storageStatePath === undefined) {
        throw new Error(
          "No browser.storageStatePath is configured. Set it in config.json before saving a storage state.",
        );
      }
      const { context } = await this.host.ensure(this.entry);
      const directory = path.dirname(this.storageStatePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700).catch(() => undefined);
      // Create the file with restrictive permissions before Playwright writes
      // into it, so the cookie payload is never briefly world-readable.
      await writeFile(this.storageStatePath, "", { mode: 0o600 });
      await context.storageState({ path: this.storageStatePath });
      await chmod(this.storageStatePath, 0o600);
      return { path: this.storageStatePath, savedAt: Date.now() };
    });
  }

  async close(): Promise<void> {
    await this.host.close(this.entry.id);
  }
}

export function createNodeBrowserHost(opts: BrowserHostOptions = {}): BrowserHost {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 600_000;
  const maxContexts = opts.maxContexts ?? 4;
  const storageStatePath =
    opts.storageStatePath !== undefined ? expandHome(opts.storageStatePath, os.homedir()) : undefined;
  const sessions = new Map<string, SessionEntry>();
  let browserPromise: Promise<Browser> | undefined;
  let disposed = false;

  async function ensureBrowser(): Promise<Browser> {
    if (disposed) throw new Error("Browser host has been disposed.");
    browserPromise ??= (async () => {
      let playwright: typeof import("playwright");
      try {
        playwright = await import("playwright");
      } catch {
        throw new BrowserUnavailableError();
      }
      const headless = resolveHeadless(opts.headless, process.env, process.platform);
      if (opts.headless === undefined && headless && process.platform === "linux") {
        console.warn("browser: no DISPLAY/WAYLAND_DISPLAY found; running Chromium headless");
      }
      return playwright.chromium.launch({
        headless,
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      });
    })().catch((error: unknown) => {
      browserPromise = undefined;
      throw error;
    });
    return browserPromise;
  }

  async function ensure(entry: SessionEntry): Promise<{ context: BrowserContext; page: Page }> {
    if (entry.closed) {
      throw new Error("Browser session closed. Use a browser tool again to start a new page.");
    }
    if (entry.crashed && entry.context !== undefined) {
      const crashed = entry.context;
      entry.context = undefined;
      entry.page = undefined;
      entry.ready = undefined;
      entry.crashed = false;
      await crashed.close().catch(() => undefined);
    }
    if (entry.context !== undefined && entry.page !== undefined) {
      return { context: entry.context, page: entry.page };
    }
    entry.ready ??= (async () => {
      const browser = await ensureBrowser();
      const storageState =
        storageStatePath !== undefined && existsSync(storageStatePath) ? storageStatePath : undefined;
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ...(storageState !== undefined ? { storageState } : {}),
      });
      const page = await context.newPage();
      if (entry.closed) {
        await context.close().catch(() => undefined);
        throw new Error("Browser session closed. Use a browser tool again to start a new page.");
      }
      entry.context = context;
      entry.page = page;
      attachDiagnostics(entry, page);
      attachNavigationPolicy(entry, page);
      page.on("crash", () => {
        entry.crashed = true;
      });
      return { context, page };
    })().catch((error: unknown) => {
      entry.ready = undefined;
      throw error;
    });
    return entry.ready;
  }

  function attachDiagnostics(entry: SessionEntry, page: Page): void {
    page.on("console", (message) => {
      const type = message.type();
      const level = type === "error" ? "error" : type === "warning" ? "warning" : "info";
      entry.diagnostics.console(level, message.text());
    });
    page.on("pageerror", (error) => {
      entry.diagnostics.console("error", error.message);
    });
    page.on("requestfailed", (request) => {
      entry.diagnostics.networkFailure(
        request.method(),
        request.url(),
        request.failure()?.errorText ?? "failed",
      );
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        entry.diagnostics.networkStatus(response.status(), response.request().method(), response.url());
      }
    });
  }

  function attachNavigationPolicy(entry: SessionEntry, page: Page): void {
    void page.context().route("**/*", async (route) => {
      const request = route.request();
      if (!request.isNavigationRequest()) {
        await route.continue();
        return;
      }
      let isTopLevel = false;
      try {
        // Any page's main frame is top-level; an iframe has a parent frame.
        // A target=_blank/window.open page is a separate page in this context,
        // so comparing against `page.mainFrame()` alone would miss it.
        isTopLevel = request.frame().parentFrame() === null;
      } catch {
        // A detached/unknown frame is treated as top-level: fail closed rather
        // than letting a popup navigation escape the egress check.
        isTopLevel = true;
      }
      if (!isTopLevel) {
        await route.continue();
        return;
      }
      if (!isNavigationAllowed(request.url(), entry.egressPolicy)) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
  }

  function touch(entry: SessionEntry): void {
    entry.lastUsed = Date.now();
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void close(entry.id);
    }, idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  async function close(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return;
    sessions.delete(sessionId);
    entry.closed = true;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    const context = entry.context;
    entry.context = undefined;
    entry.page = undefined;
    if (context !== undefined) {
      await context.close().catch(() => undefined);
    }
  }

  function evictIfNeeded(): void {
    while (sessions.size > maxContexts) {
      let oldest: SessionEntry | undefined;
      for (const entry of sessions.values()) {
        if (oldest === undefined || entry.lastUsed < oldest.lastUsed) oldest = entry;
      }
      if (oldest === undefined) return;
      void close(oldest.id);
    }
  }

  function page(sessionId: string, pageOpts: PageOptions = {}): LiveBrowserPage {
    if (disposed) throw new Error("Browser host has been disposed.");
    let entry = sessions.get(sessionId);
    if (entry?.closed === true) {
      sessions.delete(sessionId);
      entry = undefined;
    }
    if (entry === undefined) {
      const diagnostics = createDiagnosticsBuffer(200);
      const created: SessionEntry = {
        id: sessionId,
        queue: createSerialQueue(),
        diagnostics,
        live: undefined as unknown as LivePage,
        egressPolicy: pageOpts.egressPolicy ?? undefined,
        lastUsed: Date.now(),
        crashed: false,
        closed: false,
      };
      created.live = new LivePage(created, { ensure, touch, close }, storageStatePath);
      sessions.set(sessionId, created);
      entry = created;
      evictIfNeeded();
    } else if (Object.prototype.hasOwnProperty.call(pageOpts, "egressPolicy")) {
      entry.egressPolicy = pageOpts.egressPolicy ?? undefined;
    }
    touch(entry);
    return entry.live;
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const ids = [...sessions.keys()];
    await Promise.all(ids.map((id) => close(id)));
    const browser = browserPromise === undefined ? undefined : await browserPromise.catch(() => undefined);
    browserPromise = undefined;
    await browser?.close().catch(() => undefined);
  }

  return { page, close, dispose };
}