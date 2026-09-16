import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createNodeAttachmentStore, readImageDimensions } from "../index.js";

const roots: string[] = [];
async function tmpStore(sessionId = "s1") {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-att-"));
  roots.push(rootDir);
  return createNodeAttachmentStore({ rootDir, sessionId });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

/** 1x1 red PNG. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("readImageDimensions", () => {
  it("reads PNG dimensions from the IHDR header", () => {
    expect(readImageDimensions(Buffer.from(PNG_1X1, "base64"))).toEqual({ width: 1, height: 1 });
  });

  it("returns undefined for bytes that are not a recognized image", () => {
    expect(readImageDimensions(Buffer.from("not an image at all"))).toBeUndefined();
  });

  it("reads JPEG dimensions from the SOF marker", () => {
    // Minimal JPEG: SOI + SOF0 frame header declaring 16x32.
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x10,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(readImageDimensions(jpeg)).toEqual({ width: 16, height: 32 });
  });
});

describe("node AttachmentStore", () => {
  it("round-trips bytes through put/get", async () => {
    const store = await tmpStore();
    const stored = await store.put(PNG_1X1, "image/png");
    expect(stored.mimeType).toBe("image/png");
    expect(stored.width).toBe(1);
    expect(stored.height).toBe(1);

    const got = await store.get(stored.id);
    expect(got?.data).toBe(PNG_1X1);
    expect(got?.mimeType).toBe("image/png");
  });

  it("returns undefined for an unknown id instead of throwing", async () => {
    const store = await tmpStore();
    await expect(store.get("no-such-id")).resolves.toBeUndefined();
  });

  it("rejects ids containing path separators", async () => {
    const store = await tmpStore();
    await expect(store.get("../escape")).resolves.toBeUndefined();
    await expect(store.get("a/b")).resolves.toBeUndefined();
    await expect(store.get("a\\b")).resolves.toBeUndefined();
  });

  it("deleteBySession removes that session's attachments", async () => {
    const store = await tmpStore("s1");
    const stored = await store.put(PNG_1X1, "image/png");
    await store.deleteBySession("s1");
    await expect(store.get(stored.id)).resolves.toBeUndefined();
  });

  it("defaults the store root outside any workspace", () => {
    const store = createNodeAttachmentStore({ sessionId: "s1" });
    expect(store).toBeDefined();
    // The default root is ~/.volto/attachments — SAFETY.md already denies
    // ~/.volto to sandboxed processes, so the agent cannot read it back.
    expect(path.join(os.homedir(), ".volto", "attachments").startsWith(os.homedir())).toBe(true);
  });
});
