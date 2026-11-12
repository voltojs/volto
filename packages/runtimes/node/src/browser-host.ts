/**
 * Node browser host — one Chromium process, one isolated context per chat
 * session, lazy page creation, serialized actions, and idle/LRU eviction.
 *
 * Playwright is an optional peer dependency: the host imports it only when a
 * page is first needed. A missing install is reported as
 * BrowserUnavailableError with the install command, never as a crash.
 */

import { existsSync } from "node:fs";
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
  SnapshotOutcome,
  StorageStateOutcome,
} from "@volto/tools-browser";
import type { EgressPolicy } from "./egress.js";

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
  egressPolicy?: EgressPolicy;
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

interface SessionEntry {
  readonly id: string;
  readonly queue: ReturnType<typeof createSerialQueue>;
  live: LivePage;
  context?: BrowserContext;
  page?: Page;
  ready?: Promise<{ context: BrowserContext; page: Page }>;
  egressPolicy?: EgressPolicy;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
}

class LivePage implements LiveBrowserPage {
  private readonly entry: SessionEntry;
  private readonly host: {
    ensure(entry: SessionEntry): Promise<{ context: BrowserContext; page: Page }>;
    touch(entry: SessionEntry): void;
    close(sessionId: string): Promise<void>;
  };

  constructor(
    entry: SessionEntry,
    host: {
      ensure(entry: SessionEntry): Promise<{ context: BrowserContext; page: Page }>;
      touch(entry: SessionEntry): void;
      close(sessionId: string): Promise<void>;
    },
  ) {
    this.entry = entry;
    this.host = host;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    this.host.touch(this.entry);
    return this.entry.queue(fn);
  }

  private async page(): Promise<Page> {
    const { page } = await this.host.ensure(this.entry);
    return page;
  }

  private async unimplemented(): Promise<never> {
    await this.page();
    throw new Error("browser host action not implemented yet");
  }

  async state(): Promise<BrowserState> {
    return this.run(async () => {
      const page = await this.page();
      return {
        url: page.url(),
        title: await page.title(),
        status: "live",
        viewport: { width: 1280, height: 800 },
      };
    });
  }

  async navigate(_url: string): Promise<ActionOutcome> {
    return this.unimplemented();
  }

  async goBack(): Promise<ActionOutcome> {
    return this.unimplemented();
  }

  async goForward(): Promise<ActionOutcome> {
    return this.unimplemented();
  }

  async reload(): Promise<ActionOutcome> {
    return this.unimplemented();
  }

  async snapshot(_opts?: { textOnly?: boolean }): Promise<SnapshotOutcome> {
    return this.unimplemented();
  }

  async click(_ref: string, _opts?: { button?: "left" | "right"; clickCount?: 1 | 2 }): Promise<ActionOutcome> {
    return this.unimplemented();
  }

  async type(_ref: string, _text: string, _opts?: { submit?: boolean }): Promise<ActionOutcome> {
    return this.unimplemented();
  }

  async pressKey(_key: string): Promise<ActionOutcome> {
    return this.unimplemented();
  }

  async waitFor(_opts: { text?: string; timeoutMs?: number }): Promise<ActionOutcome> {
    return this.unimplemented();
  }

  async screenshot(_opts?: { fullPage?: boolean }): Promise<BrowserScreenshot> {
    return this.unimplemented();
  }

  async diagnostics(_opts: BrowserDiagnosticsOptions): Promise<DiagnosticsOutcome> {
    return this.unimplemented();
  }

  async storageState(_action: "save"): Promise<StorageStateOutcome> {
    return this.unimplemented();
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
      return playwright.chromium.launch({
        headless: resolveHeadless(opts.headless, process.env, process.platform),
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      });
    })();
    return browserPromise;
  }

  async function ensure(entry: SessionEntry): Promise<{ context: BrowserContext; page: Page }> {
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
      entry.context = context;
      entry.page = page;
      return { context, page };
    })();
    return entry.ready;
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
    if (entry === undefined) {
      const created: SessionEntry = {
        id: sessionId,
        queue: createSerialQueue(),
        live: undefined as unknown as LivePage,
        egressPolicy: pageOpts.egressPolicy,
        lastUsed: Date.now(),
      };
      created.live = new LivePage(created, { ensure, touch, close });
      sessions.set(sessionId, created);
      entry = created;
      evictIfNeeded();
    } else if (pageOpts.egressPolicy !== undefined) {
      entry.egressPolicy = pageOpts.egressPolicy;
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