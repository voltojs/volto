/**
 * Shared test-server bootstrap for headless-server integration tests.
 *
 * Encapsulates the createServer + temp-dir + auth boilerplate that every
 * route test needs, so each test file only declares what it actually
 * exercises.
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelPort } from "@volto/core";
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
interface FrameEventPayload {
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
    close: async () => {
      if (settleTimer) clearTimeout(settleTimer);
      eventsReq?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(configDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
