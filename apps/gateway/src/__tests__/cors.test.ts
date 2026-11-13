/**
 * CORS origin enforcement (F3): a browser is the real threat surface for a
 * local gateway that can be told to open any project path and drive the
 * agent with `permissionMode: "auto-accept"`. These tests pin down that the
 * default origin is the web app's own dev origin (not `"*"`), that a
 * mismatched `Origin` header is rejected, that requests carrying no `Origin`
 * header (non-browser clients) are unaffected, and that `corsOrigin` stays
 * configurable for deliberate exposure.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerOptions } from "../server.js";
import type { ModelPort } from "@voltojs/core";

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "done", stopReason: "end_turn" };
  },
};

async function startServer(opts: ServerOptions = {}): Promise<{ server: http.Server; baseUrl: string }> {
  process.env["VOLTO_CONFIG_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "volto-cors-"));
  const server = await createServer({ port: 0, modelPort: MOCK_MODEL, ...opts });
  const baseUrl = await new Promise<string>((resolve) => {
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(`http://localhost:${addr.port}`);
    });
  });
  return { server, baseUrl };
}

function getHealth(
  baseUrl: string,
  origin?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL("/health", baseUrl),
      { method: "GET", headers: origin ? { Origin: origin } : {} },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * A request whose `Origin` deliberately differs from its `Host` — same-origin
 * browser requests are sent as a full round trip (there is no header merge
 * shortcut), and Node's HTTP client would otherwise derive `Host` from the
 * URL, which is exactly the matching case this suite must stop assuming.
 */
