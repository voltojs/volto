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
import type { ModelPort } from "@volto/core";

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "done", stopReason: "end_turn" };
  },
};

async function startServer(opts: ServerOptions = {}): Promise<{ server: http.Server; baseUrl: string }> {
  process.env["VOLTO_CONFIG_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "volto-cors-"));
  const server = createServer({ port: 0, modelPort: MOCK_MODEL, ...opts });
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
});
