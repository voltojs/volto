/**
 * End-to-end smoke for the image pipeline through createAgent:
 * model asks read_file → tool stores bytes in AttachmentStore as a ref
 * → state keeps the ref → Runner resolves it to base64 on the next
 * ModelRequest → snapshot never carries the PNG bytes.
 *
 * Temp workspace + temp attachment root — never writes to ~/.volto.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
  CAP_MODEL_VISION,
} from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";
import { createMemoryStore } from "@volto/store-memory";
import { createNodeFileSystem, createNodeAttachmentStore } from "@volto/runtime-node";

/** 1×1 red PNG. Exact base64 asserted on the request surface. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!;
    await cleanup().catch(() => {});
  }
});

/** Temp workspace holding FIXTURE.png + a sibling temp attachment root. */
async function makeWorkspace(): Promise<{
  root: string;
  attachmentRoot: string;
  fs: ReturnType<typeof createNodeFileSystem>;
  attachmentStore: ReturnType<typeof createNodeAttachmentStore>;
}> {
  const base = await mkdtemp(path.join(tmpdir(), "volto-img-e2e-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));

  const root = path.join(base, "ws");
  const attachmentRoot = path.join(base, "att");
  await mkdir(root, { recursive: true });
  await mkdir(attachmentRoot, { recursive: true });
  await writeFile(path.join(root, "FIXTURE.png"), Buffer.from(PNG_1X1, "base64"));

  return {
    root,
    attachmentRoot,
    fs: createNodeFileSystem({ root }),
    attachmentStore: createNodeAttachmentStore({ rootDir: attachmentRoot, sessionId: "sess-image-e2e" }),
  };
}

function capturingPort(
  script: Parameters<typeof createMockModelPort>[0],
  requests: ModelRequest[],
): ModelPort {
  const inner = createMockModelPort(script);
  return {
    async *stream(req) {
      requests.push(structuredClone(req));
      yield* inner.stream(req);
    },
  };
}

describe("image pipeline end to end", () => {
  it("delivers a read image to the model request as base64", async () => {
    const { fs, attachmentStore } = await makeWorkspace();
    const seen: ModelRequest[] = [];
    const modelPort = capturingPort(
      [
        toolCallScript("call-1", "read_file", JSON.stringify({ path: "FIXTURE.png" })),
        textScript("a single red pixel"),
      ],
      seen,
    );

    const agent = createAgent({
      modelPort,
      fs,
      attachmentStore,
      modelVision: true,
    });
    const state = await agent.run("describe FIXTURE.png");
    expect(state.status).toBe("done");

    // Two model calls: tool_use then the wrap-up text.
    expect(seen).toHaveLength(2);
    const last = seen.at(-1)!;
    const json = JSON.stringify(last.messages);
    expect(json).toContain(PNG_1X1); // request surface carries bytes
    expect(json).not.toContain('"type":"ref"');
  });

  it("keeps the durable state free of image bytes", async () => {
    const { fs, attachmentStore } = await makeWorkspace();
    const sessionStore = createMemoryStore();
    const modelPort = createMockModelPort([
      toolCallScript("call-1", "read_file", JSON.stringify({ path: "FIXTURE.png" })),
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort,
      fs,
      attachmentStore,
      modelVision: true,
      sessionStore,
    });
    const state = await agent.run("describe FIXTURE.png");
    expect(state.status).toBe("done");

    // The runner checkpoints under its own sessionId; take the turn-boundary
    // snapshot (canonical key, no #seq suffix) from the store listing.
    const snapshots = await sessionStore.list();
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const snapshot = snapshots.find((s) => !s.id.includes("#")) ?? snapshots[0]!;
    const persisted = JSON.stringify(snapshot.state);
    // The snapshot is rewritten on every checkpoint, so bytes must never
    // land in it — only the attachment reference.
    expect(persisted).not.toContain(PNG_1X1);
    expect(persisted).toMatch(/"type":"ref"/);

    // And the live state surface agrees: ref, never bytes.
    const live = JSON.stringify(state.messages);
    expect(live).not.toContain(PNG_1X1);
    expect(live).toMatch(/"type":"ref"/);
  });

  it("grants CAP_MODEL_VISION only when modelVision is true", async () => {
    const { fs, attachmentStore } = await makeWorkspace();

    const granted = new Set<string>();
    createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      fs,
      attachmentStore,
      capabilities: granted,
      modelVision: true,
    });
    expect(granted.has(CAP_MODEL_VISION)).toBe(true);

    const unknown = new Set<string>();
    createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      fs,
      attachmentStore,
      capabilities: unknown,
      // modelVision omitted — tri-state unknown must not grant
    });
    expect(unknown.has(CAP_MODEL_VISION)).toBe(false);

    const denied = new Set<string>();
    createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      fs,
      attachmentStore,
      capabilities: denied,
      modelVision: false,
    });
    expect(denied.has(CAP_MODEL_VISION)).toBe(false);
  });

  it("ships read_document callable without an explicit documentParser", async () => {
    const { root, fs, attachmentStore } = await makeWorkspace();
    // A .txt file goes through the default node parser's text path.
    // The parser opens paths with raw fs (cwd-relative), so the tool call
    // must carry an absolute path — same contract as a real host would use.
    const notePath = path.join(root, "note.txt");
    await writeFile(notePath, "hello from a note");

    const seen: ModelRequest[] = [];
    const modelPort = capturingPort(
      [
        toolCallScript("call-1", "read_document", JSON.stringify({ path: notePath })),
        textScript("parsed"),
      ],
      seen,
    );

    const agent = createAgent({ modelPort, fs, attachmentStore, modelVision: true });
    const state = await agent.run("read the note");
    expect(state.status).toBe("done");

    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const persisted = JSON.stringify(toolMsg);
    // Must be a real parse result, not "Unknown tool: read_document".
    expect(persisted).toContain("hello from a note");
    expect(persisted).not.toContain("Unknown tool");
  });
});
