import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  modelDone,
  textDelta,
  toolUseDelta,
  toolUseStart,
  usage,
} from "@volto/core";
import type {
  ModelPort,
  ModelRequest,
  TranscriptEventInput,
  TranscriptStore,
} from "@volto/core";
import { createWiredAgent } from "../wiring.js";
import { sandboxModeFor } from "../permission-modes.js";

/**
 * Host-level proof of the window-aware compaction threshold.
 *
 * The wired agent resolves the model window through `describeModel` and
 * passes it to createAgent, which derives the threshold (0.6 × window). A
 * 10k window therefore compacts after ~6k heuristic tokens; the old fixed 60k
 * would never have compacted this turn. Also pins that the summarizer's usage
 * reaches the durable transcript.
 */

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-wincompact-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-wincompact-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-wincompact-home-"));
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

const SUMMARY_PREFIX = "[Earlier conversation summary]";

describe("window-aware compaction on a real wired session", () => {
  it(
    "compacts a 10k-window session and records the summarizer usage",
    { timeout: 60_000 },
    async () => {
      await fs.writeFile(path.join(tempProjectDir, "probe.txt"), "x".repeat(2_000), "utf-8");

      const requests: ModelRequest[] = [];
      const described: string[] = [];
      let rounds = 0;
      const modelPort: ModelPort = {
        async *stream(req) {
          requests.push(req);
          if (req.messages.length === 1 && req.messages[0]?.id === "compaction-summary-prompt") {
            yield usage(100, 20);
            yield textDelta("SUMMARY");
            yield modelDone("end_turn");
            return;
          }
          if (
            req.messages.some(
              (m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_PREFIX),
            )
          ) {
            yield textDelta("done");
            yield modelDone("end_turn");
            return;
          }
          rounds += 1;
          if (rounds > 40) {
            yield textDelta("stop");
            yield modelDone("end_turn");
            return;
          }
          yield usage(100, 10);
          yield toolUseStart(`r${rounds}`, "read_file");
          yield toolUseDelta(`r${rounds}`, JSON.stringify({ path: "probe.txt" }));
          yield modelDone("tool_use");
        },
        async describeModel(model: string) {
          described.push(model);
          return { model, contextWindow: 10_000 };
        },
      };

      const transcript = captureTranscript();
      const agent = await createWiredAgent({
        modelPort,
        cwd: tempProjectDir,
        // No maxTokens: derived from the described 10k window (0.6 → 6k).
        // The default 65,536 headroom would exhaust a 10k window, so this
        // small-window session overrides it explicitly.
        compaction: { recentKeepCount: 1, windowRatio: 0.6, headroomTokens: 1_000 },
        permissionMode: "auto",
        sandboxMode: sandboxModeFor("auto"),
        chatStore: transcript.store,
        chatSessionId: "window-compaction-session",
      });
      let status: string;
      try {
        const final = await agent.run("read probe.txt until compaction");
        status = final.status;
      } finally {
        await agent.dispose();
      }

      expect(status).toBe("done");
      // The wired agent asked the port for the window before constructing.
      expect(described.length).toBeGreaterThan(0);

      const compaction = transcript.events.find((e) => e.type === "compaction");
      expect(compaction).toBeDefined();
      expect((compaction!.data as { replacedCount: number }).replacedCount).toBeGreaterThan(0);
      expect((compaction!.data as { usage?: unknown }).usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
      });

      // The post-compaction request carries the summary as a USER message.
      const post = requests.find((req) =>
        req.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith(SUMMARY_PREFIX),
        ),
      );
      expect(post).toBeDefined();
    },
  );
});
