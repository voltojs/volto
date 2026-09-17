import { describe, it, expect } from "vitest";
import { startRouteTestServer } from "./helpers.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("/agents", () => {
  it("lists entries with source, readOnly and shadowed", async () => {
    const { url, token, writeProjectAgent, writeUserAgent, close } = await startRouteTestServer();
    await writeUserAgent("dup", "user body");
    await writeProjectAgent("dup", "project body");
    await writeUserAgent("solo", "x");

    const res = await fetch(`${url}/agents`, { headers: auth(token) });
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };

    const dup = body.agents.filter((a) => a["name"] === "dup");
    expect(dup).toHaveLength(2);
    expect(dup.find((a) => a["scope"] === "project")).toMatchObject({ shadowed: false, readOnly: false });
    expect(dup.find((a) => a["scope"] === "user")).toMatchObject({ shadowed: true });
    expect(body.agents.find((a) => a["name"] === "solo")).toHaveProperty("filePath");
    await close();
  });

  it("creates a definition at the requested scope", async () => {
    const { url, token, close } = await startRouteTestServer();
    const res = await fetch(`${url}/agents`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ scope: "project", spec: { name: "fresh", description: "d" } }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "project:fresh", scope: "project" });
    await close();
  });

  it("updates and deletes a definition", async () => {
    const { url, token, writeProjectAgent, close } = await startRouteTestServer();
    await writeProjectAgent("edit-me", "body");

    const put = await fetch(`${url}/agents/project:edit-me`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ spec: { name: "edit-me", description: "updated" } }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ spec: { description: "updated" } });

    const del = await fetch(`${url}/agents/project:edit-me`, { method: "DELETE", headers: auth(token) });
    expect(del.status).toBe(204);
    await close();
  });

  it("refuses to modify a plugin-provided definition", async () => {
    const { url, token, close } = await startRouteTestServer({ pluginAgents: [{ name: "from-plugin" }] });
    const res = await fetch(`${url}/agents/plugin:from-plugin`, {
      method: "DELETE",
      headers: auth(token),
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toMatch(/plugin/i);
    await close();
  });

  it("404s on an unknown id", async () => {
    const { url, token, close } = await startRouteTestServer();
    const res = await fetch(`${url}/agents/project:ghost`, { method: "DELETE", headers: auth(token) });
    expect(res.status).toBe(404);
    await close();
  });

  it("requires authentication on every verb", async () => {
    const { url, close } = await startRouteTestServer();
    for (const [method, path] of [["GET", "/agents"], ["POST", "/agents"], ["PUT", "/agents/project:x"], ["DELETE", "/agents/project:x"]] as const) {
      const res = await fetch(`${url}${path}`, { method });
      expect(res.status).toBe(401);
    }
    await close();
  });
});
