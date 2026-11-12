/**
 * Static hosting of the exported web app (F-08) and its path-traversal
 * boundary.
 *
 * Two levels, on purpose:
 *
 * - `routeStaticPath` is the pure decision. Its cases feed the RAW request
 *   path (`/..%2ftraversal-probe.txt`), because `new URL(...).pathname`
 *   repairs `//` and `\\` before any check could see them — feeding it a
 *   pre-repaired path would test the parser, not the guard.
 * - `serveStatic` is the reader, driven here with a minimal `ServerResponse`
 *   double. Every rejection asserts the STATUS AND that the response body is
 *   not the file a successful escape would have returned; a handler that
 *   wrote nothing, and a router that 404'd by accident, both pass a
 *   "body is empty" check without ever proving the file was refused.
 *
 * The web root shares a machine with `~/.volto` — launch token, provider
 * keys, transcripts — so the fixture plants a secret next to it, plants one
 * in a sibling whose name shares the root's prefix, and symlinks to both from
 * inside the root.
 */

import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { routeStaticPath, serveStatic } from "../static/serve.js";

/** Secret planted outside the web root; asserted absent from every rejection. */
const SECRET = "TOP-SECRET-OUTSIDE-WEB-ROOT";

interface FakeRes {
  res: ServerResponse;
  status: number | undefined;
  headers: Record<string, string>;
  /** Exactly the bytes written — decoded below for text assertions. */
  bytes: Buffer;
  /** `bytes` decoded as UTF-8, for the cases that answer text. */
  body: string;
}

/** Minimal `IncomingMessage` stand-in: only `method` is read. */
function fakeReq(method: string): IncomingMessage {
  return { method } as unknown as IncomingMessage;
}

/** Minimal `ServerResponse` stand-in recording status, headers and body. */
function fakeRes(): FakeRes {
  const chunks: Buffer[] = [];
  const state: FakeRes = {
    res: undefined as unknown as ServerResponse,
    status: undefined,
    headers: {},
    bytes: Buffer.alloc(0),
    body: "",
  };
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status;
      res.headersSent = true;
      for (const [key, value] of Object.entries(headers ?? {})) {
        state.headers[key.toLowerCase()] = String(value);
      }
      return res;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = String(value);
      return res;
    },
    write(chunk: string | Buffer) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      return true;
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else if (chunk) chunks.push(chunk);
      state.bytes = Buffer.concat(chunks);
      state.body = state.bytes.toString("utf-8");
      return res;
    },
    on() {
      return res;
    },
  };
  state.res = res as unknown as ServerResponse;
  return state;
}

interface Site {
  webRoot: string;
  apiRoots: readonly string[];
  configScript: string;
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "volto-web-"));
  await writeFile(path.join(root, "index.html"), "<html>ok</html>");
  await mkdir(path.join(root, "_next/static/chunks"), { recursive: true });
  await writeFile(path.join(root, "_next/static/chunks/a.js"), "console.log(1)");
  return root;
}

/**
 * A web root plus the material an escape would aim at: a secret file in its
 * PARENT directory, a secret in a look-alike sibling directory, and symlinks
 * inside the root pointing at both.
 */
async function hostileFixture(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "volto-traversal-"));
  // The sibling shares the root's name prefix — the classic
  // `startsWith(root)` (no trailing separator) mistake.
  const root = path.join(parent, "volto-web");
  const outside = path.join(parent, "volto-web-decoy");
  await mkdir(path.join(root, "_next/static/chunks"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "index.html"), "<html>ok</html>");
  await writeFile(path.join(root, "_next/static/chunks/a.js"), "console.log(1)");
  await writeFile(path.join(outside, "traversal-probe.txt"), SECRET);
  await writeFile(path.join(parent, "traversal-probe.txt"), SECRET);
  // Symlinks that resolve lexically INSIDE the root — the case a path-only
  // check cannot catch.
  await symlink(outside, path.join(root, "escape-dir"));
  await symlink(path.join(parent, "traversal-probe.txt"), path.join(root, "escape-file.txt"));
  return root;
}

