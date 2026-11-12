import { describe, expect, it } from "vitest";
import {
  BrowserUnavailableError,
  createSerialQueue,
  expandHome,
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