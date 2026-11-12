import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { startRouteTestServer } from "./helpers.js";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function boot() {
  const server = await startRouteTestServer();
  close = server.close;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` };
  return { server, headers };
}

describe("GET/PUT /sidebar-state", () => {
  it("returns the default document before anything is written", async () => {
    const { server, headers } = await boot();
    const res = await fetch(`${server.url}/sidebar-state`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sidebar: { pinnedSessionIds: string[]; sortModes: unknown; expandedProjectIds?: string[] };
    };
    expect(body.sidebar.pinnedSessionIds).toEqual([]);
    expect(body.sidebar.sortModes).toEqual({ pinned: "manual", projects: "manual" });
    expect(body.sidebar.expandedProjectIds).toBeUndefined();
  });

  it("round-trips a document and persists it to config.json", async () => {
    const { server, headers } = await boot();
    const doc = {
      pinnedSessionIds: ["s-2", "s-1"],
      projectOrder: ["p-1"],
      sortModes: { pinned: "recent", projects: "name" },
      expandedProjectIds: [],
      pinnedCollapsed: true,
      projectsCollapsed: false,
    };
    const put = await fetch(`${server.url}/sidebar-state`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ sidebar: doc }),
    });
    expect(put.status).toBe(200);
    const get = await fetch(`${server.url}/sidebar-state`, { headers });
    expect(((await get.json()) as { sidebar: unknown }).sidebar).toEqual(doc);
    const configDir = process.env["VOLTO_CONFIG_DIR"]!; // set by startRouteTestServer
    const onDisk = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8"));
    expect(onDisk.sidebar.expandedProjectIds).toEqual([]);
  });

  it("rejects invalid documents with 400 and leaves the file untouched", async () => {
    const { server, headers } = await boot();
    const bad = [
      { sidebar: { sortModes: { pinned: "name" } } },
      { sidebar: { pinnedSessionIds: ["ok", 3] } },
      { sidebar: { pinnedSessionIds: Array.from({ length: 501 }, (_, i) => `s-${i}`) } },
      {},
    ];
    for (const body of bad) {
      const res = await fetch(`${server.url}/sidebar-state`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error?: unknown }).error).toBe("string");
    }
    const get = await fetch(`${server.url}/sidebar-state`, { headers });
    expect(((await get.json()) as { sidebar: { pinnedSessionIds: string[] } }).sidebar.pinnedSessionIds).toEqual([]);
  });
});