function requestWithHeaders(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, baseUrl), { method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("CORS origin handling", () => {
  describe("default corsOrigin", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = await startServer());
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("allows a request with no Origin header (non-browser clients)", async () => {
      const { status } = await getHealth(baseUrl);
      expect(status).toBe(200);
    });

    it("allows the web app's own dev origin", async () => {
      const { status, headers } = await getHealth(baseUrl, "http://localhost:6100");
      expect(status).toBe(200);
      expect(headers["access-control-allow-origin"]).toBe("http://localhost:6100");
    });

    it("rejects a request from a disallowed Origin", async () => {
      const { status } = await getHealth(baseUrl, "http://evil.example");
      expect(status).toBe(403);
    });

    it("never sends Access-Control-Allow-Origin: * by default", async () => {
      const { headers } = await getHealth(baseUrl, "http://localhost:6100");
      expect(headers["access-control-allow-origin"]).not.toBe("*");
    });
  });

  describe("same-origin requests (the exported web app served by this gateway)", () => {
    // An exported build is hosted BY the gateway, so the browser sends the
    // gateway's own host as `Origin` — a value the fixed `corsOrigin` (the
    // dev server's 6100) never names. Accepting any other origin would let a
    // page on another localhost port drive the agent, so the rule is exactly
    // "Origin host == Host header".
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      ({ server } = await startServer());
      // Keep the default corsOrigin in force: the same-origin rule must work
      // without configuring anything.
      port = (server.address() as { port: number }).port;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("accepts an Origin whose host equals the request's Host header", async () => {
      const { status, headers } = await requestWithHeaders(`http://127.0.0.1:${port}`, "/health", {
        Origin: `http://127.0.0.1:${port}`,
        Host: `127.0.0.1:${port}`,
      });
      expect(status).toBe(200);
      expect(headers["access-control-allow-origin"]).toBe(`http://127.0.0.1:${port}`);
    });

    it("still rejects a sibling localhost port (same-site is not same-origin)", async () => {
      // A page on another localhost port IS same-site, so its SameSite=Strict
      // cookie would ride along — Origin is the only check that separates it.
      const { status } = await requestWithHeaders(`http://127.0.0.1:${port}`, "/health", {
        Origin: "http://127.0.0.1:9999",
        Host: `127.0.0.1:${port}`,
      });
      expect(status).toBe(403);
    });

    it("accepts the configured dev origin even behind a different Host", async () => {
      // The dev loop still applies: `next dev` proxies `/gateway/*` to this
      // gateway, which then sees the PROXY's Host, not 6100. The configured
      // origin must keep working — same-origin is added, not swapped in.
      const { status } = await requestWithHeaders(`http://127.0.0.1:${port}`, "/health", {
        Origin: "http://localhost:6100",
        Host: `127.0.0.1:${port}`,
      });
      expect(status).toBe(200);
    });

    it("matches the Host header including its port", async () => {
      const { status } = await requestWithHeaders(`http://127.0.0.1:${port}`, "/health", {
        Origin: "http://localhost:6100",
        Host: "localhost:6100",
      });
      expect(status).toBe(200);
    });

    it("lets the preflight through only for a trusted origin", async () => {
      const allowed = await requestWithHeaders(
        `http://127.0.0.1:${port}`,
        "/messages",
        {
          Origin: `http://127.0.0.1:${port}`,
          Host: `127.0.0.1:${port}`,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type",
        },
        "OPTIONS",
      );
      expect(allowed.status).toBe(204);
      expect(allowed.headers["access-control-allow-origin"]).toBe(`http://127.0.0.1:${port}`);

      const rejected = await requestWithHeaders(
        `http://127.0.0.1:${port}`,
        "/messages",
        {
          Origin: "http://evil.example",
          Host: `127.0.0.1:${port}`,
          "Access-Control-Request-Method": "POST",
        },
        "OPTIONS",
      );
      expect(rejected.status).toBe(403);
    });

    it("advertises Authorization among the allowed request headers", async () => {
      const { headers } = await requestWithHeaders(
        `http://127.0.0.1:${port}`,
        "/messages",
        { Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` },
        "OPTIONS",
      );
      expect(headers["access-control-allow-headers"]).toContain("Authorization");
    });
  });

  describe('corsOrigin: "*" (deliberate exposure)', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = await startServer({ corsOrigin: "*" }));
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("allows any Origin when explicitly configured", async () => {
      const { status, headers } = await getHealth(baseUrl, "http://anything.example");
      expect(status).toBe(200);
      expect(headers["access-control-allow-origin"]).toBe("*");
    });
  });

  describe("corsOrigin: a custom allow-listed origin", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = await startServer({ corsOrigin: "https://trusted.example" }));
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("allows the configured origin and rejects any other", async () => {
      const allowed = await getHealth(baseUrl, "https://trusted.example");
      expect(allowed.status).toBe(200);
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://trusted.example");

      const rejected = await getHealth(baseUrl, "http://localhost:6100");
      expect(rejected.status).toBe(403);
    });
  });

  describe("VOLTO_CORS_ORIGIN env var", () => {
    // A production `next start` build serves on a different port than the
    // hardcoded `next dev` default (6100), and corsOrigin previously had no
    // way to be configured around that other than editing code — this env
    // var (following the OPENAI_*/VOLTO_CONFIG_DIR naming already used in
    // this codebase) closes that gap.
    const originalEnv = process.env["VOLTO_CORS_ORIGIN"];

    afterAll(() => {
      if (originalEnv === undefined) delete process.env["VOLTO_CORS_ORIGIN"];
      else process.env["VOLTO_CORS_ORIGIN"] = originalEnv;
    });

    it("is used when no explicit corsOrigin option is given", async () => {
      process.env["VOLTO_CORS_ORIGIN"] = "https://from-env.example";
      const { server, baseUrl } = await startServer();
      try {
        const allowed = await getHealth(baseUrl, "https://from-env.example");
        expect(allowed.status).toBe(200);
        expect(allowed.headers["access-control-allow-origin"]).toBe("https://from-env.example");

        const rejected = await getHealth(baseUrl, "http://localhost:6100");
        expect(rejected.status).toBe(403);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        delete process.env["VOLTO_CORS_ORIGIN"];
      }
    });

    it("is overridden by an explicit corsOrigin option", async () => {
      process.env["VOLTO_CORS_ORIGIN"] = "https://from-env.example";
      const { server, baseUrl } = await startServer({ corsOrigin: "https://explicit.example" });
      try {
        const allowed = await getHealth(baseUrl, "https://explicit.example");
        expect(allowed.status).toBe(200);

        const rejected = await getHealth(baseUrl, "https://from-env.example");
        expect(rejected.status).toBe(403);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        delete process.env["VOLTO_CORS_ORIGIN"];
      }
    });
  });
});
