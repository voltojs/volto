import { describe, expect, it } from "vitest";
import {
  BrowserUnavailableError,
  createSerialQueue,
  expandHome,
  isNavigationAllowed,
  resolveHeadless,
} from "../browser-host.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("resolveHeadless", () => {
  it("defaults to headed off Linux", () => {
    expect(resolveHeadless(undefined, {}, "darwin")).toBe(false);
    expect(resolveHeadless(undefined, {}, "win32")).toBe(false);
  });

  it("falls back to headless on Linux without a display", () => {
    expect(resolveHeadless(undefined, {}, "linux")).toBe(true);
    expect(resolveHeadless(undefined, { DISPLAY: ":0" }, "linux")).toBe(false);
    expect(resolveHeadless(undefined, { WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false);
  });

  it("honours an explicit choice even without a display", () => {
    expect(resolveHeadless(false, {}, "linux")).toBe(false);
    expect(resolveHeadless(true, { DISPLAY: ":0" }, "linux")).toBe(true);
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/ paths", () => {
    expect(expandHome("~", "/home/leo")).toBe("/home/leo");
    expect(expandHome("~/browser/auth.json", "/home/leo")).toBe("/home/leo/browser/auth.json");
    expect(expandHome("/tmp/auth.json", "/home/leo")).toBe("/tmp/auth.json");
  });
});

describe("createSerialQueue", () => {
  it("runs tasks in enqueue order even when the first is slow", async () => {
    const queue = createSerialQueue();
    const order: number[] = [];
    const first = queue(async () => {
      await delay(20);
      order.push(1);
      return "a";
    });
    const second = queue(async () => {
      order.push(2);
      return "b";
    });
    await expect(first).resolves.toBe("a");
    await expect(second).resolves.toBe("b");
    expect(order).toEqual([1, 2]);
  });

  it("keeps running after a rejected task", async () => {
    const queue = createSerialQueue();
    await expect(queue(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(queue(async () => "ok")).resolves.toBe("ok");
  });
});

describe("BrowserUnavailableError", () => {
  it("tells the user how to install Chromium", () => {
    const error = new BrowserUnavailableError();
    expect(error.name).toBe("BrowserUnavailableError");
    expect(error.message).toContain("playwright install chromium");
  });
});

describe("isNavigationAllowed", () => {
  it("allows http(s) and about:blank", () => {
    expect(isNavigationAllowed("https://example.com/a", undefined)).toBe(true);
    expect(isNavigationAllowed("http://localhost:5173/", undefined)).toBe(true);
    expect(isNavigationAllowed("about:blank", undefined)).toBe(true);
  });

  it("rejects non-http schemes, credentials, and metadata hosts", () => {
    expect(isNavigationAllowed("file:///etc/passwd", undefined)).toBe(false);
    expect(isNavigationAllowed("javascript:alert(1)", undefined)).toBe(false);
    expect(isNavigationAllowed("https://user:pass@example.com/", undefined)).toBe(false);
    expect(isNavigationAllowed("http://169.254.169.254/latest/meta-data", undefined)).toBe(false);
    expect(isNavigationAllowed("http://100.100.100.200/", undefined)).toBe(false);
  });

  it("applies the egress policy", () => {
    expect(isNavigationAllowed("https://example.com/", { denyHosts: ["example.com"] })).toBe(false);
    expect(isNavigationAllowed("https://example.com/", { allowHosts: ["other.com"] })).toBe(false);
    expect(isNavigationAllowed("https://example.com/", { allowHosts: ["example.com"] })).toBe(true);
  });
});