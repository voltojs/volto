import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { createServer, type HeadlessServer } from "../server.js";
import { PickerBusyError, PickerUnsupportedError } from "../fs/directory-picker.js";
import { RevealUnsupportedError } from "../fs/path-revealer.js";
import { CommandTimeoutError } from "../fs/command-runner.js";
import { buildSandboxConfigs } from "../wiring.js";
import { buildPermissionConfig } from "../permission-modes.js";
import { createPlanStore } from "../config/plan-store.js";
import { getConfigDir } from "../config/paths.js";
import { loadPermissionRules } from "../config/permissions.js";
import { encodeWorkspaceName } from "@volto/store-jsonl";
import {
  applyPartial,
  buildTurnRecords,
  createMockModelPort,
  textScript,
  toConversationView,
  toolCallScript,
  decide,
  ceilingOf,
} from "@volto/core";
import type {
  ConversationMessage,
  ModelPort,
  ReducerState,
  TranscriptDelta,
  TranscriptEvent,
  TranscriptEventInput,
  TurnRecord,
} from "@volto/core";

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "Hello" };
    yield { type: "text_delta", text: " world" };
    yield {
      type: "done",
      stopReason: "end_turn",
    };
  },
};

let server: HeadlessServer;
let baseUrl: string;
let launchToken: string;

beforeAll(async () => {
  process.env["VOLTO_CONFIG_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "volto-test-"));
  server = await createServer({ port: 0, modelPort: MOCK_MODEL });
  launchToken = server.launchToken;
  // Wait for the server to start. Binding to an explicit host (as opposed to
  // the previous no-host call, which bound synchronously) routes through
  // Node's async listen path even for a literal IP, so `address()` is only
  // populated once "listening" actually fires — read it inside the handler,
  // not synchronously right after `.listen()`.
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

/** Bearer headers for the main server's launch token (or a given one). */
function authHeaders(token: string = launchToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function post(
  path: string,
  body: unknown,
  base: string = baseUrl,
  token: string = launchToken,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
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
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function put(
  path: string,
  body: unknown,
  base: string = baseUrl,
  token: string = launchToken,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            data: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function getSse(path: string, token: string = launchToken): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    http.get(url, { headers: authHeaders(token) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
        resolve(lines.map((l) => l.slice(6)));
      });
      res.on("error", reject);
    });
  });
}

interface ProtocolFrame {
  id: string;
  event: string;
  data: unknown;
}

/** Parse the SSE wire format into frames, ignoring incomplete trailing data. */
function parseFrames(raw: string): ProtocolFrame[] {
  return raw
    .split("\n\n")
    .filter((block) => block.includes("event: "))
    .map((block) => {
      const frame: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const idx = line.indexOf(": ");
        if (idx > 0) frame[line.slice(0, idx)] = line.slice(idx + 2);
      }
      return {
        id: frame["id"] ?? "",
        event: frame["event"] ?? "",
        data: JSON.parse(frame["data"] ?? "null"),
      };
    });
}

/**
 * Fallback quiet window for turns that never emit `turn_end` (error paths).
 * The happy path resolves on the `turn_end` frame itself, so this only has to
 * be long enough that a starved worker — the whole-repo gate runs ~68 test
 * tasks plus tsc and eslint at once — is not mistaken for a finished turn.
 * At 400ms a slow first delta made the collector resolve holding only the
 * `connected` frame, and the turn's text assertions failed against ''.
 */
const TURN_IDLE_MS = 3_000;

/** Grace period after `turn_end` to let trailing frames land. */
const TURN_END_GRACE_MS = 150;

/**
 * Open an /events channel, trigger one turn via POST /messages, and collect
 * every protocol frame the turn produced.
 *
 * `config` is merged into the /messages body. `resolveConfig` (F2) now
 * requires a real, resolvable projectId/providerId/modelId for every turn
 * requested through /messages, so any caller that needs a turn to actually
 * run (rather than immediately error) must supply one — see
 * `createTestProjectAndModel` below.
 *
 * The v2 protocol has no terminal `done` frame — turn end is expressed by a
 * `turn_end` event in the transcript, so that frame is what completion waits
 * on. The quiet window is only a fallback for turns that never reach
 * `turn_end` (error paths): treating "quiet" as "finished" on its own makes
 * the collector resolve early whenever the machine is loaded, and the turn's
 * frames then arrive after the assertions have already run.
 */
function collectProtocolTurn(
  sessionId: string,
  message: string,
  config: Record<string, unknown> = {},
  base: string = baseUrl,
  token: string = launchToken,
): Promise<ProtocolFrame[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, base);
    const timer = setTimeout(() => reject(new Error("timed out waiting for turn frames")), 10_000);

    const req = http.get(url, { headers: authHeaders(token) }, (res) => {
      let raw = "";
      let idle: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (idle) clearTimeout(idle);
        clearTimeout(timer);
        req.destroy();
        resolve(parseFrames(raw));
      };
      const scheduleIdle = (): void => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(finish, TURN_IDLE_MS);
      };
      const sawTurnEnd = (): boolean =>
        parseFrames(raw).some(
          (f) => f.event === "event" && (f.data as { type?: string }).type === "turn_end",
        );
      res.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
        if (sawTurnEnd()) {
          // Authoritative end of turn. A short grace lets any frame already
          // in flight behind it land before the socket is torn down.
          if (idle) clearTimeout(idle);
          idle = setTimeout(finish, TURN_END_GRACE_MS);
          return;
        }
        scheduleIdle();
      });
      res.on("error", reject);

      // The channel must be attached before the turn is triggered.
      post("/messages", { sessionId, message, ...config }, base, token).catch(reject);
    });
    req.on("error", (err) => {
      // destroy() after resolving surfaces here; ignore once we already resolved.
      if (!req.destroyed) reject(err);
    });
  });
}

/**
 * Create a project (rooted at the current working directory) and a
 * single-model provider, and return the ids a `/messages` body needs to
 * pass `resolveConfig`'s completeness check.
 */
async function createTestProjectAndModel(): Promise<{
  projectId: string;
  providerId: string;
  modelId: string;
}> {
  const project = await post("/projects", { name: "turn-test", path: process.cwd() });
  const provider = await post("/providers", {
    name: "turn-test-provider",
    models: [{ name: "test-model", code: "test-model" }],
  });
  const providerData = provider.data as { id: string; models: Array<{ id: string }> };
  return {
    projectId: (project.data as { id: string }).id,
    providerId: providerData.id,
    modelId: providerData.models[0]!.id,
  };
}

let sessionCounter = 0;

/**
 * Creates a project/provider/model, opens an /events channel, and runs one
 * turn on a fresh session id — the "session that has already run a turn"
 * precondition several tests need (e.g. the PATCH /sessions/:id rename
 * tests). Factored out of the steps `GET /sessions lists a session after a
 * turn has run` already used, since no such helper existed yet in this file.
 */
async function startSessionWithOneTurn(): Promise<string> {
  const sessionId = `session-one-turn-${++sessionCounter}`;
  const config = await createTestProjectAndModel();
  await collectProtocolTurn(sessionId, "hi", config);
  return sessionId;
}

function getJson(
  path: string,
  base: string = baseUrl,
  token: string = launchToken,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), { headers: authHeaders(token) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString()) }),
      );
      res.on("error", reject);
    });
  });
}

function getRaw(
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, baseUrl), { headers: authHeaders(launchToken) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
      res.on("error", reject);
    });
  });
}

function del(path: string, token: string = launchToken): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, baseUrl),
      { method: "DELETE", headers: authHeaders(token) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Boots a dedicated server instance on an ephemeral port with its own model
 * port — the pattern the directory-picker tests use. Project/provider ids
 * created through any server in this file resolve here too: those stores are
 * file-backed under VOLTO_CONFIG_DIR and re-read on every call.
 */
async function startEphemeralServer(
  modelPort: ModelPort,
): Promise<{ base: string; launchToken: string; close(): Promise<void> }> {
  const instance = await createServer({ port: 0, modelPort });
  await new Promise<void>((resolve) => instance.on("listening", resolve));
  const addr = instance.address();
  const base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
  return {
    base,
    launchToken: instance.launchToken,
    close: () => new Promise<void>((resolve) => instance.close(() => resolve())),
  };
}

/** Resolves once `pred` holds (polling every 25ms); rejects after `timeoutMs`. */
async function until(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Opens a raw /events SSE channel and collects every protocol frame into
 * `frames` — parsed incrementally, keeping any incomplete trailing block
 * buffered — until `stop()` destroys the connection. Unlike
 * `collectProtocolTurn` this never triggers a turn and never resolves on its
 * own: the caller decides when to abort, which is what the reconnection
 * regression needs.
 */
function openEventChannel(
  sessionId: string,
  lastEventId: string | undefined,
  base: string,
  token: string = launchToken,
): { frames: ProtocolFrame[]; opened: Promise<void>; stop(): void } {
  const frames: ProtocolFrame[] = [];
  const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, base);
  let signalOpen!: () => void;
  const opened = new Promise<void>((resolve) => {
    signalOpen = resolve;
  });

  const handleResponse = (res: http.IncomingMessage): void => {
    signalOpen();
    let raw = "";
    res.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf-8");
      const blocks = raw.split("\n\n");
      raw = blocks.pop() ?? "";
      for (const block of blocks) {
        if (!block.includes("event: ")) continue; // the ": connected" comment
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
          const idx = line.indexOf(": ");
          if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 2);
        }
        frames.push({
          id: fields["id"] ?? "",
          event: fields["event"] ?? "",
          data: JSON.parse(fields["data"] ?? "null"),
        });
      }
    });
    res.on("error", () => {
      // The deliberate destroy() below surfaces here — expected, not a failure.
    });
  };

  const headers: Record<string, string> = { ...authHeaders(token) };
  if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
  const req = http.get(url, { headers }, handleResponse);
  req.on("error", () => {
    // Same story on the request side: destroy() rejects the socket.
  });

  return { frames, opened, stop: () => req.destroy() };
}

