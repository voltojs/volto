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

  it("F-172 round-trips an optional name through the sidecar", async () => {
    const store = await tmpStore();
    const meta = await store.put("aGk=", "text/plain", { name: "notes.txt" });
    expect(meta.name).toBe("notes.txt");
    const back = await store.get(meta.id);
    expect(back?.name).toBe("notes.txt");
  });

  it("F-172 an omitted name stays absent (backward compatible)", async () => {
    const store = await tmpStore();
    const meta = await store.put("aGk=", "text/plain");
    expect("name" in meta).toBe(false);
  });

  it("F-212 honors an explicit put id: bytes land under the session dir with that id, overwrite included", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-att-"));
    roots.push(rootDir);
    const store = createNodeAttachmentStore({ rootDir, sessionId: "s1" });

    const meta = await store.put(PNG_1X1, "image/png", { id: "msg-1-t0", name: "shot.png" });
    expect(meta.id).toBe("msg-1-t0");
    expect(meta.name).toBe("shot.png");
    // The file literally lands under <root>/<session>/<id>.
    await expect(fs.readFile(path.join(rootDir, "s1", "msg-1-t0"))).resolves.toEqual(
      Buffer.from(PNG_1X1, "base64"),
    );

    // Same id again = deterministic overwrite (idempotent re-offload).
    await store.put("aGk=", "text/plain", { id: "msg-1-t0" });
    const got = await store.get("msg-1-t0");
    expect(got?.data).toBe("aGk=");
    expect(got?.mimeType).toBe("text/plain");
  });

  it("F-212 rejects an explicit put id that is not a valid path segment — asserting the rejection itself", async () => {
    const store = await tmpStore();
    await expect(store.put(PNG_1X1, "image/png", { id: "../escape" })).rejects.toThrow(/path segment/i);
    await expect(store.put(PNG_1X1, "image/png", { id: "a/b" })).rejects.toThrow(/path segment/i);
    await expect(store.put(PNG_1X1, "image/png", { id: "a\\b" })).rejects.toThrow(/path segment/i);
    await expect(store.put(PNG_1X1, "image/png", { id: "" })).rejects.toThrow(/path segment/i);
    await expect(store.put(PNG_1X1, "image/png", { id: ".." })).rejects.toThrow(/path segment/i);
  });

  it("F-212 keeps the crypto.randomUUID fallback when no explicit id is given", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-att-"));
    roots.push(rootDir);
    const store = createNodeAttachmentStore({ rootDir, sessionId: "s1" });

    const meta = await store.put(PNG_1X1, "image/png");
    expect(meta.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const files = await fs.readdir(path.join(rootDir, "s1"));
    expect(files).toContain(meta.id);
    expect(files).toContain(meta.id + ".json");
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

  it("deleteBySession refuses path traversal and leaves outside files intact", async () => {
    const store = await tmpStore("s1");
    const stored = await store.put(PNG_1X1, "image/png");
    // Victim sits next to the store root. A traversal sessionId such as
    // "../<victim>" or ".." would resolve here (or to tmpdir itself) if
    // separators were accepted.
    const victimDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-victim-"));
    roots.push(victimDir);
    const sentinel = path.join(victimDir, "keep-me");
    await fs.writeFile(sentinel, "alive", "utf8");

    await store.deleteBySession(`../${path.basename(victimDir)}`);
    await store.deleteBySession("nested/session");
    await store.deleteBySession("a\\b");
    await store.deleteBySession("..");

    // Assert the denial itself: the outside sentinel still exists with its
    // original content — not merely that some recursive rm produced nothing.
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("alive");
    // And the legitimate session directory was not collateral damage.
    await expect(store.get(stored.id)).resolves.toBeDefined();
  });

  it("defaults the store root outside any workspace", () => {
    const store = createNodeAttachmentStore({ sessionId: "s1" });
    expect(store).toBeDefined();
    // The default root is ~/.volto/attachments — SAFETY.md already denies
    // ~/.volto to sandboxed processes, so the agent cannot read it back.
    expect(path.join(os.homedir(), ".volto", "attachments").startsWith(os.homedir())).toBe(true);
  });
});
