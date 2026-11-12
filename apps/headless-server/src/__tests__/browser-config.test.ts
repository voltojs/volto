import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserConfigError, loadBrowserConfig } from "../config/browser.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-config-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeConfig(browser: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ version: 1, browser }), "utf-8");
}

describe("loadBrowserConfig", () => {
  it("returns the documented defaults when the section is absent", async () => {
    await expect(loadBrowserConfig(dir)).resolves.toEqual({
      enabled: true,
      headless: false,
      idleTimeoutMs: 600_000,
    });
  });

  it("reads enabled, headless, idle, storageStatePath, and executablePath", async () => {
    await writeConfig({
      enabled: false,
      headless: true,
      idleTimeoutMs: 1000,
      storageStatePath: "~/auth.json",
      executablePath: "/usr/bin/chromium",
    });
    await expect(loadBrowserConfig(dir)).resolves.toEqual({
      enabled: false,
      headless: true,
      idleTimeoutMs: 1000,
      storageStatePath: "~/auth.json",
      executablePath: "/usr/bin/chromium",
    });
  });

  it("rejects unknown keys instead of silently ignoring a typo", async () => {
    await writeConfig({ headles: true });
    await expect(loadBrowserConfig(dir)).rejects.toBeInstanceOf(BrowserConfigError);
    await expect(loadBrowserConfig(dir)).rejects.toThrow("headles");
  });

  it("rejects wrong types and non-positive idle timeouts", async () => {
    await writeConfig({ headless: "yes" });
    await expect(loadBrowserConfig(dir)).rejects.toBeInstanceOf(BrowserConfigError);
    await writeConfig({ idleTimeoutMs: 0 });
    await expect(loadBrowserConfig(dir)).rejects.toBeInstanceOf(BrowserConfigError);
  });
});
