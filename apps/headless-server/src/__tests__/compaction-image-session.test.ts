import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { textScript } from "@volto/core";
import type { ContentBlock, ModelPort, ModelRequest } from "@volto/core";
import { createNodeAttachmentStore } from "@volto/runtime-node";
import { createWiredAgent } from "../wiring.js";
import { buildPermissionConfig, sandboxModeFor } from "../permission-modes.js";

/**
 * F-213 (roadmap F-024) — image preservation across compaction, observed on
 * a REAL session built through the gateway wiring (`createWiredAgent`),
 * asserted on the ModelRequests the model actually received and on the
 * attachment files that really land on disk.
 *
 * The session mirrors production flow: an image is stored via the same
 * node AttachmentStore the /attachments routes write to, and the user turn
 * carries it as a ref block (the gateway's POST /messages shape). A second,
 * inline-base64 image rides the same turn — the compaction offload path
 * (spec 2026-10-16 D1 path 2) must put those bytes to the store under a
 * deterministic id. A small `compaction.maxTokens` trips compaction on the
 * next turn; the scripted port answers the summarization call, then the
 * main call must carry the preserved images on the D5 v1.2 carrier: a
 * dedicated USER-role message right after the plain-string summary, whose
 * image refs `resolveImageRefs` has resolved back to base64 — the F-024
 * wire witness at the provider-bound request seam. All three providers
 * natively support user-role block-array images, so these bytes reach the
 * model's wire.
 */

/** 1×1 PNG — the smallest fixture, stolen from attachments-model-request. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The exact per-image marker line (core's renderImagePreservedMarker, verbatim). */
const MARKER = "[image preserved from compressed conversation: 1x1 image/png]";

const STORE_SESSION = "compaction-image-e2e";

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-compaction-image-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-compaction-image-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-compaction-image-home-"));
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

/**
 * Inline base64 image block — the compaction offload's D1 path 2. Core's
 * ImageContent is ref-only in types; the block-array runtime fact arrives
 * behind the same documented cast the runner uses (see runner.ts wire-shape
 * boundary), so this test constructs it the same way.
 */
const INLINE_IMAGE_BLOCK = {
  type: "image",
  source: { type: "base64", data: PNG_B64, mediaType: "image/png" },
  width: 1,
  height: 1,
} as unknown as ContentBlock;

/**
 * Per-call scripted capture port: the compaction summarization call is
 * routed by shape (single summary-prompt user message, no tools — exactly
 * what runCompactionWriteBack issues), every other call is a main turn
 * answered in order. Assertions land AFTER the run on the captured
 * requests, keeping failure output concise and pinpointed.
 */
function scriptedSessionPort(): { modelPort: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let mainCall = 0;
  const modelPort: ModelPort = {
    async *stream(req) {
      requests.push(req);
      const isSummaryCall =
        req.tools.length === 0 &&
        req.messages.length === 1 &&
        req.messages[0]?.id === "compaction-summary-prompt";
      if (isSummaryCall) {
        yield* textScript(
          "Checkpoint: the user shared a dashboard screenshot and asked for a latency read-out.",
        );
        return;
      }
      mainCall += 1;
      if (mainCall === 1) {
        yield* textScript("I can see a latency chart in the screenshot.");
        return;
      }
      yield* textScript("compaction round-trip verified");
    },
  };
  return { modelPort, requests };
}

/** The compaction summary message a request carries (D5 v1.2: a plain string). */
function summaryMessage(request: ModelRequest): { id: string; role: "user"; content: string } {
  for (const m of request.messages) {
    if (
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.startsWith("[Earlier conversation summary]")
    ) {
      return { id: m.id, role: "user", content: m.content };
    }
  }
  throw new Error("no string summary message in request");
}

/** The preserved-images carrier (D5 v1.2): marker-led user-role block array. */
function imagesCarrierBlocks(request: ModelRequest): ContentBlock[] {
  for (const m of request.messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const first = m.content[0];
    if (
      first?.type === "text" &&
      first.text.startsWith("[image preserved from compressed conversation:")
    ) {
      return m.content;
    }
  }
  throw new Error("no preserved-images carrier message in request");
}

/** A large but mundane telemetry dump — no file paths, so nothing is "key". */
function bigTelemetryText(): string {
  return ("telemetry sample recorded; pipeline stage nominal; queue depth stable;\n").repeat(80);
}