function siteFor(webRoot: string, apiRoots: readonly string[] = []): Site {
  return {
    webRoot,
    apiRoots,
    configScript:
      '// Generated by the volto gateway.\n' +
      'window.__VOLTO_CONFIG__ = { gatewayUrl: "", version: "0.1.0" };\n',
  };
}

interface Served extends FakeRes {
  /**
   * What compose with the router would answer: `false` from `serveStatic`
   * means the router takes over and, for an unknown path, answers 404.
   */
  routerStatus: number;
}

/** Serve one raw request path through `serveStatic`. */
async function serve(site: Site, rawTarget: string, method = "GET"): Promise<Served> {
  const res = fakeRes();
  const handled = await serveStatic(fakeReq(method), res.res, rawTarget, site);
  return Object.assign(res, { routerStatus: handled ? (res.status ?? 0) : 404 });
}

describe("静态托管 · 路由判定", () => {
  it("根路径与深链接都是应用外壳", () => {
    for (const p of ["/", "/sessions/abc", "/sessions/abc/"]) {
      expect(routeStaticPath(p, []), p).toEqual({ kind: "shell" });
    }
  });

  it("_next/static 下的构建产物是不可变资源", () => {
    expect(routeStaticPath("/_next/static/chunks/a.js", [])).toEqual({
      kind: "asset",
      rel: "_next/static/chunks/a.js",
      immutable: true,
    });
    // A hashed favicon chunk under _next/ is still immutable.
    expect(routeStaticPath("/_next/static/media/x.woff2", [])).toMatchObject({ immutable: true });
  });

  it("其他构建产物每次都要重新验证", () => {
    expect(routeStaticPath("/favicon.ico", [])).toEqual({
      kind: "asset",
      rel: "favicon.ico",
      immutable: false,
    });
  });

  it("volto-config.js 由网关动态生成", () => {
    expect(routeStaticPath("/volto-config.js", [])).toEqual({ kind: "config" });
  });

  it("API 根路径永远交给路由", () => {
    const roots = ["/health", "/sessions", "/volto"];
    for (const p of ["/health", "/sessions", "/sessions/abc", "/volto/x"]) {
      expect(routeStaticPath(p, roots), p).toBe(false);
    }
    // The prefix check stops at a segment boundary.
    expect(routeStaticPath("/health-check", roots)).toEqual({ kind: "shell" });
    expect(routeStaticPath("/volto-config.js", roots)).toEqual({ kind: "config" });
  });

  it("拒绝每一种穿越写法（逐条布尔判定，无属性断言）", () => {
    // `false` is the ONLY "not static content" answer, so the check is a
    // bare boolean. These cases exist separately from the list below because
    // this is the shape that provably holds whatever a property-based
    // `toBe` on nested response objects happens to do in this suite.
    const reject = (p: string): void => {
      expect(routeStaticPath(p, []) === false).toBe(true);
    };
    reject("/../etc");
    reject("/..%2Fetc");
    reject("/%2e%2e/etc");
    reject("/%2E%2E%2Fetc");
    reject("/..%5cetc");
    reject("/..\\etc");
    reject("/_next/../etc");
    reject("//etc/passwd");
    reject("/./../etc");
    reject("/a%00b");
    reject("/%E0%A4%A");
  });

  it("拒绝每一种穿越写法（原始请求路径）", () => {
    const attacks = [
      "/../traversal-probe.txt",
      "/..%2ftraversal-probe.txt",
      "/%2e%2e/traversal-probe.txt",
      "/%2E%2E%2Ftraversal-probe.txt",
      "/..%5ctraversal-probe.txt",
      "/%2e%2e%5ctraversal-probe.txt",
      "/..\\traversal-probe.txt",
      "/_next/static/chunks/../../../traversal-probe.txt",
      "/_next/static/chunks/%2e%2e/%2e%2e/%2e%2e/traversal-probe.txt",
      "//etc/passwd",
      "//volto-web-decoy/traversal-probe.txt",
      "/./../traversal-probe.txt",
      "/../volto-web-decoy/traversal-probe.txt",
      "/a%00b",
      "/%E0%A4%A",
    ];
    for (const attack of attacks) {
      expect(routeStaticPath(attack, []), attack).toBe(false);
    }
  });
});

