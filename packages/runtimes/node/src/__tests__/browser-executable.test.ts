import { describe, expect, it } from "vitest";
import { resolveBrowserExecutable, systemBrowserCandidates } from "../browser-executable.js";

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

  it("falls back to the first installed system browser", async () => {
    const resolved = await resolveBrowserExecutable({
      platform: "linux",
      env: {},
      exists: async (path) => path === "/usr/bin/chromium",
    });
    expect(resolved).toBe("/usr/bin/chromium");
  });
});
