/**
 * Minimal stand-in for a Volto gateway, used by the desktop smoke runs.
 *
 * It implements just enough of the contract to exercise the real app:
 * /health is public, /gateway-info requires the Bearer token, "/" serves a
 * recognizable page, and "/?token=..." redirects to the clean URL the way the
 * gateway's auth guard does. Every request is appended to the log file so the
 * desktop evidence can show the webview actually loaded the page.
 *
 * Usage: FAKE_PORT=4597 FAKE_LOG=/tmp/fake.log node scripts/smoke-gateway.mjs
 */
import * as http from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.env.FAKE_PORT ?? 4597);
const log = process.env.FAKE_LOG ?? "/tmp/fake-gateway.log";
const token = process.env.FAKE_TOKEN ?? "smoke-token";

const page = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>Fake Volto Gateway</title></head>
  <body style="font-family: -apple-system, sans-serif; padding: 40px">
    <h1>FAKE-GATEWAY-OK</h1>
    <p>This page is served by the fake gateway used for desktop smoke runs.</p>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  appendFileSync(log, `${req.method} ${req.url} auth=${req.headers.authorization ?? "-"}\n`);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }
  if (url.pathname === "/gateway-info") {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"Unauthorized"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"version":"0.2.1","mode":"remote"}');
    return;
  }
  if (url.pathname === "/" && url.searchParams.has("token")) {
    res.writeHead(302, { location: "/", "set-cookie": `volto_auth=${token}; Path=/; HttpOnly; SameSite=Strict` });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake gateway listening on http://127.0.0.1:${port}`);
});
