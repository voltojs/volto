/**
 * `volto web` — the exported UI served beside a reverse proxy to a gateway.
 *
 * Two deployments share one browser origin, so what matters here is the
 * boundary between them, not the static reader (already covered by
 * `static-site.test.ts`):
 *
 * - An API path is proxied, a page path is served from the web root.
 * - SSE is STREAMED: the first frame must reach the client before the
 *   upstream has even produced the second one. A buffering proxy passes every
 *   status/body assertion and still breaks every live turn, so the streaming
 *   case holds the first frame back until the client has already read it.
 * - The proxy forwards method, headers (minus `host`), body, and preserves
 *   `Set-Cookie` and the upstream status.
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { API_PREFIXES, startWebServer } from "../web-server.js";

/** Every server this file opens, so none outlives its case. */
const open: Array<http.Server | { close(): Promise<void> }> = [];

afterEach(async () => {
  for (const server of open.splice(0)) {
    await new Promise<void>((resolve) => {
      const closed = typeof (server as http.Server).closeAllConnections === "function";
      (server as http.Server).close(() => resolve());
      if (closed) (server as http.Server).closeAllConnections();
    });
  }
});

function portOf(server: { address(): unknown }): number {
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("server is not listening");
  return (address as { port: number }).port;
}

async function listen(server: http.Server): Promise<number> {
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return portOf(server);
}

async function webFor(gateway: string, webRoot = "/nonexistent"): Promise<number> {
  const web = await startWebServer({ port: 0, gateway, webRoot });
  open.push(web);
  return portOf(web);
}

/** A temp web root with the exported app's shell and one hashed asset. */
async function webFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "volto-web-proxy-"));
  await fs.writeFile(path.join(root, "index.html"), "<html>shell</html>");
  await fs.mkdir(path.join(root, "_next/static/chunks"), { recursive: true });
  await fs.writeFile(path.join(root, "_next/static/chunks/a.js"), "console.log(1)");
  return root;
}

it("API 路径转发到网关且不缓冲流", async () => {
  // The first frame is written immediately; the second ONLY after the client
  // has read the first. A proxy that buffered the body would wait for `end`,
  // which never comes until the client has read — so this deadlocks (and the
  // case times out) instead of passing on a buffered implementation.
  let releaseSecond: () => void = () => {};
  const secondAllowed = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const gateway = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    void secondAllowed.then(() => {
      res.write("data: two\n\n");
      res.end();
    });
  });
  const gatewayPort = await listen(gateway);
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`);

  const res = await fetch(`http://127.0.0.1:${webPort}/events?sessionId=a`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("data: one");

  // Only now may the upstream finish; the rest still flows through.
  releaseSecond();
  let rest = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += new TextDecoder().decode(chunk.value);
  }
  expect(rest).toContain("data: two");
  res.body?.cancel().catch(() => undefined);
});

it("静态文件从 web 根目录提供，未知路径 404", async () => {
  const webRoot = await webFixture();
  const webPort = await webFor("http://127.0.0.1:1", webRoot); // gateway never dialled here

  const home = await fetch(`http://127.0.0.1:${webPort}/`);
  expect(home.status).toBe(200);
  expect(home.headers.get("content-type")).toContain("text/html");
  expect(await home.text()).toContain("shell");

  // A client-side deep link renders the single-page shell. `/ui/...` is not
  // an API root: every API root is proxied, and `/sessions` is one of them.
  const deep = await fetch(`http://127.0.0.1:${webPort}/ui/abc`);
  expect(deep.status).toBe(200);
  expect(await deep.text()).toContain("shell");

  const asset = await fetch(`http://127.0.0.1:${webPort}/_next/static/chunks/a.js`);
  expect(asset.status).toBe(200);
  expect(await asset.text()).toBe("console.log(1)");

  const missing = await fetch(`http://127.0.0.1:${webPort}/nope.txt`);
  expect(missing.status).toBe(404);
});

it("透传方法、头和 body，保留状态码、Set-Cookie 与响应头", async () => {
  const seen: Array<{ method?: string; host?: string; cookie?: string; body: string }> = [];
  const gateway = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        host: req.headers.host,
        cookie: req.headers.cookie,
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      res.writeHead(201, {
        "content-type": "application/json",
        "set-cookie": ["volto_auth=abc; Path=/; HttpOnly", "other=1; Path=/"],
        "x-upstream": "yes",
      });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const gatewayPort = await listen(gateway);
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`);

  const res = await fetch(`http://127.0.0.1:${webPort}/messages?x=1`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "volto_auth=abc" },
    body: JSON.stringify({ hello: "world" }),
  });

  expect(res.status).toBe(201);
  expect(res.headers.get("x-upstream")).toBe("yes");
  expect(res.headers.getSetCookie()).toEqual([
    "volto_auth=abc; Path=/; HttpOnly",
    "other=1; Path=/",
  ]);
  expect(await res.json()).toEqual({ ok: true });
  // The client's own `Host` rides along (the gateway's Origin/Host check
  // compares the values the browser sent); nothing else is dropped.
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ method: "POST", cookie: "volto_auth=abc" });
  expect(seen[0]?.host).toBe(`127.0.0.1:${webPort}`);
  expect(seen[0]?.body).toBe(JSON.stringify({ hello: "world" }));
});

it("网关连不上时返回 502 与短 JSON", async () => {
  // A port nothing listens on: bind one, read it, then release it.
  const probe = http.createServer();
  const deadPort = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  open.splice(open.indexOf(probe), 1);

  const webPort = await webFor(`http://127.0.0.1:${deadPort}`);
  const res = await fetch(`http://127.0.0.1:${webPort}/health`);
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: string };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.length).toBeLessThan(120);
});

it("每个 API 根都被代理（含前缀子路径），不被静态托管吞掉", async () => {
  const gateway = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
  });
  const gatewayPort = await listen(gateway);
  // An EMPTY web root would answer 503 for the shell; every asserted path must
  // therefore reach the gateway, never the static reader.
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`, "/nonexistent");

  expect(API_PREFIXES.length).toBeGreaterThan(0);
  for (const prefix of API_PREFIXES) {
    for (const target of [prefix, `${prefix}/deep/path.js`]) {
      const res = await fetch(`http://127.0.0.1:${webPort}${target}`);
      expect(res.status, target).toBe(401);
      await res.arrayBuffer();
    }
  }
});