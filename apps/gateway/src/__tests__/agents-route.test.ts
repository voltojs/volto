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

  it("lists the built-in types ahead of file definitions", async () => {
    const { url, token, writeUserAgent, close } = await startRouteTestServer();
    await writeUserAgent("mine", "x");

    const res = await fetch(`${url}/agents`, { headers: auth(token) });
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };

    const gp = body.agents.find((a) => a["name"] === "general-purpose");
    expect(gp).toMatchObject({ id: "builtin:general-purpose", scope: "builtin", builtIn: true, readOnly: false, shadowed: false });
    expect(body.agents.find((a) => a["name"] === "explore")).toMatchObject({ id: "builtin:explore", scope: "builtin" });
    // Built-ins head the list; the file row is not flagged as built-in.
    expect(body.agents[0]!["scope"]).toBe("builtin");
    expect(body.agents.find((a) => a["name"] === "mine")).not.toHaveProperty("builtIn");
    await close();
  });

  it("a same-named file definition replaces its built-in row", async () => {
    const { url, token, writeUserAgent, close } = await startRouteTestServer();
    await writeUserAgent("general-purpose", "custom generalist");

    const res = await fetch(`${url}/agents`, { headers: auth(token) });
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };

    expect(body.agents.find((a) => a["id"] === "builtin:general-purpose")).toBeUndefined();
    expect(body.agents.find((a) => a["name"] === "general-purpose")).toMatchObject({
      id: "user:general-purpose",
      scope: "user",
      builtIn: true,
      shadowed: false,
    });
    // The other built-in stays listed.
    expect(body.agents.find((a) => a["name"] === "explore")).toMatchObject({ scope: "builtin" });
    await close();
  });

  it("editing a built-in materializes a user-scope override file", async () => {
    const { url, token, close } = await startRouteTestServer();
    const put = await fetch(`${url}/agents/builtin:general-purpose`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ spec: { name: "hijacked", description: "d", model: "fast" } }),
    });
    expect(put.status).toBe(200);
    // The id pins the name — a built-in row customizes the type, never renames it.
    expect(await put.json()).toMatchObject({ id: "user:general-purpose", spec: { name: "general-purpose", model: "fast" } });

    const list = (await (await fetch(`${url}/agents`, { headers: auth(token) })).json()) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(list.agents.find((a) => a["id"] === "builtin:general-purpose")).toBeUndefined();
    expect(list.agents.find((a) => a["id"] === "user:general-purpose")).toMatchObject({ builtIn: true });
    await close();
  });

  it("refuses to delete a built-in or its override file", async () => {
    const { url, token, writeUserAgent, close } = await startRouteTestServer();
    await writeUserAgent("explore", "x");

    const delBuiltIn = await fetch(`${url}/agents/builtin:general-purpose`, { method: "DELETE", headers: auth(token) });
    expect(delBuiltIn.status).toBe(409);
    expect(JSON.stringify(await delBuiltIn.json())).toMatch(/built-in/i);

    const delOverride = await fetch(`${url}/agents/user:explore`, { method: "DELETE", headers: auth(token) });
    expect(delOverride.status).toBe(409);
    await close();
  });

  it("404s when PUT addresses a name that is not built-in", async () => {
    const { url, token, close } = await startRouteTestServer();
    const put = await fetch(`${url}/agents/builtin:ghost`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ spec: { name: "ghost" } }),
    });
    expect(put.status).toBe(404);
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
