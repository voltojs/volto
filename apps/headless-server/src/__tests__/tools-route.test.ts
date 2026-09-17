import { describe, it, expect } from "vitest";
// Harness helpers follow the existing route tests in this directory.
import { startRouteTestServer } from "./helpers.js";

describe("GET /tools", () => {
  it("lists tool names and descriptions", async () => {
    const { url, token, close } = await startRouteTestServer();
    const res = await fetch(`${url}/tools`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string; description: string }> };
    expect(body.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["read_file", "bash"]));
    expect(body.tools.find((t) => t.name === "read_file")?.description).toBeTruthy();
    await close();
  });

  it("requires authentication like every other route", async () => {
    const { url, close } = await startRouteTestServer();
    const res = await fetch(`${url}/tools`);
    expect(res.status).toBe(401);
    await close();
  });

  it("resolves tools against the requested project", async () => {
    const { url, token, projectId, close } = await startRouteTestServer();
    const res = await fetch(`${url}/tools?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    await close();
  });

  it("404s on an unknown projectId", async () => {
    const { url, token, close } = await startRouteTestServer();
    const res = await fetch(`${url}/tools?projectId=does-not-exist`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    await close();
  });
});