describe("静态托管 · 读取", () => {
  it("返回 index.html 且不缓存", async () => {
    const res = await serve(siteFor(await fixture()), "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("ok");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("深链接回落到 index.html（单页导出，客户端负责路由）", async () => {
    const res = await serve(siteFor(await fixture()), "/sessions/abc");
    expect(res.status).toBe(200);
    expect(res.body).toContain("ok");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("_next/static 走不可变长缓存", async () => {
    const res = await serve(siteFor(await fixture()), "/_next/static/chunks/a.js");
    expect(res.status).toBe(200);
    expect(res.body).toBe("console.log(1)");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["content-type"]).toContain("javascript");
  });

  it("二进制资源逐字节原样返回（图片/字体不被 UTF-8 破坏）", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "_next/static/media"), { recursive: true });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
    await writeFile(path.join(root, "_next/static/media/a.png"), bytes);
    const res = await serve(siteFor(root), "/_next/static/media/a.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.bytes.equals(bytes)).toBe(true);
  });

  it("动态生成 volto-config.js 且不缓存", async () => {
    const res = await serve(siteFor(await fixture()), "/volto-config.js");
    expect(res.status).toBe(200);
    expect(res.body).toContain('gatewayUrl: ""');
    expect(res.body).toContain('version: "0.1.0"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toContain("javascript");
  });

  it("HEAD 返回头部但不带响应体", async () => {
    const res = await serve(siteFor(await fixture()), "/", "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toBe("");
  });

  it("非 GET/HEAD 不处理，交给路由", async () => {
    const site = siteFor(await fixture());
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const res = await serve(site, "/index.html", method);
      expect(res.status, method).toBeUndefined();
    }
  });

  it("扩展名白名单外的文件不处理（404，不发内容）", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "notes.md"), "# secret notes");
    const res = await serve(siteFor(root), "/notes.md");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("secret notes");
  });

  it("不存在的静态资源返回 404", async () => {
    const res = await serve(siteFor(await fixture()), "/_next/static/chunks/missing.js");
    expect(res.status).toBe(404);
  });

  it("webRoot 不存在时 / 返回 503 JSON，其他路径照旧 404", async () => {
    const site = siteFor(path.join(tmpdir(), "volto-web-does-not-exist-xyz"));
    const shell = await serve(site, "/");
    expect(shell.status).toBe(503);
    expect(shell.headers["content-type"]).toContain("application/json");
    expect((await serve(site, "/_next/static/chunks/a.js")).status).toBe(404);
  });

  it("穿越的每一种写法都返回 404 且响应体不是目标文件", async () => {
    const site = siteFor(await hostileFixture());
    const attacks = [
      "/../traversal-probe.txt",
      "/..%2ftraversal-probe.txt",
      "/%2e%2e/traversal-probe.txt",
      "/%2E%2E%2Ftraversal-probe.txt",
      "/..%5ctraversal-probe.txt",
      "/%2e%2e%5ctraversal-probe.txt",
      "/..\\traversal-probe.txt",
      "/_next/static/chunks/../../../traversal-probe.txt",
      "/_next/static/chunks/%2e%2e/%2e%2e/%2e%2e/traversal-probe.txt",
      "//volto-web-decoy/traversal-probe.txt",
      "/./../traversal-probe.txt",
      "/../volto-web-decoy/traversal-probe.txt",
      // Symlinks inside the root that point out of it.
      "/escape-dir/traversal-probe.txt",
      "/escape-file.txt",
    ];
    for (const attack of attacks) {
      const res = await serve(site, attack);
      // A rejected path is answered 404 by the router (never a 200), and the
      // target file's content never reaches the response.
      expect(res.routerStatus, `status for ${attack}`).toBe(404);
      expect(res.body, `body for ${attack}`).not.toContain(SECRET);
    }
  });

  it("legit 资源仍然可读（穿越拒绝不是把一切拒掉）", async () => {
    // Paired with the traversal cases above: a handler that refused EVERY
    // path would pass them all while serving nothing.
    const site = siteFor(await hostileFixture());
    expect((await serve(site, "/index.html")).body).toContain("ok");
    expect((await serve(site, "/_next/static/chunks/a.js")).body).toBe("console.log(1)");
  });
});