/**
 * Pick a catalog provider/model pair that satisfies `wants` and is not
 * already configured. Every catalog record must name a distinct pi-ai
 * provider (config/providers.ts's assertPiProviderFree), and these tests
 * share one config dir, so a fixed "first match" would collide with whatever
 * an earlier test configured.
 */
async function pickFreeCatalogTarget(
  wants: (model: { code: string; reasoning?: boolean; contextWindow?: number }) => boolean,
): Promise<{ piProvider: string; code: string }> {
  const { data: catalog } = await getJson("/catalog/providers");
  const { data: configured } = await getJson("/providers");
  const taken = new Set(
    (configured as Array<{ kind: string; piProvider?: string }>)
      .filter((p) => p.kind === "catalog")
      .map((p) => p.piProvider),
  );
  for (const provider of catalog as Array<{
    id: string;
    models: Array<{ code: string; reasoning?: boolean; contextWindow?: number }>;
  }>) {
    if (taken.has(provider.id)) continue;
    const model = provider.models.find(wants);
    if (model) return { piProvider: provider.id, code: model.code };
  }
  throw new Error("no unconfigured catalog provider matched");
}

describe("authentication", () => {
  it("refuses an unauthenticated request to every non-public route", async () => {
    for (const [method, route] of [
      ["GET", "/providers"],
      ["POST", "/providers"],
      ["GET", "/projects"],
      ["POST", "/projects"],
      ["GET", "/sessions"],
      ["POST", "/messages"],
      ["POST", "/interrupt"],
      ["POST", "/fs/pick-directory"],
      ["POST", "/fs/reveal"],
    ] as const) {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        ...(method === "POST" ? { body: "{}", headers: { "Content-Type": "application/json" } } : {}),
      });
      expect(response.status, `${method} ${route}`).toBe(401);
    }
  });

  it("keeps /health public", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
  });

  it("accepts a bearer token", async () => {
    const response = await fetch(`${baseUrl}/projects`, {
      headers: { Authorization: `Bearer ${launchToken}` },
    });
    expect(response.status).toBe(200);
  });

  it("refuses an SSE subscription without credentials", async () => {
    const response = await fetch(`${baseUrl}/events?sessionId=x`);
    expect(response.status).toBe(401);
  });

  it("answers every rejection with the same body", async () => {
    // A caller must not learn whether a route or session exists.
    const a = await fetch(`${baseUrl}/providers`);
    const b = await fetch(`${baseUrl}/nonexistent-route`);
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });

  it("exchanges a valid query token for a cookie and a clean redirect", async () => {
    const response = await fetch(`${baseUrl}/?token=${launchToken}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("volto_auth=");
  });

  it("puts CORS headers on the 401 so a cross-origin caller reads the status", async () => {
    // Without them the browser surfaces a CORS network error instead, and
    // the app cannot tell "not authenticated" from "gateway is down".
    const response = await fetch(`${baseUrl}/providers`, {
      headers: { Origin: "http://localhost:6100" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:6100");
    // Auth is cookie-based, so credentialed responses must be allowed too.
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("marks the SSE stream no-transform so a proxy cannot compress it", async () => {
    // Not cosmetic. The web app reaches the gateway through a Next.js
    // rewrite, and Next gzips a proxied response whenever the client sends
    // Accept-Encoding -- which every browser does and curl does not. A gzip
    // encoder buffers input until it has a block to emit, so on a
    // never-ending stream of small frames the browser got the gzip header
    // and then nothing: EventSource fired `open` and no event ever arrived.
    // The whole chat UI was dead while every curl check of this endpoint
    // passed. `no-transform` is what tells the proxy to leave the body alone.
    const response = await fetch(`${baseUrl}/events?sessionId=hdr-check`, {
      headers: { ...authHeaders(), "Accept-Encoding": "gzip, deflate, br" },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    void response.body?.cancel();
  });

  it("refuses a WebSocket upgrade without credentials", async () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const wsUrl = `ws://localhost:${port}/ws?message=hi`;
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.on("open", () => {
          ws.close();
          resolve();
        });
        ws.on("error", reject);
        ws.on("unexpected-response", (_req, res) => {
          reject(new Error(`upgrade rejected with ${res.statusCode}`));
        });
      }),
    ).rejects.toThrow(/401/);
  });

  it("refuses an unauthenticated upgrade to a non-/ws path with 401, not 404", async () => {
    // Same constraint as the HTTP guard: an unauthenticated caller must not
    // learn which upgrade paths exist by comparing 401 (/ws) vs 404 (elsewhere).
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const wsUrl = `ws://localhost:${port}/definitely-not-ws`;
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.on("open", () => {
          ws.close();
          resolve();
        });
        ws.on("error", reject);
        ws.on("unexpected-response", (_req, res) => {
          reject(new Error(`upgrade rejected with ${res.statusCode}`));
        });
      }),
    ).rejects.toThrow(/401/);
  });

  it("refuses an authenticated WebSocket upgrade with a disallowed Origin", async () => {
    // Different localhost ports are same-site, so the SameSite=Strict cookie
    // WOULD be sent — Origin is the check that stops another localhost page
    // from driving /ws with the user's cookie. Must reject even when
    // credentials are present (cookie or bearer).
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const wsUrl = `ws://localhost:${port}/ws?message=hi`;
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          origin: "http://localhost:9999",
          headers: authHeaders(),
        });
        ws.on("open", () => {
          ws.close();
          resolve();
        });
        ws.on("error", reject);
        ws.on("unexpected-response", (_req, res) => {
          reject(new Error(`upgrade rejected with ${res.statusCode}`));
        });
      }),
    ).rejects.toThrow(/403/);
  });

  it("accepts an authenticated WebSocket upgrade from the configured origin", async () => {
    // Allowed Origin + credentials must still complete the handshake.
    // (Missing Origin is covered by the unauthenticated 401 tests above and
    // by "WebSocket /ws receives events" in the functional suite.)
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const wsUrl = `ws://localhost:${port}/ws?message=hi`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        origin: "http://localhost:6100",
        headers: authHeaders(),
      });
      ws.on("open", () => {
        ws.close();
        resolve();
      });
      ws.on("error", reject);
      ws.on("unexpected-response", (_req, res) => {
        reject(new Error(`upgrade rejected with ${res.statusCode}`));
      });
    });
  });

  it("refuses to start on a non-loopback bind", async () => {
    await expect(
      createServer({ port: 0, host: "0.0.0.0", modelPort: MOCK_MODEL }),
    ).rejects.toThrow(/loopback/i);
  });

  it("caps a request body at 1 MiB with 413", async () => {
    const huge = "x".repeat(1024 * 1024 + 1);
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ message: huge }),
    });
    expect(response.status).toBe(413);
  });
});

