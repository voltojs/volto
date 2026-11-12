import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectSystemBrowsers,
  resolveBrowserExecutable,
  systemBrowserCandidates,
  systemBrowsers,
} from "../browser-executable.js";

describe("systemBrowserCandidates", () => {
  it("lists common macOS Chrome/Chromium/Edge locations", () => {
    const candidates = systemBrowserCandidates("darwin", {});
    expect(candidates).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(candidates).toContain("/Applications/Chromium.app/Contents/MacOS/Chromium");
    expect(candidates.some((path) => path.includes("Microsoft Edge"))).toBe(true);
  });

  it("lists common Linux executables and Windows paths", () => {
    expect(systemBrowserCandidates("linux", {})).toContain("/usr/bin/google-chrome");
    expect(systemBrowserCandidates("win32", { ProgramFiles: "C:\\Program Files" })).toContain(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    );
  });
});

describe("systemBrowsers", () => {
  it("labels the macOS catalog", () => {
    const browsers = systemBrowsers("darwin", {});
    expect(browsers.map((browser) => browser.label)).toEqual([
      "Google Chrome",
      "Google Chrome",
      "Chromium",
      "Microsoft Edge",
      "Brave Browser",
    ]);
    expect(browsers[0]?.path).toContain("Google Chrome.app");
  });

  it("labels the Linux catalog and detects only installed browsers", async () => {
    const all = systemBrowsers("linux", {});
    expect(all[0]).toEqual({
      id: "chrome",
      label: "Google Chrome",
      path: "/usr/bin/google-chrome",
    });
    const detected = await detectSystemBrowsers({
      platform: "linux",
      env: {},
      exists: async (candidate) => candidate === "/usr/bin/chromium",
    });
    expect(detected).toEqual([
      { id: "chromium", label: "Chromium", path: "/usr/bin/chromium" },
    ]);
  });
});

describe("resolveBrowserExecutable", () => {
  it("prefers an explicit configured path", async () => {
    const resolved = await resolveBrowserExecutable({
      configured: "/opt/my-chrome",
      platform: "linux",
      env: {},
      exists: async (path) => path === "/opt/my-chrome",
    });
    expect(resolved).toBe("/opt/my-chrome");
  });

  it("returns undefined when the configured path is missing", async () => {
    await expect(
      resolveBrowserExecutable({ configured: "/missing", platform: "linux", exists: async () => false }),
    ).resolves.toBeUndefined();
  });

  it("rejects a directory even though it is executable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-browser-dir-"));
    try {
      await expect(resolveBrowserExecutable({ configured: dir })).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the first installed system browser", async () => {
    const resolved = await resolveBrowserExecutable({
      platform: "linux",
      env: {},
      exists: async (path) => path === "/usr/bin/chromium",
    });
    expect(resolved).toBe("/usr/bin/chromium");
  });
});
