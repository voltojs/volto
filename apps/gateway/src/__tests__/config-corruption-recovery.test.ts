/**
 * F5 follow-up (Critical regression fix): a corrupt config file must surface
 * as a normal HTTP error, not crash the request handler.
 *
 * GET /projects and GET /providers used to `await` their store reads with no
 * try/catch. Once config/projects.ts and config/providers.ts started
 * throwing ConfigCorruptError instead of silently treating a corrupt file as
 * empty (see config-projects.test.ts / config-providers.test.ts), that
 * error escaped the async request handler as an unhandled rejection: no
 * response was ever written, and under Node's default
 * --unhandled-rejections=throw the whole gateway process exits. Since
 * apps/web calls both endpoints on load, a single corrupt file would have
 * bricked the gateway the moment the web app opened.
 *
 * The part that matters here is not just "returns 500" but "the server is
 * still alive and answers the next request" — that is exactly what
 * regressed.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../server.js";
import type { ModelPort } from "@volto/core";

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "done", stopReason: "end_turn" };
  },
};

function getJson(
  baseUrl: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(new URL(pathname, baseUrl), { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString()) }),
      );
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function startServer(): Promise<{
  server: http.Server;
  baseUrl: string;
  configDir: string;
  launchToken: string;
}> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-corrupt-"));
  process.env["VOLTO_CONFIG_DIR"] = configDir;
  const server = await createServer({ port: 0, modelPort: MOCK_MODEL });
  const baseUrl = await new Promise<string>((resolve) => {
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(`http://localhost:${addr.port}`);
    });
  });
  return { server, baseUrl, configDir, launchToken: server.launchToken };
}

describe("corrupt config file handling stays request-scoped", () => {
  it("GET /projects returns 500 for a corrupt file and the server stays responsive", async () => {
    const { server, baseUrl, configDir, launchToken } = await startServer();
    try {
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, "projects.json"), "{not valid json", "utf-8");

      const broken = await getJson(baseUrl, "/projects", {
        Authorization: `Bearer ${launchToken}`,
      });
      expect(broken.status).toBe(500);
      expect((broken.data as { error?: string }).error).toMatch(/could not be parsed|corrupt/i);

      // The part that regressed: the process/server must still be alive and
      // answer a normal request afterwards, not just this one call.
      const health = await getJson(baseUrl, "/health");
      expect(health.status).toBe(200);
      expect(health.data).toEqual({ status: "ok" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("GET /providers returns 500 for a corrupt file and the server stays responsive", async () => {
    const { server, baseUrl, configDir, launchToken } = await startServer();
    try {
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, "providers.json"), "{not valid json", "utf-8");

      const broken = await getJson(baseUrl, "/providers", {
        Authorization: `Bearer ${launchToken}`,
      });
      expect(broken.status).toBe(500);
      expect((broken.data as { error?: string }).error).toMatch(/could not be parsed|corrupt/i);

      const health = await getJson(baseUrl, "/health");
      expect(health.status).toBe(200);
      expect(health.data).toEqual({ status: "ok" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