describe("Headless server", () => {
  it("GET /health returns ok", async () => {
    const url = new URL("/health", baseUrl);
    const { status, data } = await new Promise<{ status: number; data: unknown }>((resolve) => {
      http.get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      });
    });
    expect(status).toBe(200);
    expect(data).toEqual({ status: "ok" });
  });

  it("GET /skills lists discovered skills with their invocation flags", async () => {
    const response = await fetch(`${baseUrl}/skills`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      skills: Array<{ name: string; description: string; modelInvocable: boolean; userInvocable: boolean }>;
    };
    expect(Array.isArray(body.skills)).toBe(true);
    for (const skill of body.skills) {
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.modelInvocable).toBe("boolean");
      expect(typeof skill.userInvocable).toBe("boolean");
    }
  });

  // Runs before any other test creates a project — later tests in this file
  // (turn tests, F2 coverage) create their own projects via
  // `createTestProjectAndModel`, which would make this assertion vacuous if
  // it ran after them.
  it("GET /projects starts empty and POST adds one", async () => {
    const before = await getJson("/projects");
    expect(before.status).toBe(200);
    expect(before.data).toEqual([]);

    const created = await post("/projects", { name: "tmp", path: process.cwd() });
    expect(created.status).toBe(201);

    const after = await getJson("/projects");
    expect((after.data as unknown[]).length).toBe(1);
  });

  it("GET /skills?projectId= scopes discovery to that project's directory", async () => {
    // Build a project directory with a skill that exists ONLY here — never
    // under the process cwd this test suite runs from — so a passing
    // assertion can only be explained by the projectId path actually
    // resolving to this directory, not by coincidentally reusing the
    // process-cwd scan.
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-skills-project-"));
    const skillDir = path.join(projectDir, ".claude", "skills", "task11-fixture-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: task11-fixture-skill",
        "description: Fixture skill that only exists under the test project directory.",
        "---",
        "Fixture body.",
        "",
      ].join("\n"),
    );

    const project = await post("/projects", { name: "skills-fixture-project", path: projectDir });
    expect(project.status).toBe(201);
    const projectId = (project.data as { id: string }).id;

    // The process-wide default (no projectId) must NOT see the fixture skill —
    // otherwise the two code paths would be indistinguishable.
    const defaultResponse = await getJson("/skills");
    const defaultBody = defaultResponse.data as { skills: Array<{ name: string }> };
    expect(defaultBody.skills.some((s) => s.name === "task11-fixture-skill")).toBe(false);

    // The project-scoped request must see it.
    const scopedResponse = await getJson(`/skills?projectId=${encodeURIComponent(projectId)}`);
    expect(scopedResponse.status).toBe(200);
    const scopedBody = scopedResponse.data as { skills: Array<{ name: string }> };
    expect(scopedBody.skills.some((s) => s.name === "task11-fixture-skill")).toBe(true);
  });

  it("GET /skills?projectId=<unknown> returns 404 without falling back to the process cwd", async () => {
    const { status, data } = await getJson("/skills?projectId=nonexistent");
    expect(status).toBe(404);
    expect(data).toEqual({ error: "Unknown project: nonexistent" });
  });

  it("POST /run returns final state", async () => {
    const { status, data } = await post("/run", { message: "hi" });
    expect(status).toBe(200);
    const result = data as { state: ReducerState };
    expect(result.state).toBeDefined();
    expect(result.state.status).toBe("done");
  });

  it("GET /stream returns SSE events", async () => {
    const events = await getSse("/stream?message=hi");
    expect(events.length).toBeGreaterThan(0);
    // Should contain text_delta events
    const parsed = events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e));
    const textDeltas = parsed.filter((e: { type?: string }) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it("WebSocket /ws receives events", async () => {
    const events = await new Promise<unknown[]>((resolve, reject) => {
      const wsUrl = new URL("/ws?message=hi", baseUrl).toString().replace("http", "ws");
      const ws = new WebSocket(wsUrl, { headers: authHeaders() });
      const received: unknown[] = [];

      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        if (msg.type === "done") {
          ws.close();
          resolve(received);
        }
      });

      ws.on("error", reject);
      setTimeout(() => {
        ws.close();
        resolve(received);
      }, 5000);
    });

    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1] as { type: string };
    expect(last.type).toBe("done");
  });

  it("OPTIONS preflight is answered with CORS headers", async () => {
    // No Origin header on this request (a non-browser client), so the
    // default origin restriction (see cors.test.ts) does not reject it.
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.request(new URL("/messages", baseUrl), { method: "OPTIONS" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers));
      });
      req.on("error", reject);
      req.end();
    });

    // Default corsOrigin is now the web app's own origin, not "*" — see F3.
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:6100");
    expect(headers["access-control-allow-headers"]).toContain("Content-Type");
    expect(headers["access-control-allow-methods"]).toContain("DELETE");
    expect(headers["access-control-allow-methods"]).toContain("PUT");
  });

  it("POST /messages without an open channel is rejected", async () => {
    const { status } = await post("/messages", { sessionId: "no-channel", message: "hi" });
    expect(status).toBe(409);
  });

  it("POST /messages rejects an unsupported permission mode", async () => {
    const { status } = await post("/messages", {
      sessionId: "bad-mode",
      message: "hi",
      permissionMode: "default",
    });
    expect(status).toBe(400);
  });

  it("GET /events + POST /messages streams a turn as event and delta frames", async () => {
    const sessionId = "session-protocol";
    const config = await createTestProjectAndModel();
    const frames = await collectProtocolTurn(sessionId, "hi", config);

    // Every frame rides one of the five v2 kinds (CONNECTED added for the
    // per-connection approval token — see sessions.ts's `attach`).
    const kinds = new Set(frames.map((f) => f.event));
    expect(
      [...kinds].every((k) => ["event", "delta", "heartbeat", "error", "connected"].includes(k)),
    ).toBe(true);

    // Text flows as delta frames carrying TranscriptDelta increments...
    const textPieces = frames
      .filter((f) => f.event === "delta")
      .map((f) => f.data as { kind: string; text?: string })
      .filter((d) => d.kind === "text")
      .map((d) => d.text ?? "");
    expect(textPieces.join("")).toBe("Hello world");

    // ...bookended by authoritative event frames. Task R6: the runner streams
    // the transcript vocabulary it records — every event frame payload is a
    // stamped TranscriptEventInput ({time, type, data, turn?}), isomorphic
    // with what the chatStore would persist. The raw reducer vocabulary
    // (model_done/tool_use_complete) never reaches the wire.
    const eventPayloads = frames
      .filter((f) => f.event === "event")
      .map((f) => f.data as { type: string; time: number; turn?: number });
    expect(eventPayloads.some((e) => e.type === "user_message")).toBe(true);
    expect(eventPayloads.some((e) => e.type === "assistant_message")).toBe(true);
    expect(eventPayloads.some((e) => e.type === "turn_end")).toBe(true);
    expect(eventPayloads.every((e) => typeof e.time === "number")).toBe(true);
    expect(eventPayloads.every((e) => typeof e.turn === "number")).toBe(true);
    expect(eventPayloads.some((e) => e.type === "model_done")).toBe(false);
    expect(eventPayloads.some((e) => e.type === "tool_use_complete")).toBe(false);

    // Ids are monotonic so a client can resume with Last-Event-ID. Delta
    // frames share the last event's id (they are not replayable), so ids are
    // non-decreasing rather than strictly increasing.
    const ids = frames.map((f) => Number(f.id));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBeGreaterThanOrEqual(ids[i - 1]!);
    }
  });

  // §九 P2-1: the live/history consistency gate. The SSE stream and the
  // session store are two transports for the same transcript; this proves a
  // client that projects the stream exactly the way apps/web does lands on
  // the very conversation the server persists — deep-equal, including every
  // tool_call.result folded back into its call.
  it("reconstructs the stored ConversationView from the live event/delta stream (consistency gate)", { timeout: 15_000 }, async () => {
    // A tool-calling turn needs a scripted model — the shared MOCK_MODEL is
    // text-only — so this boots its own server (the picker tests' pattern).
    // `ls` is READ_ONLY, so the default permission policy (READ_ONLY: allow)
    // executes it without an approval round-trip.
    const toolModel = createMockModelPort([
      toolCallScript("call-gate-1", "ls", JSON.stringify({ path: "." })),
      textScript("done"),
    ]);
    const toolServer = await startEphemeralServer(toolModel);
    try {
      const base = toolServer.base;
      const sessionId = "session-consistency-gate";
      const project = await post(
        "/projects",
        { name: "gate-project", path: process.cwd() },
        base,
        toolServer.launchToken,
      );
      const provider = await post(
        "/providers",
        { name: "gate-provider", models: [{ name: "gate-model", code: "gate-model" }] },
        base,
        toolServer.launchToken,
      );
      const config = {
        projectId: (project.data as { id: string }).id,
        providerId: (provider.data as { id: string }).id,
        modelId: (provider.data as { models: Array<{ id: string }> }).models[0]!.id,
      };

      const frames = await collectProtocolTurn(
        sessionId,
        "list this directory",
        config,
        base,
        toolServer.launchToken,
      );

      // Premise: the turn really did call a tool and got a result back.
      const eventTypes = frames
        .filter((f) => f.event === "event")
        .map((f) => (f.data as { type: string }).type);
      expect(eventTypes).toContain("tool_call");
      expect(eventTypes).toContain("tool_result");

      // The live reconstruction, exactly the way apps/web does it: event
      // frames are the authoritative transcript (seq synthesized by arrival
      // index — the projection never reads seq), delta frames fold into the
      // open step as streaming partials that the next authoritative event
      // supersedes.
      const liveEvents: TranscriptEvent[] = [];
      let records: TurnRecord[] = [];
      for (const frame of frames) {
        if (frame.event === "event") {
          liveEvents.push({ ...(frame.data as TranscriptEventInput), seq: liveEvents.length });
          records = buildTurnRecords(liveEvents, records);
        } else if (frame.event === "delta") {
          records = applyPartial(records, frame.data as TranscriptDelta);
        }
      }
      const live = toConversationView(records);

      // The history side: what GET /sessions/:id projects from the persisted
      // transcript (readConversation = toConversationView(buildTurnRecords)).
      const detail = await getJson(`/sessions/${sessionId}`, base, toolServer.launchToken);
      expect(detail.status).toBe(200);
      const stored = (detail.data as { messages: ConversationMessage[] }).messages;

      // THE GATE: deep equality between the live view and the stored view.
      expect(live.messages).toEqual(stored);

      // The tool result the gate exists to cover is real tool output, not a
      // metadata summary.
      const calls = live.messages
        .flatMap((m) => m.blocks)
        .flatMap((b) => (b.type === "tool_call" ? [b.call] : []));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe("ls");
      expect(calls[0]!.isError).toBe(false);
      expect(calls[0]!.result).toContain("package.json");
    } finally {
      await toolServer.close();
    }
  });

  // §九 P2-2: deltas are not replayable — a client reconnecting with
  // Last-Event-ID must receive only authoritative event frames, and must not
  // lose any of them while it was away.
  it("replays only event frames (never deltas) to a client reconnecting with Last-Event-ID", { timeout: 15_000 }, async () => {
    // The shared MOCK_MODEL streams its two text deltas back-to-back, so TCP
    // would likely coalesce the whole turn into one chunk and a "mid-turn"
    // abort would land after the fact. A dedicated server whose model pauses
    // after the first delta makes the mid-stream abort deterministic.
    const slowModel: ModelPort = {
      async *stream() {
        yield { type: "text_delta", text: "Hello" };
        await new Promise((resolve) => setTimeout(resolve, 250));
        yield { type: "text_delta", text: " world" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const slowServer = await startEphemeralServer(slowModel);
    try {
      const base = slowServer.base;
      const sessionId = "session-delta-replay";
      // Project/provider ids resolve on any server in this file — the stores
      // are file-backed under VOLTO_CONFIG_DIR and re-read per call.
      const config = await createTestProjectAndModel();

      // ── Connection A: attach, trigger the turn, abort mid-stream. ──
      const channelA = openEventChannel(sessionId, undefined, base, slowServer.launchToken);
      await channelA.opened;
      const postResult = await post(
        "/messages",
        { sessionId, message: "hi", ...config },
        base,
        slowServer.launchToken,
      );
      expect(postResult.status).toBe(202);
      await until(
        () => channelA.frames.some((f) => f.event === "delta"),
        5_000,
        "timed out waiting for the first delta frame",
      );
      channelA.stop();

      // Premise guards: the abort really landed mid-stream — deltas had
      // arrived, the turn had not ended.
      expect(channelA.frames.some((f) => f.event === "delta")).toBe(true);
      expect(
        channelA.frames.some(
          (f) => f.event === "event" && (f.data as { type?: string }).type === "turn_end",
        ),
      ).toBe(false);

      // Let the turn finish: poll the durable transcript until the assistant
      // reply has been recorded (user + assistant = 2 messages). By this
      // point every text delta has already been pushed, so the reconnect
      // below can only ever see event frames.
      await until(
        async () => {
          const { status, data } = await getJson(
            `/sessions/${sessionId}`,
            base,
            slowServer.launchToken,
          );
          return status === 200 && (data as { messages: unknown[] }).messages.length >= 2;
        },
        5_000,
        "timed out waiting for the turn to persist its messages",
      );

      // ── Connection B: reconnect with Last-Event-ID. ──
      // A well-behaved client advances its cursor on replayable (event)
      // frames only — delta frames deliberately repeat the last event's id so
      // they never advance it. The cursor here sits on the first event frame
      // connection A had processed (turn_start), so everything authoritative
      // from user_message onward must come back.
      const lastEventId = channelA.frames.find((f) => f.event === "event")!.id;
      const channelB = openEventChannel(sessionId, lastEventId, base, slowServer.launchToken);
      await channelB.opened;
      await until(
        () =>
          channelB.frames.some(
            (f) => f.event === "event" && (f.data as { type?: string }).type === "turn_end",
          ),
        10_000,
        "timed out waiting for turn_end on the reconnected channel",
      );
      channelB.stop();

      // Every fresh connection also gets exactly one CONNECTED frame (its
      // own per-connection approval token) right away — that is not part of
      // the replay buffer (a new connection always gets a NEW token, never
      // a replayed one; see sessions.ts's `attach`), so it is excluded here
      // rather than treated as one of the replayed frames THE GATE checks.
      expect(channelB.frames.filter((f) => f.event === "connected")).toHaveLength(1);
      const replayed = channelB.frames.filter((f) => f.event !== "connected");

      // THE GATE: nothing the reconnect delivers is a delta frame. The replay
      // buffer only ever holds event frames, and by the time B attached the
      // turn had finished streaming — so every frame here is a replay.
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed.every((f) => f.event === "event")).toBe(true);

      // Nothing authoritative was lost while A was away: the turn's key
      // events all came back.
      const replayedTypes = replayed.map((f) => (f.data as { type?: string }).type);
      expect(replayedTypes).toContain("user_message");
      expect(replayedTypes).toContain("assistant_message");
      expect(replayedTypes).toContain("turn_end");

      // The authoritative assistant_message carries the full reply on its own
      // — a client that lost every delta still reconstructs it.
      const assistant = replayed.find(
        (f) => (f.data as { type?: string }).type === "assistant_message",
      )!.data as TranscriptEventInput;
      const assistantContent = assistant.data as { content: Array<{ type: string; text?: string }> };
      expect(
        assistantContent.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      ).toBe("Hello world");

      // Replay semantics: only frames strictly newer than the cursor.
      expect(replayed.every((f) => Number(f.id) > Number(lastEventId))).toBe(true);
    } finally {
      await slowServer.close();
    }
  });

  it("keeps conversation history per session across turns", async () => {
    const sessionId = "session-multi-turn";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "first", config);
    await collectProtocolTurn(sessionId, "second", config);

    const frames = await collectProtocolTurn(sessionId, "third", config);
    const textPieces = frames
      .filter((f) => f.event === "delta")
      .map((f) => f.data as { kind: string; text?: string })
      .filter((d) => d.kind === "text")
      .map((d) => d.text ?? "");
    // The mock model replies identically each turn; a fresh, complete
    // response proves the turn ran independently rather than erroring or
    // replaying an earlier turn's text.
    expect(textPieces.join("")).toBe("Hello world");
  });

  it("GET /sessions lists a session after a turn has run", async () => {
    const sessionId = "session-list-after-turn";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "hi", config);

    const { status, data } = await getJson("/sessions");
    expect(status).toBe(200);
    const body = data as { sessions: Array<{ id: string; projectId: string; messageCount: number }>; unreadableSessions: number };
    const summary = body.sessions.find((s) => s.id === sessionId);
    expect(summary).toBeDefined();
    expect(summary!.projectId).toBe(config.projectId);
    // One user message + one assistant message from the mock model's reply.
    expect(summary!.messageCount).toBe(2);
  });

  it("GET /sessions/:id/export returns Markdown or JSONL with a download header", async () => {
    const sessionId = "export-session-raw";
    const sessionsDir = path.join(process.env["VOLTO_CONFIG_DIR"]!, "sessions", "export-ws");
    await fs.mkdir(sessionsDir, { recursive: true });
    const event = (seq: number, type: string, data: unknown) => ({
      version: 3,
      sessionId,
      event: { seq, time: 1_700_000_000_000 + seq, type, data },
    });
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      [
        event(0, "session_meta", { title: "Export test", projectId: "p1", providerId: null, modelId: null, permissionMode: null }),
        event(1, "turn_start", { turn: 1 }),
        event(2, "user_message", { content: "hello" }),
        event(3, "assistant_message", { content: [{ type: "text", text: "world" }], durationMs: 1 }),
        event(4, "turn_end", { turn: 1, reason: "done" }),
      ].map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf-8",
    );

    const md = await getRaw(`/sessions/${sessionId}/export`);
    expect(md.status).toBe(200);
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.headers["content-disposition"]).toContain("attachment");
    expect(md.body).toContain("## Turn 1");
    expect(md.body).toContain("world");

    const jsonl = await getRaw(`/sessions/${sessionId}/export?format=jsonl`);
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers["content-type"]).toContain("application/x-ndjson");
    const first = JSON.parse(jsonl.body.split("\n")[0]!) as { version: number; event: { type: string } };
    expect(first).toMatchObject({ version: 3, event: { type: "session_meta" } });

    expect((await getRaw(`/sessions/${sessionId}/export?format=pdf`)).status).toBe(400);
    expect((await getRaw("/sessions/does-not-exist/export")).status).toBe(404);
  });

  it("POST /sessions/:id/fork creates a visible branch and 404s unknown ids", async () => {
    const sessionId = "session-fork-source";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "hi", config);

    const created = await post(`/sessions/${sessionId}/fork`, {});
    expect(created.status).toBe(201);
    const forked = created.data as { id: string; title: string; parentSessionId: string };
    expect(forked.parentSessionId).toBe(sessionId);
    expect(forked.title).toContain("分支");

    const detail = await getJson(`/sessions/${forked.id}`);
    expect(detail.status).toBe(200);
    const listed = await getJson("/sessions");
    expect((listed.data as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toContain(forked.id);

    const invalid = await post(`/sessions/${sessionId}/fork`, { throughSeq: "1" });
    expect(invalid.status).toBe(400);

    const missing = await post("/sessions/does-not-exist/fork", {});
    expect(missing.status).toBe(404);

    // Malformed JSON must be a client error (400), not a 500 — same
    // normalization as POST /agents.
    const badBody = await fetch(`${baseUrl}/sessions/${sessionId}/fork`, {
      method: "POST",
      headers: authHeaders(),
      body: "{oops",
    });
    expect(badBody.status).toBe(400);
  });

  it("answers 400 for a malformed percent-encoded session id and stays alive", async () => {
    // %E0%A4 is an incomplete UTF-8 sequence: decodeURIComponent throws
    // URIError before any route-level try block runs. The top-level guard
    // must answer 400 instead of letting an unhandled rejection kill the
    // process, and the server must keep serving the next request.
    const badExport = await getRaw("/sessions/%E0%A4/export");
    expect(badExport.status).toBe(400);

    const badFork = await post("/sessions/%E0%A4/fork", {});
    expect(badFork.status).toBe(400);

    const alive = await getJson("/sessions");
    expect(alive.status).toBe(200);
  });

  it("GET /sessions?q= searches title and message text and returns a snippet", async () => {
    const sessionId = "session-search-after-turn";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "hi", config);

    const hit = await getJson("/sessions?q=world");
    expect(hit.status).toBe(200);
    const body = hit.data as { sessions: Array<{ id: string; snippet?: string }> };
    const summary = body.sessions.find((s) => s.id === sessionId);
    expect(summary).toBeDefined();
    expect(summary!.snippet).toContain("Hello world");

    const miss = await getJson("/sessions?q=definitely-not-present");
    expect(miss.status).toBe(200);
    expect((miss.data as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it("GET /sessions excludes sub-agent sessions (meta.origin === \"subagent\")", async () => {
    // Sub-agents write their own session files directly to the same
    // top-level sessions directory the task tool uses — a raw v2 file is
    // written here to simulate that without wiring up a real sub-agent run.
    const sessionsDir = path.join(process.env["VOLTO_CONFIG_DIR"]!, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const subagentSessionId = "subagent-session-1";
    const line = JSON.stringify({
      version: 3,
      sessionId: subagentSessionId,
      event: {
        seq: 0,
        time: Date.now(),
        type: "session_meta",
        data: { projectId: null, providerId: null, modelId: null, permissionMode: null, origin: "subagent" },
      },
    });
    await fs.writeFile(path.join(sessionsDir, `${subagentSessionId}.jsonl`), line + "\n", "utf-8");

    const { status, data } = await getJson("/sessions");
    expect(status).toBe(200);
    const body = data as { sessions: Array<{ id: string }> };
    expect(body.sessions.some((s) => s.id === subagentSessionId)).toBe(false);
  });

  it("GET /sessions includes the stored title", async () => {
    const sessionId = "session-with-title";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "hello", config);

    const response = await fetch(`${baseUrl}/sessions`, { headers: authHeaders() });
    const body = (await response.json()) as { sessions: Array<{ id: string; title: string }> };
    const session = body.sessions.find((s) => s.id === sessionId);
    expect(session).toBeDefined();
    expect(typeof session!.title).toBe("string");
  });

  it("GET /sessions/:id returns the transcript in the web app's Message shape", async () => {
    const sessionId = "session-detail";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "hi there", config);

    const { status, data } = await getJson(`/sessions/${sessionId}`);
    expect(status).toBe(200);
    const detail = data as {
      id: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(detail.id).toBe(sessionId);
    expect(detail.messages).toEqual([
      expect.objectContaining({ role: "user", content: "hi there" }),
      expect.objectContaining({ role: "assistant", content: "Hello world" }),
    ]);
  });

  it("GET /sessions/:id sends context usage as numbers only", async () => {
    const sessionId = await startSessionWithOneTurn();
    const response = await fetch(`${baseUrl}/sessions/${sessionId}`, { headers: authHeaders() });
    const body = (await response.json()) as { contextUsage: unknown };
    const serialized = JSON.stringify(body.contextUsage);

    expect(serialized).not.toMatch(/"text"/);
    expect(serialized).not.toMatch(/"schema"/);
    expect(serialized.length).toBeLessThan(1024);
  });

  it("GET /sessions/:id returns 404 for an unknown session", async () => {
    const { status, data } = await getJson("/sessions/no-such-session");
    expect(status).toBe(404);
    expect((data as { error: string }).error).toContain("no-such-session");
  });

  describe("POST /interrupt", () => {
    it("409s when the session has no turn running", async () => {
      const { status, data } = await post("/interrupt", { sessionId: "idle-session" });
      expect(status).toBe(409);
      // Pin the body too: the server's catch-all would not produce this
      // message, so a deleted route could not make this test pass.
      expect((data as { error: string }).error).toContain("idle-session");
    });
  });

  describe("GET /sessions/:id/plan", () => {
    /** The session's plan file: it bound to process.cwd() via startSessionWithOneTurn. */
    function planFileFor(sessionId: string): string {
      return path.join(getConfigDir(), "sessions", encodeWorkspaceName(process.cwd()), `${sessionId}.plan.md`);
    }

    it("404s with { error: \"no plan\" } before any plan was saved", async () => {
      const sessionId = await startSessionWithOneTurn();
      const response = await getJson(`/sessions/${sessionId}/plan`);
      expect(response.status).toBe(404);
      expect((response.data as { error: string }).error).toBe("no plan");
    });

    it("returns the saved plan content with the plan file's mtime as updatedAt", async () => {
      const sessionId = await startSessionWithOneTurn();
      const store = createPlanStore();
      await store.save(sessionId, process.cwd(), "# the plan\n\n1. measure twice");

      const response = await getJson(`/sessions/${sessionId}/plan`);
      expect(response.status).toBe(200);
      const body = response.data as { content: string; updatedAt: string };
      expect(body.content).toBe("# the plan\n\n1. measure twice");
      // updatedAt is the plan file's own mtime — the very value a fresh stat
      // of that file reports (asserting "a string exists" would also pass if
      // the route echoed some unrelated timestamp).
      const stat = await fs.stat(planFileFor(sessionId));
      expect(body.updatedAt).toBe(stat.mtime.toISOString());
    });

    it("404s a session with no project binding — no plan is reachable for it", async () => {
      const response = await getJson("/sessions/never-ran-a-turn/plan");
      expect(response.status).toBe(404);
      expect((response.data as { error: string }).error).toBe("no plan");
    });
  });

  describe("DELETE /sessions/:id", () => {
    it("removes the session from the list and the detail endpoint", async () => {
      const sessionId = await startSessionWithOneTurn();
      const response = await fetch(`${baseUrl}/sessions/${sessionId}`, { method: "DELETE", headers: authHeaders() });
      expect(response.status).toBe(204);

      const list = await fetch(`${baseUrl}/sessions`, { headers: authHeaders() });
      const body = (await list.json()) as { sessions: Array<{ id: string }> };
      expect(body.sessions.some((s) => s.id === sessionId)).toBe(false);

      const detail = await fetch(`${baseUrl}/sessions/${sessionId}`, { headers: authHeaders() });
      expect(detail.status).toBe(404);
    });

    it("404s an unknown session", async () => {
      const response = await fetch(`${baseUrl}/sessions/nope`, { method: "DELETE", headers: authHeaders() });
      expect(response.status).toBe(404);
      // Asserting the status alone would still pass if the route were deleted
      // entirely (the server's catch-all also 404s) — pin the body too, so
      // this actually verifies the DELETE handler ran its own not-found check.
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("nope");
    });

    it("removes the session's plan document alongside the transcript", async () => {
      const sessionId = await startSessionWithOneTurn();
      const store = createPlanStore();
      await store.save(sessionId, process.cwd(), "# doomed plan");
      const planFile = path.join(
        getConfigDir(),
        "sessions",
        encodeWorkspaceName(process.cwd()),
        `${sessionId}.plan.md`,
      );

      const response = await fetch(`${baseUrl}/sessions/${sessionId}`, { method: "DELETE", headers: authHeaders() });
      expect(response.status).toBe(204);
      // The file itself is gone — ENOENT, not merely "the store said null".
      await expect(fs.stat(planFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(store.read(sessionId, process.cwd())).resolves.toBeNull();
    });
  });

  describe("PATCH /sessions/:id", () => {
    it("stores a title that the list endpoint reads back", async () => {
      const sessionId = await startSessionWithOneTurn();
      const patch = await fetch(`${baseUrl}/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ title: "重构上下文注入" }),
      });
      expect(patch.status).toBe(204);

      const list = await fetch(`${baseUrl}/sessions`, { headers: authHeaders() });
      const body = (await list.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(body.sessions.find((s) => s.id === sessionId)?.title).toBe("重构上下文注入");
    });

    it("rejects an empty or over-long title", async () => {
      const sessionId = await startSessionWithOneTurn();
      for (const title of ["", "x".repeat(201)]) {
        const response = await fetch(`${baseUrl}/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ title }),
        });
        expect(response.status).toBe(400);
      }
    });

    it("404s an unknown session", async () => {
      const response = await fetch(`${baseUrl}/sessions/nope`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ title: "x" }),
      });
      expect(response.status).toBe(404);
    });

    it("preserves the session's other meta fields (projectId/providerId/modelId/permissionMode)", async () => {
      const sessionId = await startSessionWithOneTurn();
      const before = await getJson(`/sessions/${sessionId}`);
      const beforeDetail = before.data as {
        projectId?: string;
        providerId?: string;
        modelId?: string;
        permissionMode?: string;
      };

      const patch = await fetch(`${baseUrl}/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ title: "renamed" }),
      });
      expect(patch.status).toBe(204);

      const after = await getJson(`/sessions/${sessionId}`);
      const afterDetail = after.data as {
        projectId?: string;
        providerId?: string;
        modelId?: string;
        permissionMode?: string;
      };
      expect(afterDetail.projectId).toBe(beforeDetail.projectId);
      expect(afterDetail.providerId).toBe(beforeDetail.providerId);
      expect(afterDetail.modelId).toBe(beforeDetail.modelId);
      expect(afterDetail.permissionMode).toBe(beforeDetail.permissionMode);
    });
  });

  it("POST /messages errors over SSE when projectId is missing (F2)", async () => {
    const sessionId = "session-missing-project";
    const frames = await collectProtocolTurn(sessionId, "hi");

    expect(frames.some((f) => f.event === "error")).toBe(true);
    // The transport error frame is the whole turn — nothing follows it.
    expect(frames.at(-1)?.event).toBe("error");
    // Never silently ran the turn — no delta was streamed.
    expect(frames.some((f) => f.event === "delta")).toBe(false);
    // The error frame carries a typed payload the client can surface: the
    // mapper's default code plus the resolveConfig rejection reason.
    const errorData = frames.find((f) => f.event === "error")?.data as
      | { code: string; message: string }
      | undefined;
    expect(errorData?.code).toBe("STREAM_ERROR");
    expect(errorData?.message).toContain("projectId is required");
  });

  it("POST /messages errors over SSE when only providerId is given without modelId (F2)", async () => {
    const sessionId = "session-partial-model";
    const { projectId, providerId } = await createTestProjectAndModel();
    const frames = await collectProtocolTurn(sessionId, "hi", { projectId, providerId });

    expect(frames.some((f) => f.event === "error")).toBe(true);
    expect(frames.some((f) => f.event === "delta")).toBe(false);
  });

  it("POST /resume returns state", async () => {
    const { status } = await post("/resume", {
      sessionId: "nonexistent",
      decision: "allow",
    });
    // Resume of nonexistent session should error or return gracefully
    expect(status === 200 || status === 500).toBe(true);
  });

  it("POST /projects rejects a non-existent path", async () => {
    const { status } = await post("/projects", { name: "ghost", path: "/definitely/not/here" });
    expect(status).toBe(400);
  });

  it("DELETE /projects/:id with a malformed id returns 400 instead of crashing", async () => {
    const { status } = await del("/projects/%");
    expect(status).toBe(400);
  });

  it("GET /providers never returns a plaintext apiKey", async () => {
    await post("/providers", {
      name: "MiMo",
      baseURL: "https://example.com/v1",
      apiKey: "sk-abcdefgh3f2a",
      models: [{ name: "MiMo-V2.5-Pro", code: "mimo-v2.5" }],
    });

    const { status, data } = await getJson("/providers");
    expect(status).toBe(200);
    expect(JSON.stringify(data)).not.toContain("sk-abcdefgh3f2a");
    expect(JSON.stringify(data)).toContain("sk-…3f2a");
  });

  it("GET /catalog/providers returns a non-empty static projection excluding oauth-only providers", async () => {
    const { status, data } = await getJson("/catalog/providers");
    expect(status).toBe(200);
    const providers = data as Array<{ id: string; name: string; models: Array<{ code: string }> }>;
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.some((p) => p.id === "openai-codex")).toBe(false);
    for (const provider of providers) {
      expect(provider.models.length).toBeGreaterThan(0);
    }
  });

  it("GET /providers inlines non-empty reasoning efforts for a catalog reasoning model, and never exposes its apiKey", async () => {
    // Find a real reasoning-capable catalog model so this test tracks pi-ai's
    // actual metadata rather than a hardcoded, possibly-stale code.
    const target = await pickFreeCatalogTarget((m) => m.reasoning === true);

    await post("/providers", {
      name: "Catalog reasoning provider",
      kind: "catalog",
      piProvider: target.piProvider,
      apiKey: "sk-catalog-secret-1234",
      models: [{ code: target.code }],
    });

    const { status, data } = await getJson("/providers");
    expect(status).toBe(200);
    expect(JSON.stringify(data)).not.toContain("sk-catalog-secret-1234");

    const providers = data as Array<{
      kind: string;
      piProvider?: string;
      models: Array<{ code: string; reasoning?: { efforts: Array<{ id: string; name: string }> } }>;
    }>;
    const provider = providers.find((p) => p.kind === "catalog" && p.piProvider === target.piProvider);
    expect(provider).toBeDefined();
    const model = provider!.models.find((m) => m.code === target.code);
    expect(model).toBeDefined();
    expect(model!.reasoning).toBeDefined();
    expect(model!.reasoning!.efforts.length).toBeGreaterThan(0);
  });

  it("POST and PUT /providers return the same catalog shape as GET (inlined models, not just modelCodes)", async () => {
    // Clients merge the write response straight into the list they got from
    // GET, so a write that answered with the bare PublicProvider left a
    // catalog record with no `models` array at all — every consumer that
    // walks `provider.models` then crashed until the next full reload.
    const target = await pickFreeCatalogTarget((m) => m.reasoning === true);

    const created = await post("/providers", {
      name: "Catalog write-shape provider",
      kind: "catalog",
      piProvider: target.piProvider,
      apiKey: "sk-write-shape-secret",
      models: [{ code: target.code }],
    });
    expect(created.status).toBe(201);
    const createdProvider = created.data as {
      id: string;
      models?: Array<{ code: string; reasoning?: { efforts: unknown[] } }>;
    };
    expect(createdProvider.models).toBeDefined();
    expect(createdProvider.models![0]!.code).toBe(target.code);
    expect(createdProvider.models![0]!.reasoning).toBeDefined();
    expect(JSON.stringify(created.data)).not.toContain("sk-write-shape-secret");

    const updated = await put(`/providers/${encodeURIComponent(createdProvider.id)}`, {
      kind: "catalog",
      models: [{ code: target.code }],
    });
    expect(updated.status).toBe(200);
    const updatedProvider = updated.data as {
      models?: Array<{ code: string; reasoning?: { efforts: unknown[] } }>;
    };
    expect(updatedProvider.models).toBeDefined();
    expect(updatedProvider.models![0]!.code).toBe(target.code);
    expect(updatedProvider.models![0]!.reasoning).toBeDefined();
  });

  it("GET /providers reports a catalog model's stored overrides only, never the catalog's token caps", async () => {
    // The settings form edits this response. Merging pi-ai's own
    // contextWindow/maxOutputTokens in would put a catalog number into an
    // override box, and the next save would freeze it as an explicit
    // override that no longer tracks pi-ai.
    const target = await pickFreeCatalogTarget((m) => m.contextWindow !== undefined);

    await post("/providers", {
      name: "Catalog override provider",
      kind: "catalog",
      piProvider: target.piProvider,
      models: [{ code: target.code, maxOutputTokens: 1234 }],
    });

    const { data } = await getJson("/providers");
    const provider = (
      data as Array<{
        kind: string;
        name: string;
        models: Array<{ code: string; contextWindow?: number; maxOutputTokens?: number }>;
      }>
    ).find((p) => p.name === "Catalog override provider");
    const model = provider!.models.find((m) => m.code === target.code);
    expect(model!.maxOutputTokens).toBe(1234);
    expect("contextWindow" in model!).toBe(false);
  });

  it("GET /providers omits the reasoning key entirely for a model with no reasoning capability", async () => {
    await post("/providers", {
      name: "No-reasoning provider",
      baseURL: "https://example.com/v1",
      apiKey: "sk-no-reasoning-secret",
      models: [{ name: "plain-model", code: "plain-model" }],
    });

    const { data } = await getJson("/providers");
    const providers = data as Array<{
      kind: string;
      models: Array<{ code: string; reasoning?: unknown }>;
    }>;
    const provider = providers.find((p) =>
      p.kind === "custom" && p.models.some((m) => m.code === "plain-model"),
    );
    expect(provider).toBeDefined();
    const model = provider!.models.find((m) => m.code === "plain-model");
    expect(model).toBeDefined();
    expect("reasoning" in model!).toBe(false);
  });

  it("GET /providers isolates a broken catalog provider (unknown piProvider) so it still returns 200 with the healthy provider intact", async () => {
    // Healthy provider: a plain custom provider with no reasoning capability,
    // sharing nothing with the broken record below.
    await post("/providers", {
      name: "Healthy custom provider",
      baseURL: "https://example.com/v1",
      apiKey: "sk-healthy-secret-0000",
      models: [{ name: "healthy-model", code: "healthy-model" }],
    });

    // Broken provider: a catalog provider whose piProvider does not exist in
    // pi-ai's catalog — the exact shape a retired provider id or a routine
    // pi-ai upgrade produces (createPiAiModelPort throws inside
    // buildCatalogProvider, per collection.ts). POST /providers itself does
    // not validate piProvider against the catalog, so this record persists
    // fine and only fails when GET /providers tries to build a ModelPort
    // for it.
    await post("/providers", {
      name: "Broken catalog provider",
      kind: "catalog",
      piProvider: "not-a-real-pi-ai-provider",
      apiKey: "sk-broken-secret-1111",
      models: [{ code: "stale-model-code" }],
    });

    const { status, data } = await getJson("/providers");
    expect(status).toBe(200);

    // Standing invariant: no plaintext apiKey anywhere on the wire, even
    // with a broken record mixed in.
    const raw = JSON.stringify(data);
    expect(raw).not.toContain("sk-healthy-secret-0000");
    expect(raw).not.toContain("sk-broken-secret-1111");

    const providers = data as Array<{
      name: string;
      kind: string;
      models: Array<{ code: string; reasoning?: unknown }>;
    }>;

    const healthy = providers.find((p) => p.name === "Healthy custom provider");
    expect(healthy).toBeDefined();
    expect(healthy!.models.some((m) => m.code === "healthy-model")).toBe(true);

    const broken = providers.find((p) => p.name === "Broken catalog provider");
    expect(broken).toBeDefined();
    const brokenModel = broken!.models.find((m) => m.code === "stale-model-code");
    expect(brokenModel).toBeDefined();
    // Degraded: model is present but carries no `reasoning` key at all —
    // not an empty list, an absent key.
    expect("reasoning" in brokenModel!).toBe(false);
  });

  it("DELETE /providers/:id with a malformed id returns 400 instead of crashing", async () => {
    const { status } = await del("/providers/%");
    expect(status).toBe(400);
  });

  it("POST /fs/pick-directory returns the chosen path", async () => {
    const picker = await createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: { pick: async () => "/tmp/chosen" },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, {
      method: "POST",
      headers: authHeaders(picker.launchToken),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/tmp/chosen" });

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/pick-directory reports a cancellation as a null path", async () => {
    const picker = await createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: { pick: async () => null },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, {
      method: "POST",
      headers: authHeaders(picker.launchToken),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: null });

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/pick-directory maps an unsupported platform to 501", async () => {
    const picker = await createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: {
        pick: async () => {
          throw new PickerUnsupportedError("no dialog here");
        },
      },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, {
      method: "POST",
      headers: authHeaders(picker.launchToken),
    });
    expect(response.status).toBe(501);

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/pick-directory maps a busy picker to 409", async () => {
    const picker = await createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: {
        pick: async () => {
          throw new PickerBusyError("A directory picker is already open");
        },
      },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, {
      method: "POST",
      headers: authHeaders(picker.launchToken),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "A directory picker is already open" });

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/pick-directory maps a timeout to 504", async () => {
    const picker = await createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: {
        pick: async () => {
          throw new CommandTimeoutError("osascript timed out after 120000ms");
        },
      },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, {
      method: "POST",
      headers: authHeaders(picker.launchToken),
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "osascript timed out after 120000ms" });

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/reveal opens the file manager for an absolute path", async () => {
    const revealed: string[] = [];
    const picker = await createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      pathRevealer: {
        reveal: async (target: string) => {
          revealed.push(target);
        },
      },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/reveal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(picker.launchToken),
      },
      body: JSON.stringify({ path: "/tmp/project" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(revealed).toEqual(["/tmp/project"]);

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/reveal rejects a missing path with 400", async () => {
    const response = await fetch(`${baseUrl}/fs/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("POST /fs/reveal maps an unsupported platform to 501", async () => {
    const picker = await createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      pathRevealer: {
        reveal: async () => {
          throw new RevealUnsupportedError("no file manager here");
        },
      },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/reveal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(picker.launchToken),
      },
      body: JSON.stringify({ path: "/tmp/x" }),
    });
    expect(response.status).toBe(501);

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });
});

