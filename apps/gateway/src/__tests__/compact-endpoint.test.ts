import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type HeadlessServer } from "../server.js";
import type { ModelPort } from "@voltojs/core";

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "Hello" };
    yield { type: "text_delta", text: " world" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

let server: HeadlessServer;
let baseUrl: string;
let launchToken: string;

beforeAll(async () => {
  process.env["VOLTO_CONFIG_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "volto-compact-"));
  server = await createServer({ port: 0, modelPort: MOCK_MODEL });
  launchToken = server.launchToken;
  await new Promise<void>((resolve) => {
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function authHeaders(token: string = launchToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function post(
  pathName: string,
  body: unknown,
  base: string = baseUrl,
  token: string = launchToken,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, base);
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Opens an /events channel and triggers one turn, returning once the turn's
 * frames have gone quiet — the "session that has already run a turn"
 * precondition several cases need.
 */
function runOneTurn(
  sessionId: string,
  message: string,
  config: Record<string, unknown>,
  base: string = baseUrl,
  token: string = launchToken,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, base);
    const timer = setTimeout(() => reject(new Error("timed out waiting for turn")), 10_000);
    const req = http.get(url, { headers: authHeaders(token) }, (res) => {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const scheduleIdle = (): void => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          clearTimeout(timer);
          req.destroy();
          resolve();
        }, 400);
      };
      res.on("data", () => scheduleIdle());
      res.on("error", reject);
      post("/messages", { sessionId, message, ...config }, base, token).catch(reject);
    });
    req.on("error", (err) => {
      if (!req.destroyed) reject(err);
    });
  });
}

async function createTestProjectAndModel(base: string = baseUrl, token: string = launchToken): Promise<{
  projectId: string;
  providerId: string;
  modelId: string;
}> {
  const project = await post("/projects", { name: "compact-test", path: process.cwd() }, base, token);
  const provider = await post(
    "/providers",
    { name: "compact-provider", models: [{ name: "compact-model", code: "compact-model" }] },
    base,
    token,
  );
  const providerData = provider.data as { id: string; models: Array<{ id: string }> };
  return {
    projectId: (project.data as { id: string }).id,
    providerId: providerData.id,
    modelId: providerData.models[0]!.id,
  };
}

let sessionCounter = 0;

describe("POST /sessions/:id/compact", () => {
  it("returns 200 compacted:false for a session that has never run a turn", async () => {
    const sessionId = `compact-no-turn-${++sessionCounter}`;
    // Attaching is enough for the session to be "known"; no /messages turn.
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, baseUrl);
      const req = http.get(url, { headers: authHeaders() }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
        res.on("error", reject);
      });
      req.on("error", (err) => {
        if (!req.destroyed) reject(err);
      });
    });

    const { status, data } = await post(`/sessions/${encodeURIComponent(sessionId)}/compact`, {});
    expect(status).toBe(200);
    // No runner yet → compactNow returns null; the route reports it as
    // "nothing compacted" rather than inventing a result.
    expect(data).toEqual({ ok: true, compacted: false });
  });

  it("returns 200 compacted:false after a short turn (under threshold)", async () => {
    const sessionId = `compact-short-turn-${++sessionCounter}`;
    const config = await createTestProjectAndModel();
    await runOneTurn(sessionId, "hi", config);

    const { status, data } = await post(`/sessions/${encodeURIComponent(sessionId)}/compact`, {});
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, compacted: false });
  });

  it("returns 404 for an unknown session", async () => {
    const { status, data } = await post("/sessions/never-existed/compact", {});
    expect(status).toBe(404);
    expect((data as { error: string }).error).toContain("never-existed");
  });

  it(
    "returns 409 when a turn is mid-flight",
    async () => {
      // A hanging model keeps the agent in calling_model so compactNow is busy.
      let releaseModel!: () => void;
      const hang = new Promise<void>((r) => {
        releaseModel = r;
      });
      let modelCallStarted = false;
      const hangingModel: ModelPort = {
        async *stream() {
          modelCallStarted = true;
          await hang;
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "end_turn" };
        },
      };

      // Dedicated server so the hanging model cannot stall other tests.
      // Project/provider ids are file-backed under VOLTO_CONFIG_DIR, so
      // creating them on the main server still resolves here.
      const busyServer = await createServer({ port: 0, modelPort: hangingModel });
      await new Promise<void>((resolve) => busyServer.on("listening", resolve));
      const addr = busyServer.address();
      const busyBase = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
      const busyToken = busyServer.launchToken;
      let sseReq: http.ClientRequest | undefined;

      try {
        const sessionId = `compact-busy-${++sessionCounter}`;
        const config = await createTestProjectAndModel();

        const sseFrames: string[] = [];
        await new Promise<void>((resolve, reject) => {
          const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, busyBase);
          const req = http.get(url, { headers: authHeaders(busyToken) }, (res) => {
            res.on("data", (chunk: Buffer) => sseFrames.push(chunk.toString("utf-8")));
            res.on("error", reject);
            post("/messages", { sessionId, message: "hello", ...config }, busyBase, busyToken)
              .then(() => resolve())
              .catch(reject);
          });
          sseReq = req;
          req.on("error", (err) => {
            if (!req.destroyed) reject(err);
          });
        });

        const deadline = Date.now() + 8_000;
        while (!modelCallStarted) {
          if (Date.now() > deadline) {
            throw new Error(`model never started; SSE so far: ${sseFrames.join("")}`);
          }
          await new Promise((r) => setTimeout(r, 10));
        }

        const { status, data } = await post(
          `/sessions/${encodeURIComponent(sessionId)}/compact`,
          {},
          busyBase,
          busyToken,
        );
        expect(status).toBe(409);
        expect((data as { error: string }).error).toMatch(/busy/i);
      } finally {
        // Tear the SSE channel down first so server.close() is not held
        // open by a still-connected EventSource, then release the hanging
        // model so the in-flight turn can finish.
        sseReq?.destroy();
        releaseModel();
        await new Promise<void>((resolve) => busyServer.close(() => resolve()));
      }
    },
    20_000,
  );
});
