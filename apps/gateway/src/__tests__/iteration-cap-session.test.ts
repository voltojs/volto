import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModelPort, textScript, toolCallScript } from "@voltojs/core";
import type {
  ModelEvent,
  ModelPort,
  ModelRequest,
  TranscriptEventInput,
  TranscriptStore,
} from "@voltojs/core";
import { createWiredAgent } from "../wiring.js";
import { sandboxModeFor } from "../permission-modes.js";

/**
 * Regression (field report: long tasks "just stopped", no error, no notice).
 *
 * A turn that hits the core runaway guard used to end as `turn_end: done`:
 * the reducer's error emit is a raw, unstamped event, so the gateway dropped
 * it and the transcript kept only the clean completion. This runs a REAL
 * wired session (scripted ModelPort only) with `maxIterations: 2` and pins
 * that the cap now reaches the durable transcript as a turn_end error.
 */

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-itercap-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-itercap-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-itercap-home-"));
  originalConfigDir = process.env["VOLTO_CONFIG_DIR"];
  process.env["VOLTO_CONFIG_DIR"] = tempConfigDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tempHomeDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fs.rm(tempConfigDir, { recursive: true, force: true });
  await fs.rm(tempProjectDir, { recursive: true, force: true });
  await fs.rm(tempHomeDir, { recursive: true, force: true });
});

function captureModelPort(scripts: ModelEvent[][]): {
  modelPort: ModelPort;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(scripts);
  return {
    requests,
    modelPort: {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

function captureTranscript(): { store: TranscriptStore; events: TranscriptEventInput[] } {
  const events: TranscriptEventInput[] = [];
  return {
    events,
    store: {
      async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
        events.push(...batch);
      },
    },
  };
}

describe("iteration cap on a real wired session", () => {
  it(
    "the cap reaches the durable transcript as a turn_end error, not a clean done",
    { timeout: 60_000 },
    async () => {
      await fs.writeFile(path.join(tempProjectDir, "probe.txt"), "contents\n", "utf-8");

      // Two model calls; maxIterations 2 means the second one's tool call is
      // never dispatched — the exact shape users saw as a silent stop.
      const { modelPort, requests } = captureModelPort([
        toolCallScript("r1", "read_file", JSON.stringify({ path: "probe.txt" })),
        toolCallScript("r2", "read_file", JSON.stringify({ path: "probe.txt" })),
      ]);
      const transcript = captureTranscript();

      const agent = await createWiredAgent({
        modelPort,
        cwd: tempProjectDir,
        maxIterations: 2,
        permissionMode: "auto",
        sandboxMode: sandboxModeFor("auto"),
        chatStore: transcript.store,
        chatSessionId: "itercap-session",
      });
      let status: string;
      try {
        const final = await agent.run("read probe.txt");
        status = final.status;
      } finally {
        await agent.dispose();
      }

      expect(requests.length).toBe(2);
      expect(status).toBe("done");

      const turnEnd = transcript.events.find((e) => e.type === "turn_end");
      expect(turnEnd).toBeDefined();
      expect(turnEnd!.data).toMatchObject({
        reason: "error",
        error: "Maximum iterations reached",
      });
      // Stamped, so the gateway's SSE framer forwards it to the live client.
      expect(typeof turnEnd!.time).toBe("number");

      // The cap-hitting call was never dispatched: the model saw no result.
      expect(
        transcript.events.some(
          (e) => e.type === "tool_result" && (e.data as Record<string, unknown>)["callId"] === "r2",
        ),
      ).toBe(false);
    },
  );

  it(
    "without maxIterations a 25-round turn runs to completion (no default step cap)",
    { timeout: 60_000 },
    async () => {
      const rounds = 25;
      for (let i = 0; i < rounds; i++) {
        await fs.writeFile(path.join(tempProjectDir, `f${i}.txt`), `contents ${i}\n`, "utf-8");
      }
      const scripts = Array.from({ length: rounds }, (_, i) =>
        toolCallScript(`r${i}`, "read_file", JSON.stringify({ path: `f${i}.txt` })),
      );
      scripts.push(textScript("read all files"));

      const { modelPort, requests } = captureModelPort(scripts);
      const transcript = captureTranscript();

      const agent = await createWiredAgent({
        modelPort,
        cwd: tempProjectDir,
        // No maxIterations: the long-horizon default.
        permissionMode: "auto",
        sandboxMode: sandboxModeFor("auto"),
        chatStore: transcript.store,
        chatSessionId: "long-turn-session",
      });
      let status: string;
      try {
        const final = await agent.run("read every file");
        status = final.status;
      } finally {
        await agent.dispose();
      }

      expect(requests.length).toBe(rounds + 1);
      expect(status).toBe("done");

      const turnEnd = transcript.events.find((e) => e.type === "turn_end");
      expect(turnEnd).toBeDefined();
      expect(turnEnd!.data).toEqual({ turn: 1, reason: "done" });
      expect(
        transcript.events.some((e) => e.type === "error" || e.type === "model_error"),
      ).toBe(false);
    },
  );
});