describe("POST /approvals", () => {
  it("rejects a body with no callId", async () => {
    const response = await fetch(`${baseUrl}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ sessionId: "s1", decision: "allow" }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects an unsupported decision", async () => {
    const response = await fetch(`${baseUrl}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ sessionId: "s1", callId: "c1", decision: "maybe" }),
    });

    expect(response.status).toBe(400);
  });

  it("answers 409 for a callId nobody is waiting on", async () => {
    // 409 rather than a silent 200: "there was no such approval" is a real
    // answer a client can act on (e.g. its card is stale). No /events
    // channel was ever attached for "s1" in this describe block, so this
    // exercises the "no live connection, nothing to protect" branch of
    // decideApproval — see sessions.ts's own doc comment.
    const response = await fetch(`${baseUrl}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ sessionId: "s1", callId: "ghost", decision: "allow" }),
    });

    expect(response.status).toBe(409);
  });

  it("rejects allow_always instead of silently downgrading it to allow", async () => {
    // The retired grant. An old client must get a clear error, never a
    // one-shot allow it did not ask for.
    const response = await fetch(`${baseUrl}/approvals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${launchToken}`,
      },
      body: JSON.stringify({
        sessionId: "s1",
        callId: "c1",
        decision: "allow_always",
        token: "whatever",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("a downgrade is not overridden by anything granted earlier", async () => {
    // I2's original defect shape: an approval granted under `auto` kept bash
    // running after the preset was downgraded to `read-only`. With one-shot
    // grants there is nothing left to outlive the downgrade.
    const { fsConfig } = buildSandboxConfigs("read-only", "/workspace", []);
    expect(fsConfig?.mode).toBe("read-only");
    const config = buildPermissionConfig("read-only");
    expect(config.rules).toBeUndefined();
    expect(decide(ceilingOf(config.sandbox), config.approval, "WRITE_HIGH")).toBe("deny");
  });
});

/**
 * A minimal ApprovalGate-shaped interface, local to these tests — avoids
 * pulling in `@volto/core`'s full `ApprovalGate` type just for a structural
 * cast.
 */
interface StubApprovalGate {
  ask(
    call: { id: string; name: string; input: unknown },
    tier: string,
  ): Promise<
    | "allow"
    | "deny"
    | { decision: "allow" | "deny"; reason?: string; answer?: string[] }
  >;
}

/**
 * An agent stub that, once its turn starts, calls straight into the real
 * `approvalGate` the registry built it with (see sessions.ts's `rebuild` —
 * `approvalGate: session.approvals.gate` is only passed when the turn's
 * `permissionMode` is set) and parks on its decision, exactly like a real
 * WRITE_HIGH tool call would under the "ask" preset. `asked` resolves the
 * instant the gate is consulted, so a test can synchronize on "the approval
 * is now genuinely pending" without polling.
 */
function makeApprovalPendingFactory() {
  let resolveAsked!: () => void;
  const asked = new Promise<void>((resolve) => {
    resolveAsked = resolve;
  });
  let resultText = "";
  let rawResult: unknown;
  const factory = (opts: Record<string, unknown>) => {
    const approvalGate = opts["approvalGate"] as StubApprovalGate | undefined;
    return {
      async *stream() {
        if (!approvalGate) {
          yield { type: "text_delta", data: { text: "no-gate" } };
          return;
        }
        resolveAsked();
        const raw = await approvalGate.ask({ id: "call-1", name: "bash", input: {} }, "WRITE_HIGH");
        // The full gate result (decision, reason, and any user answer) for
        // tests that need to assert beyond the bare decision.
        rawResult = raw;
        // The gate may answer with a bare decision or an ApprovalResult.
        const decision = typeof raw === "string" ? raw : raw.decision;
        resultText = decision;
        yield { type: "text_delta", data: { text: `decision:${decision}` } };
      },
      async getState() {
        return { messages: [] };
      },
    };
  };
  return { factory, asked, getResultText: () => resultText, getRawResult: () => rawResult };
}

/** Boots a dedicated server instance with a custom agentFactory (not modelPort). */
async function startEphemeralServerWithFactory(
  factory: unknown,
): Promise<{ base: string; launchToken: string; close(): Promise<void> }> {
  const instance = await createServer({ port: 0, agentFactory: factory as never });
  await new Promise<void>((resolve) => instance.on("listening", resolve));
  const addr = instance.address();
  const base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
  return {
    base,
    launchToken: instance.launchToken,
    close: () => new Promise<void>((resolve) => instance.close(() => resolve())),
  };
}

/** Extract the token from a channel's CONNECTED frame, waiting for it to arrive. */
async function connectedToken(channel: { frames: ProtocolFrame[] }): Promise<string> {
  await until(() => channel.frames.some((f) => f.event === "connected"), 2000, "no CONNECTED frame arrived");
  const frame = channel.frames.find((f) => f.event === "connected")!;
  return (frame.data as { token: string }).token;
}

/**
 * Like makeApprovalPendingFactory, but parks a real bash command so the
 * remember flow has something to derive a rule from. Counts builds so the
 * next-turn rebuild is observable. Only parks an approval when the gate is
 * present AND `asked` hasn't resolved yet; subsequent calls yield immediately
 * so a second turn completes.
 */
function makeRememberFactory(command: string) {
  let resolveAsked!: () => void;
  const asked = new Promise<void>((resolve) => {
    resolveAsked = resolve;
  });
  let didPark = false;
  const builds: Array<Record<string, unknown>> = [];
  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    const approvalGate = opts["approvalGate"] as StubApprovalGate | undefined;
    return {
      async *stream() {
        // Park only once — the first session turn that has a gate.
        if (approvalGate && !didPark) {
          didPark = true;
          resolveAsked();
          const raw = await approvalGate.ask(
            { id: "call-1", name: "bash", input: { command } },
            "WRITE_HIGH",
          );
          const decision = typeof raw === "string" ? raw : raw.decision;
          yield { type: "text_delta", data: { text: `decision:${decision}` } };
        } else {
          yield { type: "text_delta", data: { text: "ok" } };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
      async getState() {
        return { messages: [] };
      },
    };
  };
  return { factory, asked, builds };
}

describe("POST /approvals — per-connection token binding (real turn, real approval gate)", () => {
  it("no token: rejected with 403, approval stays pending", async () => {
    const { factory, asked } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-token-no-token-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(10);

      const config = await createTestProjectAndModel();
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const noToken = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow" },
        base,
        ephemeralToken,
      );
      expect(noToken.status).toBe(403);

      // Still pending: the *right* token settles it right after.
      const withToken = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token },
        base,
        ephemeralToken,
        );
      expect(withToken.status).toBe(202);
    } finally {
      channel.stop();
      await close();
    }
  });

  it("wrong token: rejected with 403, approval stays pending", async () => {
    const { factory, asked } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-token-wrong-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);

      const config = await createTestProjectAndModel();
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const wrongToken = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token: `not-${token}` },
        base,
        ephemeralToken,
        );
      expect(wrongToken.status).toBe(403);

      // Still pending: the *right* token settles it right after.
      const withToken = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token },
        base,
        ephemeralToken,
        );
      expect(withToken.status).toBe(202);
    } finally {
      channel.stop();
      await close();
    }
  });

  it("right token: 202, and the gate actually settles (the stub observes the decision)", async () => {
    const { factory, asked, getResultText } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-token-right-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);

      const config = await createTestProjectAndModel();
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const response = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token },
        base,
        ephemeralToken,
        );
      expect(response.status).toBe(202);

      await until(() => getResultText() === "allow", 2000, "gate never actually settled");
    } finally {
      channel.stop();
      await close();
    }
  });

  it("a wrong token is never distinguishable from an unknown callId: both answer 403 when a connection exists", async () => {
    const { factory, asked } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-token-uniform-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);

      const config = await createTestProjectAndModel();
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const wrongTokenKnownCall = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token: "wrong" },
        base,
        ephemeralToken,
        );
      const wrongTokenUnknownCall = await post(
        "/approvals",
        { sessionId, callId: "totally-unknown", decision: "allow", token: "wrong" },
        base,
        ephemeralToken,
        );

      // Same status either way, and the message only ever echoes back the
      // caller's OWN callId (never reveals anything the caller didn't
      // already know) — an unauthenticated caller learns nothing about
      // whether "call-1" is actually pending versus made up.
      expect(wrongTokenKnownCall.status).toBe(403);
      expect(wrongTokenUnknownCall.status).toBe(403);
      expect((wrongTokenKnownCall.data as { error: string }).error).toBe(
        "No pending approval call-1 for session " + sessionId,
      );
      expect((wrongTokenUnknownCall.data as { error: string }).error).toBe(
        "No pending approval totally-unknown for session " + sessionId,
      );

      // The real approval is still there, waiting.
      const settle = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token },
        base,
        ephemeralToken,
        );
      expect(settle.status).toBe(202);
    } finally {
      channel.stop();
      await close();
    }
  });

  it("self-dismantling property: a second /events subscription for the same session denies every pending approval", async () => {
    const { factory, asked, getResultText } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-token-dismantle-${Date.now()}`;
    const channelA = openEventChannel(sessionId, undefined, base, ephemeralToken);
    let channelB: ReturnType<typeof openEventChannel> | undefined;
    try {
      await channelA.opened;
      const tokenA = await connectedToken(channelA);

      const config = await createTestProjectAndModel();
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      // A second subscriber — e.g. an attacker who reaches /events for the
      // same sessionId to try to steal the token — opens its own channel.
      channelB = openEventChannel(sessionId, undefined, base, ephemeralToken);
      await channelB.opened;
      const tokenB = await connectedToken(channelB);
      expect(tokenB).not.toBe(tokenA);

      // The act of attaching a new connection is what dismantles the
      // attack: every pending approval is denied, regardless of who
      // subscribed — see sessions.ts's `detach`.
      await until(() => getResultText() === "deny", 2000, "pending approval was not denied");

      // Already settled: even the CURRENT connection's own valid token
      // cannot re-settle it.
      const response = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token: tokenB },
        base,
        ephemeralToken,
        );
      expect(response.status).toBe(409);
    } finally {
      channelA.stop();
      channelB?.stop();
      await close();
    }
  });
});

