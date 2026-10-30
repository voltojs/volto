/**
 * Shared test-server bootstrap for headless-server integration tests.
 *
 * Encapsulates the createServer + temp-dir + auth boilerplate that every
 * route test needs, so each test file only declares what it actually
 * exercises. Two bootstraps live here: `startTestServer` (attachments/vision
 * tests) and `startRouteTestServer` (agents/tools route tests) — they grew
 * independently for different route surfaces and return different shapes.
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelPort, ModelRequest, ToolDefinition } from "@volto/core";
import type { AgentSpec } from "@volto/sdk";
import { createStore } from "@volto/store-jsonl";
import { createServer, type HeadlessServer } from "../server.js";

/** Minimal model port that immediately ends the turn. */
const IDLE_MODEL: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

/** One parsed SSE frame from the /events channel. */
interface EventFrame {
  id: string;
  event: string;
  data: unknown;
}

/** Hard cap on how long captureMessages waits for a turn to settle. */
const CAPTURE_TIMEOUT_MS = 8_000;

export interface TranscriptMessage {
  role: string;
  content: unknown;
}

export interface TestServer {
  /** Base URL of the running server, e.g. `http://localhost:31234`. */
  url: string;
  /** Launch token for Bearer auth. */
  token: string;
  /** Primary session id used by the test. */
  sessionId: string;
  /** A second, distinct session id for cross-session isolation tests. */
  otherSessionId: string;
  /** Absolute path of the temporary VOLTO_CONFIG_DIR. */
  configDir: string;
  /** Absolute path of the attachment store root (configDir/attachments). */
  attachmentRoot: string;
  /**
   * projectId / providerId / modelId for a POST /messages body —
   * resolveConfig rejects a turn that does not name all three.
   */
  turnConfig: { projectId: string; providerId: string; modelId: string };
  /**
   * Open the session's GET /events stream and start collecting frames.
   * Resolves once the channel is attached (the `connected` frame arrived),
   * so a subsequent POST /messages is never rejected with 409.
   */
  openEvents: (sessionId?: string) => Promise<void>;
  /**
   * Wait for the in-flight turn to settle (a `turn_end` frame, or a quiet
   * window) and return the user/assistant transcript messages collected
   * from `event` frames so far, in arrival order.
   */
  captureMessages: () => Promise<TranscriptMessage[]>;
  /** Number of `turn_start` frames seen since the stream opened. */
  turnCount: () => number;
  /**
   * Every `event` frame's payload seen since the channel (re)opened, in
   * arrival order — for tests that assert an out-of-band push (a title
   * change) rather than a turn's transcript.
   */
  events: () => FrameEventPayload[];
  /** Shut down the server and clean up the temp config dir. */
  close: () => Promise<void>;
}

/** Parse the SSE wire format into frames, ignoring incomplete trailing data. */
function parseFrames(raw: string): EventFrame[] {
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
        data: JSON.parse(frame["data"] ?? "null") as unknown,
      };
    });
}

/** Payload shape of an `event` frame: a stamped TranscriptEventInput. */
export interface FrameEventPayload {
  type: string;
  data: Record<string, unknown>;
  time: number;
  turn?: number;
}

function isEventPayload(data: unknown): data is FrameEventPayload {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { type?: unknown }).type === "string" &&
    typeof (data as { time?: unknown }).time === "number"
  );
}

export interface StartTestServerOptions {
  /**
   * Model port the gateway hands to createAgent. Defaults to IDLE_MODEL;
   * tests that need to inspect the assembled ModelRequest inject a
   * capturing port here.
   */
  modelPort?: ModelPort;
}

