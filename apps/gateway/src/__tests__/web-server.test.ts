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
import type { Duplex } from "node:stream";
import { gunzip, gzip } from "node:zlib";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { API_PREFIXES, startWebServer } from "../web-server.js";

/** Every server this file opens, so none outlives its case. */
const open: Array<http.Server | { close(): Promise<void> }> = [];

/** WebSocket clients opened by a case; they must not keep the process alive. */
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
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
  // The client's own `Host` rides along — deliberately. The gateway decides
  // same-origin with `new URL(Origin).host === Host`, so rewriting `Host` to
  // the gateway's own address would 403 every browser request made through
  // this proxy. Nothing else is dropped.
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
/**
 * Open a WS, collect messages, and resolve on the first message or error.
 * Every socket is registered above, so no case can leak one.
 */
function wsOnce(url: string): { socket: WebSocket; first: Promise<string | Error> } {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const first = new Promise<string | Error>((resolve) => {
    socket.once("message", (data: Buffer) => resolve(data.toString("utf-8")));
    // `unexpected-response` fires when the peer answers with a non-101; the
    // error alone would hide the status the proxy chose.
    socket.once("unexpected-response", (_req, res) => resolve(new Error(`HTTP ${res.statusCode}`)));
    socket.once("error", (err: Error) => resolve(err));
  });
  return { socket, first };
}

it("WebSocket 升级转发到网关并完成一次往返", async () => {
  const wss = new WebSocketServer({ noServer: true });
  const seen: Array<{ url?: string; host?: string }> = [];
  const gateway = http.createServer();
  gateway.on("upgrade", (req, socket, head) => {
    seen.push({ url: req.url, host: req.headers.host });
    wss.handleUpgrade(req, socket, head as Buffer, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  wss.on("connection", (ws) => {
    ws.on("message", (data: Buffer) => ws.send(`echo:${data.toString("utf-8")}`));
  });
  open.push(wss as unknown as http.Server);
  const gatewayPort = await listen(gateway);
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`);

  const { socket, first } = wsOnce(`ws://127.0.0.1:${webPort}/ws?sessionId=a`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send("hello");
  expect(await first).toBe("echo:hello");
  // Same-origin: the gateway sees the client's own Host, not its own address.
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/ws?sessionId=a");
  expect(seen[0]?.host).toBe(`127.0.0.1:${webPort}`);
});

it("未知路径的升级不会被隧道化", async () => {
  let upgrades = 0;
  const gateway = http.createServer();
  gateway.on("upgrade", (_req, socket: Duplex) => {
    upgrades += 1;
    socket.destroy();
  });
  const gatewayPort = await listen(gateway);
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`);

  const { first } = wsOnce(`ws://127.0.0.1:${webPort}/not-an-api/socket`);
  const outcome = await first;
  expect(outcome).toBeInstanceOf(Error);
  // The proxy refused it locally: Node's own 400 would mean no listener at
  // all, and a tunnel would have reached the gateway's upgrade listener.
  expect((outcome as Error).message).toMatch(/^HTTP 404$/);
  expect(upgrades).toBe(0);
});

it("网关压缩响应（声明长度与编码一致）原样透传，body 不被截断", async () => {
  const payload = "x".repeat(2048);
  const compressed = await new Promise<Buffer>((resolve, reject) => {
    gzip(payload, (err, out) => (err ? reject(err) : resolve(out)));
  });
  const gateway = http.createServer((req, res) => {
    req.resume();
    // A gateway that always gzips (whatever the client advertised) and
    // declares the COMPRESSED length — `Content-Length` counts the bytes on
    // the wire, which is exactly what this proxy forwards unchanged.
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-encoding": "gzip",
      "content-length": String(compressed.byteLength),
    });
    res.end(compressed);
  });
  const gatewayPort = await listen(gateway);
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`);

  // A raw response (no Node fetch, which would decompress and hide framing).
  const wire = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: Buffer }>((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port: webPort, path: "/health", headers: { "accept-encoding": "gzip" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      )
      .on("error", reject);
  });

  expect(wire.status).toBe(200);
  expect(wire.headers["content-encoding"]).toBe("gzip");
  expect(wire.headers["content-length"]).toBe(String(compressed.byteLength));
  expect(wire.raw.byteLength).toBe(compressed.byteLength);
  const decoded = await new Promise<Buffer>((resolve, reject) => {
    gunzip(wire.raw, (err, out) => (err ? reject(err) : resolve(out)));
  });
  expect(decoded.toString("utf-8")).toBe(payload);
});

/** A cookie-producing gateway: valid token → 302 + Set-Cookie, anything else → 401. */
async function guardGateway(validToken: string): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const gateway = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.push(`${url.pathname}${url.search}`);
    if (url.searchParams.get("token") === validToken) {
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": "volto_auth=cookie-value; HttpOnly; SameSite=Strict; Path=/",
      });
      res.end();
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
  });
  const port = await listen(gateway);
  return { port, seen };
}

it("带有效令牌访问 / 时转发到网关并拿回 302 + Set-Cookie", async () => {
  const webRoot = await webFixture();
  const { port: gatewayPort, seen } = await guardGateway("good");
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`, webRoot);

  // A raw client: fetch would follow the redirect and hide the 302.
  const wire = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: webPort, path: "/?token=good" }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      })
      .on("error", reject);
  });

  // The guard exchanged it — the local shell did NOT answer.
  expect(wire.status).toBe(302);
  expect(seen).toEqual(["/?token=good"]);
  // A relative `Location` is resolved against the WEB origin the browser is
  // on — which is the rewrite's whole point: the browser never learns the
  // gateway's address. (An absolute gateway URL would be rewritten to the web
  // origin explicitly — see the multi-cookie case in the header test.)
  expect(wire.headers["location"]).toBe("/");
  expect(new URL(wire.headers["location"] as string, `http://127.0.0.1:${webPort}`).origin).toBe(
    `http://127.0.0.1:${webPort}`,
  );
  // No Domain: the cookie is stored for this origin, which is where the
  // browser will send it back.
  const cookie = wire.headers["set-cookie"]?.[0] ?? "";
  expect(cookie.startsWith("volto_auth=cookie-value;")).toBe(true);
  expect(cookie).not.toMatch(/domain=/i);
});