describe("POST /approvals — remembering a rule", () => {
  let previousConfigDir: string | undefined;
  let rememberConfigDir: string;

  beforeEach(async () => {
    // Capture AFTER beforeAll has set the env to its temp dir — a const at
    // describe scope would run before beforeAll and see `undefined`.
    previousConfigDir = process.env["VOLTO_CONFIG_DIR"];
    rememberConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-remember-"));
    process.env["VOLTO_CONFIG_DIR"] = rememberConfigDir;
  });
  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
    else process.env["VOLTO_CONFIG_DIR"] = previousConfigDir;
    await fs.rm(rememberConfigDir, { recursive: true, force: true });
  });

  /** Create a project and provider via the given server (not the global one). */
  async function createProjectOn(
    base: string,
    token: string,
  ): Promise<{ projectId: string; providerId: string; modelId: string }> {
    const project = await post("/projects", { name: "remember-test", path: process.cwd() }, base, token);
    const provider = await post(
      "/providers",
      { name: "remember-provider", models: [{ name: "test-model", code: "test-model" }] },
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

  it("writes the remembered prefix and rebuilds on the next turn", async () => {
    const { factory, asked, builds } = makeRememberFactory("pnpm test --filter x");
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `remember-write-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const connectionToken = await connectedToken(channel);
      const config = await createProjectOn(base, ephemeralToken);
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const response = await post(
        "/approvals",
        {
          sessionId,
          callId: "call-1",
          decision: "allow",
          token: connectionToken,
          remember: { prefixTokens: 2 },
        },
        base,
        ephemeralToken,
      );
      expect(response.status).toBe(202);
      const body = response.data as {
        status: string;
        remembered?: {
          rule: { toolName: string; commandPrefix: string[]; decision: string };
          outcome: string;
          effectiveFrom: string;
        };
      };
      expect(body.status).toBe("ok");
      expect(body.remembered).toMatchObject({
        rule: { toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" },
        outcome: "saved",
        effectiveFrom: "next_turn",
      });

      // The durable record is the file, in the shape the loader accepts.
      const rules = await loadPermissionRules(rememberConfigDir);
      expect(rules).toEqual([
        { toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" },
      ]);

      // A second turn rebuilds because the session is dirty.
      const buildsBefore = builds.length;
      await post(
        "/messages",
        { sessionId, message: "again", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      // The second turn triggers a rebuild because permissionsDirty is true.
      await until(() => builds.length > buildsBefore, 5000, "session did not rebuild");
      expect(builds.length).toBeGreaterThan(buildsBefore);
    } finally {
      channel.stop();
      await close();
    }
  });

  it("reports a prefix longer than the command without writing anything", async () => {
    // Command is "pnpm test --filter x" (4 tokens); request prefix 5.
    const { factory, asked } = makeRememberFactory("pnpm test --filter x");
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `remember-long-prefix-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const connectionToken = await connectedToken(channel);
      const config = await createProjectOn(base, ephemeralToken);
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const response = await post(
        "/approvals",
        {
          sessionId,
          callId: "call-1",
          decision: "allow",
          token: connectionToken,
          remember: { prefixTokens: 5 },
        },
        base,
        ephemeralToken,
      );
      expect(response.status).toBe(202);
      const body = response.data as { remembered?: unknown; rememberError?: string };
      expect(body.remembered).toBeUndefined();
      expect(body.rememberError).toBeDefined();
      expect(body.rememberError).toMatch(/prefix/i);
      // permissions.json must not exist.
      await expect(fs.readFile(path.join(rememberConfigDir, "permissions.json"), "utf-8")).rejects.toThrow();
    } finally {
      channel.stop();
      await close();
    }
  });

  it("refuses to remember for a call with no command", async () => {
    // Reuse makeApprovalPendingFactory which parks { id: "call-1", name: "bash", input: {} }
    const { factory, asked } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `remember-no-cmd-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const connectionToken = await connectedToken(channel);
      const config = await createProjectOn(base, ephemeralToken);
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const response = await post(
        "/approvals",
        {
          sessionId,
          callId: "call-1",
          decision: "allow",
          token: connectionToken,
          remember: { prefixTokens: 1 },
        },
        base,
        ephemeralToken,
      );
      expect(response.status).toBe(202);
      const body = response.data as { remembered?: unknown; rememberError?: string };
      expect(body.remembered).toBeUndefined();
      expect(body.rememberError).toBeDefined();
      expect(body.rememberError).toMatch(/command/i);
      // permissions.json must not exist.
      await expect(fs.readFile(path.join(rememberConfigDir, "permissions.json"), "utf-8")).rejects.toThrow();
    } finally {
      channel.stop();
      await close();
    }
  });

  it("still allows the call when the rule cannot be saved", async () => {
    // chmod the config dir read-only before answering: the approval must still
    // settle as allow, and the body must carry rememberError — never remembered.
    const { factory, asked } = makeRememberFactory("ls -la");
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `remember-save-fail-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const connectionToken = await connectedToken(channel);
      const config = await createProjectOn(base, ephemeralToken);
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      // Make the config dir read-only so the save fails.
      await fs.chmod(rememberConfigDir, 0o555);

      const response = await post(
        "/approvals",
        {
          sessionId,
          callId: "call-1",
          decision: "allow",
          token: connectionToken,
          remember: { prefixTokens: 1 },
        },
        base,
        ephemeralToken,
      );
      // The approval itself must have settled — the stub saw "allow".
      // The remember error is a sidecar, not a replacement.
      expect(response.status).toBe(202);
      const body = response.data as { remembered?: unknown; rememberError?: string };
      expect(body.remembered).toBeUndefined();
      expect(body.rememberError).toBeTruthy();
    } finally {
      // Restore perms so cleanup can delete the dir.
      await fs.chmod(rememberConfigDir, 0o755);
      channel.stop();
      await close();
    }
  });

  it("rejects a non-object remember with 400 and leaves the approval pending", async () => {
    const { factory, asked } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-remember-nonobj-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);

      const config = await createProjectOn(base, ephemeralToken);
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const response = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token, remember: "yes" },
        base,
        ephemeralToken,
      );
      expect(response.status).toBe(400);
      expect((response.data as { error: string }).error).toBe("remember must be an object");

      // The approval is still pending — the malformed body did not settle anything.
      const retry = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token },
        base,
        ephemeralToken,
      );
      expect(retry.status).toBe(202);
    } finally {
      channel.stop();
      await close();
    }
  });

  it("rejects unknown keys inside remember with 400", async () => {
    const { factory, asked } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-remember-smuggle-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);

      const config = await createProjectOn(base, ephemeralToken);
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const response = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token, remember: { prefixTokens: 2, decision: "deny" } },
        base,
        ephemeralToken,
      );
      expect(response.status).toBe(400);
      expect((response.data as { error: string }).error).toContain("unknown key");

      // Still pending — same approval can be settled with a clean body.
      const retry = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token },
        base,
        ephemeralToken,
      );
      expect(retry.status).toBe(202);
    } finally {
      channel.stop();
      await close();
    }
  });

  it("rejects a non-integer prefixTokens", async () => {
    const { factory, asked } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-remember-nonint-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);

      const config = await createProjectOn(base, ephemeralToken);
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      for (const remember of [{ prefixTokens: "2" }, { prefixTokens: 0 }, { prefixTokens: -1 }, { prefixTokens: 1.5 }, {}]) {
        const response = await post(
          "/approvals",
          { sessionId, callId: "call-1", decision: "allow", token, remember },
          base,
          ephemeralToken,
        );
        expect(response.status).toBe(400);
      }
    } finally {
      channel.stop();
      await close();
    }
  });

  it("rejects remember on a deny decision with 400", async () => {
    const { factory, asked } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-remember-deny-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);

      const config = await createProjectOn(base, ephemeralToken);
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const response = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "deny", token, remember: { prefixTokens: 1 } },
        base,
        ephemeralToken,
      );
      expect(response.status).toBe(400);
      expect((response.data as { error: string }).error).toBe("remember is only valid with decision: allow");

      // Still pending.
      const retry = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", token },
        base,
        ephemeralToken,
      );
      expect(retry.status).toBe(202);
    } finally {
      channel.stop();
      await close();
    }
  });
});

