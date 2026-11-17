import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { probeGateway } from "../probe";

interface TestServer {
  url: string;
  requests: Array<{ path: string; authorization?: string }>;
  close(): Promise<void>;
}

async function serve(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const requests: TestServer["requests"] = [];
  server.on("request", (req) => {
    requests.push({
      path: req.url ?? "",
      ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}),
    });
  });
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(status: number, body: unknown): http.RequestListener {
  return (_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(handler: http.RequestListener): Promise<TestServer> {
  const server = await serve(handler);
  servers.push(server);
  return server;
}

describe("probeGateway", () => {
  it("reports version and mode from an authenticated gateway", async () => {
    const server = await start((req, res) => {
      if (req.url === "/health") return json(200, { status: "ok" })(req, res);
      if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<html></html>");
      }
      if (req.url === "/gateway-info") return json(200, { version: "0.2.1", mode: "remote" })(req, res);
      res.writeHead(404);
      res.end();
    });

    const result = await probeGateway(server.url, "secret");
    expect(result).toEqual({ ok: true, version: "0.2.1", mode: "remote" });
    const info = server.requests.find((entry) => entry.path === "/gateway-info");
    expect(info?.authorization).toBe("Bearer secret");
  });

  it("does not call /gateway-info when there is no token", async () => {
    const server = await start((req, res) => {
      if (req.url === "/health") return json(200, { status: "ok" })(req, res);
      if (req.url === "/") {
        res.writeHead(200);
        return res.end("ok");
      }
      res.writeHead(500);
      res.end();
    });

    expect(await probeGateway(server.url, undefined)).toEqual({ ok: true });
    expect(server.requests.some((entry) => entry.path === "/gateway-info")).toBe(false);
  });

  it("reports an unreachable gateway", async () => {
    const result = await probeGateway("http://127.0.0.1:1", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("无法连接网关");
  });

  it("reports a non-200 health response", async () => {
    const server = await start(json(500, { status: "broken" }));
    const result = await probeGateway(server.url, undefined);
    expect(result).toEqual({ ok: false, error: "无法连接网关：HTTP 500" });
  });

  it("reports a missing web build instead of a silent blank window", async () => {
    const server = await start((req, res) => {
      if (req.url === "/health") return json(200, { status: "ok" })(req, res);
      return json(503, { error: "Web app not found" })(req, res);
    });
    const result = await probeGateway(server.url, undefined);
    expect(result).toEqual({ ok: false, error: "网关没有可用的 Web UI（缺少 web 构建）" });
  });

  it("reports an invalid access token", async () => {
    const server = await start((req, res) => {
      if (req.url === "/health") return json(200, { status: "ok" })(req, res);
      if (req.url === "/") {
        res.writeHead(200);
        return res.end("ok");
      }
      return json(401, { error: "Unauthorized" })(req, res);
    });
    expect(await probeGateway(server.url, "bad")).toEqual({
      ok: false,
      error: "访问令牌无效或已过期",
    });
  });

  it("times out instead of hanging on a silent server", async () => {
    const server = await start(() => {
      // Never answer.
    });
    const result = await probeGateway(server.url, undefined, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("超时");
  });
});