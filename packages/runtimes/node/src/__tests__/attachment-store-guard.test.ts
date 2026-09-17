import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createNodeAttachmentStore } from "../index.js";

const roots: string[] = [];
async function tmpRoot(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "volto-att-guard-"));
  roots.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("AttachmentStore session id guard", () => {
  it("refuses an empty session id instead of wiping the whole store", async () => {
    const rootDir = await tmpRoot();
    const a = createNodeAttachmentStore({ rootDir, sessionId: "session-a" });
    const stored = await a.put(PNG, "image/png");

    // path.join(root, "") === root, so an unguarded rm here would recursively
    // delete every session's attachments, not just one session's.
    await a.deleteBySession("");

    await expect(a.get(stored.id)).resolves.toBeDefined();
    await expect(fs.access(rootDir)).resolves.toBeUndefined();
  });

  it("refuses a whitespace-only or dot session id", async () => {
    const rootDir = await tmpRoot();
    const a = createNodeAttachmentStore({ rootDir, sessionId: "session-a" });
    const stored = await a.put(PNG, "image/png");

    for (const bad of ["   ", ".", "\t"]) {
      await a.deleteBySession(bad);
    }
    await expect(a.get(stored.id)).resolves.toBeDefined();
  });

  it("still deletes the real session", async () => {
    const rootDir = await tmpRoot();
    const a = createNodeAttachmentStore({ rootDir, sessionId: "session-a" });
    const stored = await a.put(PNG, "image/png");
    await a.deleteBySession("session-a");
    await expect(a.get(stored.id)).resolves.toBeUndefined();
  });

  it("rejects an invalid session id at construction time", () => {
    expect(() => createNodeAttachmentStore({ rootDir: "/tmp/x", sessionId: "" })).toThrow(/session/i);
    expect(() => createNodeAttachmentStore({ rootDir: "/tmp/x", sessionId: "../escape" })).toThrow(/session/i);
  });
});