describe("POST /approvals — carrying the user's answer", () => {
  it("rejects a non-string-array answer with 400 and leaves the approval pending", async () => {
    const { factory, asked } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-answer-invalid-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);

      const config = await createTestProjectAndModel();
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const response = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", answer: "not-an-array", token },
        base,
        ephemeralToken,
        );
      expect(response.status).toBe(400);
      expect((response.data as { error: string }).error).toBe(
        "answer must be an array of strings",
      );

      // The malformed body must not have settled anything: the same approval
      // is still pending and a well-formed answer settles it afterwards.
      const retry = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", answer: ["a"], token },
        base,
        ephemeralToken,
        );
      expect(retry.status).toBe(202);
    } finally {
      channel.stop();
      await close();
    }
  });

  it("carries a valid answer into the ApprovalResult the gate resolves with", async () => {
    const { factory, asked, getRawResult } = makeApprovalPendingFactory();
    const { base, launchToken: ephemeralToken, close } = await startEphemeralServerWithFactory(factory);
    const sessionId = `approval-answer-valid-${Date.now()}`;
    const channel = openEventChannel(sessionId, undefined, base, ephemeralToken);
    try {
      await channel.opened;
      const token = await connectedToken(channel);

      const config = await createTestProjectAndModel();
      await post(
        "/messages",
        { sessionId, message: "hi", permissionMode: "ask", ...config },
        base,
        ephemeralToken,
      );
      await asked;

      const response = await post(
        "/approvals",
        { sessionId, callId: "call-1", decision: "allow", answer: ["a"], token },
        base,
        ephemeralToken,
        );
      expect(response.status).toBe(202);

      // The stub records whatever the real approval gate resolved with —
      // the answer must have ridden all the way through the route.
      await until(() => getRawResult() !== undefined, 2000, "gate never actually settled");
      expect(getRawResult()).toMatchObject({ decision: "allow", answer: ["a"] });
    } finally {
      channel.stop();
      await close();
    }
  });
});