it("已登录时带令牌访问深链接：`volto web` 原样转发网关的去令牌 302", async () => {
  // The cleanup happens at the gateway (it owns the cookie), and this proxy is
  // transparent to it: the 302 and its relative Location reach the browser on
  // the WEB origin, so the address bar is cleaned here too.
  const webRoot = await webFixture();
  const seen: string[] = [];
  const gateway = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/sessions/abc" && req.headers.cookie === "volto_auth=held") {
      res.writeHead(302, { Location: "/sessions/abc?tab=plan", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
  });
  const gatewayPort = await listen(gateway);
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`, webRoot);

  const wire = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port: webPort,
          path: "/sessions/abc?tab=plan&token=held-token",
          headers: { cookie: "volto_auth=held", "sec-fetch-mode": "navigate", accept: "text/html" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        },
      )
      .on("error", reject);
  });

  expect(wire.status).toBe(302);
  expect(wire.headers["location"]).toBe("/sessions/abc?tab=plan");
  expect(wire.headers["cache-control"]).toBe("no-store");
  expect(seen).toEqual(["/sessions/abc?tab=plan&token=held-token"]);
});

it("网关回绝对 Location 指向自己的 origin 时改写为 web origin", async () => {
  const webRoot = await webFixture();
  let gatewayPort = 0;
  const gateway = http.createServer((_req, res) => {
    // The realistic absolute form: a redirect naming the gateway's own
    // origin, which the browser cannot reach behind the tunnel.
    res.writeHead(302, { location: `http://127.0.0.1:${gatewayPort}/somewhere?x=1` });
    res.end();
  });
  gatewayPort = await listen(gateway);
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`, webRoot);

  const wire = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: webPort, path: "/health" }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      })
      .on("error", reject);
  });

  expect(wire.status).toBe(302);
  expect(wire.headers["location"]).toBe(`http://127.0.0.1:${webPort}/somewhere?x=1`);
});

it("带无效令牌访问 / 时得到网关的 401，而不是本地外壳", async () => {
  const webRoot = await webFixture();
  const { port: gatewayPort, seen } = await guardGateway("good");
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`, webRoot);

  const wire = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: webPort, path: "/?token=wrong" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      })
      .on("error", reject);
  });

  expect(wire.status).toBe(401);
  expect(wire.body).toBe(JSON.stringify({ error: "Unauthorized" }));
  expect(seen).toEqual(["/?token=wrong"]);
});

it("不带令牌访问 / 仍是本地外壳，网关一次请求都收不到", async () => {
  const webRoot = await webFixture();
  const { port: gatewayPort, seen } = await guardGateway("good");
  const webPort = await webFor(`http://127.0.0.1:${gatewayPort}`, webRoot);

  const home = await fetch(`http://127.0.0.1:${webPort}/`);
  expect(home.status).toBe(200);
  expect(await home.text()).toContain("shell");
  // Not "the gateway returned something harmless" — it was never dialled.
  expect(seen).toEqual([]);
});
