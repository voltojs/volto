import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { getConfigPath } from "../config/paths.js";
import { getConfigStore } from "../config/store.js";
import { startRouteTestServer } from "./helpers.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const authJson = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function readBrowserSection(): Promise<Record<string, unknown> | undefined> {
  const file = getConfigPath("config.json");
  const document = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  return document["browser"] as Record<string, unknown> | undefined;
}

describe("/config/browser", () => {
  afterEach(async () => {
    // startRouteTestServer cleans its own temp dir in its close handler.
  });

  it("returns the gateway platform, current path, and detected browsers", async () => {
    const { url, token, close } = await startRouteTestServer();
    try {
      const res = await fetch(`${url}/config/browser`, { headers: auth(token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        platform: string;
        configuredPath: string | null;
        resolvedPath: string | null;
        browsers: Array<{ id: string; label: string; path: string }>;
      };
      expect(body.platform).toBe(process.platform);
      expect(body.configuredPath).toBeNull();
      expect(Array.isArray(body.browsers)).toBe(true);
      for (const browser of body.browsers) {
        expect(typeof browser.id).toBe("string");
        expect(typeof browser.label).toBe("string");
        expect(typeof browser.path).toBe("string");
      }
    } finally {
      await close();
    }
  });

  it("persists executablePath in config.json", async () => {
    const { url, token, close } = await startRouteTestServer();
    try {
      const put = await fetch(`${url}/config/browser`, {
        method: "PUT",
        headers: authJson(token),
        body: JSON.stringify({ executablePath: process.execPath }),
      });
      expect(put.status).toBe(200);
      const body = (await put.json()) as { configuredPath: string | null };
      expect(body.configuredPath).toBe(process.execPath);
      await expect(readBrowserSection()).resolves.toMatchObject({
        executablePath: process.execPath,
      });
    } finally {
      await close();
    }
  });

  it("preserves unrelated browser keys", async () => {
    const { url, token, close } = await startRouteTestServer();
    try {
      await getConfigStore().update("browser", (current) => ({
        ...(typeof current === "object" && current !== null ? current : {}),
        headless: true,
        idleTimeoutMs: 1234,
      }));
      const put = await fetch(`${url}/config/browser`, {
        method: "PUT",
        headers: authJson(token),
        body: JSON.stringify({ executablePath: process.execPath }),
      });
      expect(put.status).toBe(200);
      await expect(readBrowserSection()).resolves.toMatchObject({
        executablePath: process.execPath,
        headless: true,
        idleTimeoutMs: 1234,
      });
    } finally {
      await close();
    }
  });

  it("removes the key when executablePath is null", async () => {
    const { url, token, close } = await startRouteTestServer();
    try {
      await getConfigStore().update("browser", () => ({
        executablePath: process.execPath,
        headless: true,
      }));
      const put = await fetch(`${url}/config/browser`, {
        method: "PUT",
        headers: authJson(token),
        body: JSON.stringify({ executablePath: null }),
      });
      expect(put.status).toBe(200);
      const section = await readBrowserSection();
      expect(section).not.toHaveProperty("executablePath");
      expect(section?.["headless"]).toBe(true);
    } finally {
      await close();
    }
  });

  it("rejects a missing path with 400 without writing", async () => {
    const { url, token, close } = await startRouteTestServer();
    try {
      const put = await fetch(`${url}/config/browser`, {
        method: "PUT",
        headers: authJson(token),
        body: JSON.stringify({ executablePath: "/definitely/missing/browser" }),
      });
      expect(put.status).toBe(400);
      expect(await readBrowserSection().catch(() => undefined)).not.toMatchObject({
        executablePath: "/definitely/missing/browser",
      });
    } finally {
      await close();
    }
  });

  it("requires auth", async () => {
    const { url, close } = await startRouteTestServer();
    try {
      expect((await fetch(`${url}/config/browser`)).status).toBe(401);
      expect(
        (await fetch(`${url}/config/browser`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ executablePath: process.execPath }),
        })).status,
      ).toBe(401);
    } finally {
      await close();
    }
  });
});