export async function startTestServer(opts: StartTestServerOptions = {}): Promise<TestServer> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-test-"));
  process.env["VOLTO_CONFIG_DIR"] = configDir;

  const server: HeadlessServer = await createServer({
    port: 0,
    modelPort: opts.modelPort ?? IDLE_MODEL,
    chatStore: createStore({ directory: configDir }),
  });

  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const url = `http://localhost:${port}`;
  const token = server.launchToken;
  const attachmentRoot = path.join(configDir, "attachments");

  const authJson = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  // A turn requested through POST /messages must name a real project and
  // model — resolveConfig rejects anything less. Create both once here so
  // every test can spread `turnConfig` into its request body.
  const project = (await (
    await fetch(`${url}/projects`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({ name: "test-project", path: configDir }),
    })
  ).json()) as { id: string };
  const provider = (await (
    await fetch(`${url}/providers`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({
        name: "test-provider",
        models: [{ name: "test-model", code: "test-model" }],
      }),
    })
  ).json()) as { id: string; models: Array<{ id: string }> };
  const turnConfig = {
    projectId: project.id,
    providerId: provider.id,
    modelId: provider.models[0]!.id,
  };

  // ── /events collection ──────────────────────────────────────────────
  let rawSse = "";
  let frames: EventFrame[] = [];
  let eventsReq: http.ClientRequest | undefined;
  /** Settle timers keyed by generation so a newer frame cancels the old. */
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function absorb(chunk: string): void {
    rawSse += chunk;
    // Reparse the whole buffer: frames are small in tests and this avoids
    // hand-rolling a partial-frame state machine.
    frames = parseFrames(rawSse);
  }

  function eventPayloads(): FrameEventPayload[] {
    return frames
      .filter((f) => f.event === "event")
      .map((f) => f.data)
      .filter(isEventPayload);
  }

  async function openEvents(sessionId?: string): Promise<void> {
    // Opening a new channel replaces the previous one: destroy the old
    // request and clear the buffer so a second session's frames are not
    // mixed with (or short-circuited by) the first session's turn_end.
    eventsReq?.destroy();
    rawSse = "";
    frames = [];
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    const sid = sessionId ?? "test-session";
    return new Promise<void>((resolve, reject) => {
      const req = http.get(
        `${url}/events?sessionId=${encodeURIComponent(sid)}`,
        { headers: { authorization: `Bearer ${token}` } },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`GET /events returned ${res.statusCode}`));
            res.resume();
            return;
          }
          res.on("data", (chunk: Buffer) => {
            const before = frames.length;
            absorb(chunk.toString("utf-8"));
            // Resolve once the per-connection `connected` frame has arrived —
            // that frame is written only after the channel is attached, so
            // hasConnection() is already true by the time the caller proceeds.
            if (!resolved && frames.some((f) => f.event === "connected")) {
              resolved = true;
              resolve();
            }
            void before;
          });
          res.on("error", reject);
        },
      );
      let resolved = false;
      req.on("error", reject);
      eventsReq = req;
    });
  }

  function turnCount(): number {
    return eventPayloads().filter((e) => e.type === "turn_start").length;
  }

  function snapshotMessages(): TranscriptMessage[] {
    return eventPayloads()
      .filter((e) => e.type === "user_message" || e.type === "assistant_message")
      .map((e) => ({
        role: e.type === "user_message" ? "user" : "assistant",
        content: e.data["content"],
      }));
  }

  async function captureMessages(): Promise<TranscriptMessage[]> {
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    return new Promise<TranscriptMessage[]>((resolve, reject) => {
      const check = (): void => {
        const payloads = eventPayloads();
        // A turn is complete once its turn_end lands. Fall through to the
        // deadline check below when it has not yet.
        if (payloads.some((e) => e.type === "turn_end")) {
          if (settleTimer) clearTimeout(settleTimer);
          resolve(snapshotMessages());
          return;
        }
        if (Date.now() > deadline) {
          if (settleTimer) clearTimeout(settleTimer);
          reject(new Error("captureMessages: timed out waiting for turn_end"));
          return;
        }
        // Poll: frames arrive on the http stream and are absorbed there;
        // this loop only watches for the terminal condition.
        settleTimer = setTimeout(check, 25);
      };
      check();
    });
  }

  return {
    url,
    token,
    sessionId: "test-session",
    otherSessionId: "other-session",
    configDir,
    attachmentRoot,
    turnConfig,
    openEvents,
    captureMessages,
    turnCount,
    events: eventPayloads,
    close: async () => {
      if (settleTimer) clearTimeout(settleTimer);
      eventsReq?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(configDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export interface StartRouteTestServerOptions {
  /** Plugin-provided agent specs the /agents routes list as read-only entries. */
  pluginAgents?: AgentSpec[];
}

export interface TestServerHandle {
  /** Base URL of the listening server, e.g. `http://localhost:31234`. */
  url: string;
  /** Bearer token for authenticated requests. */
  token: string;
  /** Id of a project created at startup, for `?projectId=` routes. */
  projectId: string;
  /**
   * Writes a project-scope agent definition into the temp project's
   * `.volto/agents/` — the directory the store writes to and the scanner
   * reads from when the server's cwd is that project.
   */
  writeProjectAgent: (name: string, systemPrompt: string) => Promise<void>;
  /** Writes a user-scope agent definition into the temp config dir's `agents/`. */
  writeUserAgent: (name: string, systemPrompt: string) => Promise<void>;
  /**
   * Tool definitions from the most recent model call — the exact list the
   * model was offered. Empty before the first turn.
   */
  captureToolDefinitions: () => ToolDefinition[];
  /**
   * Runs one turn over a fresh session's /events channel: opens SSE, POSTs
   * /messages with the harness project/provider/model binding, and resolves
   * once the turn's `turn_end` transcript event arrives.
   */
  runTurn: (message: string) => Promise<void>;
  /** Closes the server and removes this call's temp dirs. */
  close: () => Promise<void>;
}

/** Minimal definition file: frontmatter name plus the body as systemPrompt. */
function renderAgentFile(name: string, systemPrompt: string): string {
  return `---\nname: ${name}\n---\n\n${systemPrompt}\n`;
}

async function writeAgentFile(dir: string, name: string, systemPrompt: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.md`), renderAgentFile(name, systemPrompt), "utf8");
}

/**
 * Boots an isolated headless server on an ephemeral port.
 *
 * Each call creates its own VOLTO_CONFIG_DIR / HOME temp dirs and a real
 * project row (POST /projects), and binds the server's default cwd to that
 * project — so project-scope agent writes land in the temp tree, never the
 * repo. HOME is redirected so os.homedir()-based instruction scans cannot
 * pick up the machine's real ~/.claude / ~/.agents files.
 */
export async function startRouteTestServer(
  options: StartRouteTestServerOptions = {},
): Promise<TestServerHandle> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-route-test-"));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-route-project-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-route-home-"));
  const previousConfigDir = process.env["VOLTO_CONFIG_DIR"];
  process.env["VOLTO_CONFIG_DIR"] = configDir;
  const previousHome = process.env["HOME"];
  process.env["HOME"] = homeDir;

  // Per-server capturing port: records every ModelRequest so tests can assert
  // the exact tool list the model was offered (the brief's `task` description
  // checks), while still completing the turn like the old shared stub.
  const capturedRequests: ModelRequest[] = [];
  const modelPort: ModelPort = {
    async *stream(req) {
      capturedRequests.push(req);
      yield { type: "text_delta", text: "" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };

  const server: HeadlessServer = await createServer({
    port: 0,
    modelPort,
    // Bind the default workspace to the temp project so /agents project-scope
    // reads and writes never touch the repository the suite runs from.
    cwd: projectDir,
    ...(options.pluginAgents ? { pluginAgents: options.pluginAgents } : {}),
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
  const token = server.launchToken;

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const createRes = await fetch(`${url}/projects`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "route-test-project", path: projectDir }),
  });
  if (!createRes.ok) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`startRouteTestServer: POST /projects failed with ${createRes.status}`);
  }
  const created = (await createRes.json()) as { id: string };

  // Provider + model the /messages turn binding must resolve — same shape
  // createTestProjectAndModel uses in server.test.ts / compact-endpoint.test.ts.
  const providerRes = await fetch(`${url}/providers`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "route-test-provider", models: [{ name: "test-model", code: "test-model" }] }),
  });
  if (!providerRes.ok) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`startRouteTestServer: POST /providers failed with ${providerRes.status}`);
  }
  const provider = (await providerRes.json()) as { id: string; models: Array<{ id: string }> };

  let turnCounter = 0;
  async function runTurn(message: string): Promise<void> {
    const sessionId = `harness-turn-${++turnCounter}`;
    // Open the /events channel first — POST /messages 409s without one — and
    // resolve on the turn's terminal transcript event (protocol v2 has no
    // terminal frame; turn end is a turn_end EVENT).
    await new Promise<void>((resolve, reject) => {
      const eventsUrl = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, url);
      const timer = setTimeout(() => reject(new Error("runTurn: timed out waiting for turn_end")), 10_000);
      const req = http.get(eventsUrl, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf-8");
          // Parse complete SSE blocks; keep any incomplete trailing data.
          const blocks = raw.split("\n\n");
          raw = blocks.pop() ?? "";
          for (const block of blocks) {
            const fields: Record<string, string> = {};
            for (const line of block.split("\n")) {
              const idx = line.indexOf(": ");
              if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 2);
            }
            if (fields["event"] !== "event") continue;
            const data = JSON.parse(fields["data"] ?? "null") as { type?: string };
            if (data.type === "turn_end") {
              clearTimeout(timer);
              req.destroy();
              resolve();
              return;
            }
            if (data.type === "error") {
              clearTimeout(timer);
              req.destroy();
              reject(new Error(`runTurn: turn errored: ${fields["data"]}`));
              return;
            }
          }
        });
        res.on("error", reject);

        void fetch(`${url}/messages`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            sessionId,
            message,
            projectId: created.id,
            providerId: provider.id,
            modelId: provider.models[0]!.id,
          }),
        }).then(async (postRes) => {
          if (!postRes.ok) {
            clearTimeout(timer);
            req.destroy();
            reject(new Error(`runTurn: POST /messages failed with ${postRes.status}`));
          }
        }, reject);
      });
      req.on("error", (err) => {
        // destroy() after resolving surfaces here; ignore once settled.
        if (!req.destroyed) reject(err);
      });
    });
  }

  return {
    url,
    token,
    projectId: created.id,
    writeProjectAgent: (name, systemPrompt) =>
      writeAgentFile(path.join(projectDir, ".volto", "agents"), name, systemPrompt),
    writeUserAgent: (name, systemPrompt) =>
      writeAgentFile(path.join(configDir, "agents"), name, systemPrompt),
    captureToolDefinitions: () => capturedRequests.at(-1)?.tools ?? [],
    runTurn,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      if (previousConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
      else process.env["VOLTO_CONFIG_DIR"] = previousConfigDir;
      // Best-effort transcript writes fired during a real turn may still be
      // landing as the server winds down, recreating a dir mid-remove — retry
      // like trajectory-e2e does rather than surfacing ENOTEMPTY.
      await fs.rm(configDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await fs.rm(projectDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}