describe("legacy shared agent (no sessionId) permission posture", () => {
  /**
   * `/run` without a sessionId, `/stream`, and `/resume` all share one
   * process-wide agent built once at createServer() time (server.ts, near
   * the `createWiredAgent(agentOpts)` call). None of those routes can present
   * an approval to a human or accept a decision back, so that agent must not
   * resolve to createAgent()'s own defaults (workspace-write + auto-allow
   * gate) by omission — it needs an explicit, narrow posture instead, same
   * reasoning as sessions.ts's EMPTY_CONFIG.
   */
  it("builds the shared agent with approval: never and a non-danger-full-access sandbox", async () => {
    const builds: Array<Record<string, unknown>> = [];
    const stubAgent = { async *stream() {}, async resume() {} };
    const factory = (opts: Record<string, unknown>) => {
      builds.push(opts);
      return stubAgent as never;
    };

    const instance = await createServer({ port: 0, agentFactory: factory as never });
    await new Promise<void>((resolve) => instance.on("listening", resolve));
    try {
      expect(builds).toHaveLength(1);
      const built = builds[0]!;
      const permissionConfig = built["permissionConfig"] as { approval?: string } | undefined;
      expect(permissionConfig?.approval).toBe("never");
      expect(built["sandboxMode"]).toBeDefined();
      expect(built["sandboxMode"]).not.toBe("danger-full-access");
    } finally {
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    }
  });
});