describe("F-213 real session — images survive compaction (roadmap F-024)", () => {
  it(
    "F-213 the post-compaction request carries the markers and resolved image bytes on the user-role carrier; the offloaded bytes land on disk",
    { timeout: 60_000 },
    async () => {
      // Real store, real disk — the same node store the /attachments routes
      // use, rooted inside the temp config dir.
      const storeRoot = path.join(tempConfigDir, "attachments");
      const store = createNodeAttachmentStore({ rootDir: storeRoot, sessionId: STORE_SESSION });

      // Upload path witness: bytes really persisted before the turn starts.
      const upload = await store.put(PNG_B64, "image/png");
      expect(upload.width).toBe(1);
      expect(upload.height).toBe(1);

      const { modelPort, requests } = scriptedSessionPort();

      // Production assembly; compaction with a small budget and a 2-message
      // recency window so the image turn falls into the compressible span.
      const agent = await createWiredAgent({
        modelPort,
        cwd: tempProjectDir,
        permissionMode: "read-only",
        sandboxMode: sandboxModeFor("read-only"),
        permissionConfig: buildPermissionConfig("read-only"),
        attachmentStore: store,
        compaction: { maxTokens: 600, recentKeepCount: 2, summaryMaxTokens: 128 },
      });

      let finalStatus: string;
      let finalMessages: unknown;
      try {
        // Turn 1: the image turn — a ref image (upload path) and an inline
        // base64 image (offload path) on the same user message.
        await agent.run({
          type: "user_message",
          content: [
            { type: "text", text: "here is the dashboard screenshot" },
            {
              type: "image",
              source: { type: "ref", id: upload.id, mediaType: "image/png" },
              width: 1,
              height: 1,
            },
            INLINE_IMAGE_BLOCK,
          ],
        });
        // Turn 2: enough fresh text to exceed the compaction budget. The
        // pre-request compaction replaces the image turn, offloads the
        // inline bytes under a deterministic id, and writes the summary back.
        const final = await agent.run(bigTelemetryText());
        finalStatus = final.status;
        finalMessages = final.messages;
      } finally {
        await agent.dispose();
      }

      // The choreography: turn-1 main call, the compaction summarization
      // call, then the post-compaction main call.
      expect(requests.length).toBe(3);
      const summaryReq = requests[1]!;
      expect(summaryReq.messages[0]?.id).toBe("compaction-summary-prompt");
      expect(summaryReq.tools).toHaveLength(0);

      // (a) The summary is a plain USER-role string (D5 v1.2 + the cache
      // placement fix: a system summary would be hoisted ahead of the
      // static context layers), and the preserved images ride a dedicated
      // USER-role message that comes after the summary in the request —
      // both marker lines verbatim. The reducer's insertAt+1 adjacency is
      // pinned in core's unit tests; here the ordering claim is
      // "carrier after summary".
      const post = requests[2]!;
      const summary = summaryMessage(post);
      expect(summary.content.startsWith("[Earlier conversation summary]\n")).toBe(true);
      const blocks = imagesCarrierBlocks(post);
      const summaryIdx = post.messages.findIndex((m) => m.id === summary.id);
      const carrierIdx = post.messages.findIndex((m) => m.content === blocks);
      expect(carrierIdx).toBeGreaterThan(summaryIdx);
      expect(post.messages[carrierIdx]?.role).toBe("user");
      const texts = blocks
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text);
      expect(texts.filter((t) => t === MARKER)).toHaveLength(2);

      // (b) The wire witness: both preserved refs resolved back to base64 on
      // the carrier — resolveImageRefs ran over the user-role block array.
      const images = blocks.filter(
        (b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image",
      );
      expect(images).toHaveLength(2);
      for (const image of images) {
        expect(image.source).toEqual({
          type: "base64",
          mediaType: "image/png",
          data: PNG_B64,
        });
        expect(image.width).toBe(1);
        expect(image.height).toBe(1);
      }

      // (c) The turn completed cleanly — the loop was never interrupted.
      expect(finalStatus).toBe("done");

      // Store round-trip on real disk: the canonical state keeps refs. The
      // upload ref rides its original id; the inline image was offloaded
      // under a deterministic (sanitized) id and its bytes are readable back
      // from the store directory.
      const finalList = finalMessages as Array<{ role: string; content: unknown }>;
      const finalCarrier = finalList.find(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          (m.content as ContentBlock[])[0]?.type === "text" &&
          ((m.content as ContentBlock[])[0] as { text: string }).text.startsWith(
            "[image preserved from compressed conversation:",
          ),
      );
      expect(finalCarrier).toBeDefined();
      const refIds = (finalCarrier!.content as ContentBlock[])
        .filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image")
        .map((b) => (b.source as { type: string; id: string }).id);
      expect(refIds).toHaveLength(2);
      expect(refIds[0]).toBe(upload.id);
      const offloadId = refIds[1]!;
      expect(offloadId).not.toBe(upload.id);
      expect(offloadId).toMatch(/^[A-Za-z0-9._-]+$/);
      const sessionDir = path.join(storeRoot, STORE_SESSION);
      const offloadBytes = await fs.readFile(path.join(sessionDir, offloadId));
      expect(offloadBytes.toString("base64")).toBe(PNG_B64);
      const uploadBytes = await fs.readFile(path.join(sessionDir, upload.id));
      expect(uploadBytes.toString("base64")).toBe(PNG_B64);
    },
  );
});
