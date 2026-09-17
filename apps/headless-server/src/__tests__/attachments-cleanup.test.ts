import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { cleanupOrphanAttachments } from "../attachments/cleanup.js";
import { startTestServer } from "./helpers.js";

const roots: string[] = [];
async function tmpRoot() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "volto-cleanup-"));
  roots.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function seed(root: string, sessionId: string, ageMs: number) {
  const dir = path.join(root, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "a.bin");
  await fs.writeFile(file, "x");
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(file, when, when);
  await fs.utimes(dir, when, when);
}

const DAY = 24 * 60 * 60 * 1000;

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("cleanupOrphanAttachments", () => {
  it("removes an old directory whose session no longer exists", async () => {
    const root = await tmpRoot();
    await seed(root, "dead-session", 2 * DAY);
    const { removed } = await cleanupOrphanAttachments({
      rootDir: root, now: Date.now(), liveSessionIds: new Set(),
    });
    expect(removed).toEqual(["dead-session"]);
    await expect(fs.access(path.join(root, "dead-session"))).rejects.toThrow();
  });

  it("keeps a live session's attachments no matter how old", async () => {
    const root = await tmpRoot();
    await seed(root, "live-session", 30 * DAY);
    const { removed } = await cleanupOrphanAttachments({
      rootDir: root, now: Date.now(), liveSessionIds: new Set(["live-session"]),
    });
    expect(removed).toEqual([]);
  });

  it("keeps a recent orphan, since an upload may still be in flight", async () => {
    const root = await tmpRoot();
    await seed(root, "just-uploaded", 60 * 1000);
    const { removed } = await cleanupOrphanAttachments({
      rootDir: root, now: Date.now(), liveSessionIds: new Set(),
    });
    // A user who picked an image but has not sent the message yet owns an
    // orphan directory that must survive.
    expect(removed).toEqual([]);
  });

  it("never touches anything outside the attachment root", async () => {
    const root = await tmpRoot();
    const outside = await tmpRoot();
    await fs.writeFile(path.join(outside, "keep.txt"), "x");
    await cleanupOrphanAttachments({ rootDir: root, now: Date.now(), liveSessionIds: new Set() });
    await expect(fs.access(path.join(outside, "keep.txt"))).resolves.toBeUndefined();
  });
});

describe("DELETE /sessions/:id", () => {
  it("drops that session's attachments and leaves other sessions alone", async () => {
    const {
      url, token, sessionId, otherSessionId, attachmentRoot,
      turnConfig, openEvents, captureMessages, close,
    } = await startTestServer();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    // DELETE 404s on an unknown session, so both sessions need a real turn
    // before their attachment dirs can be cleaned up through the route.
    for (const sid of [sessionId, otherSessionId]) {
      await openEvents(sid);
      const res = await fetch(`${url}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId: sid, message: "hi", ...turnConfig }),
      });
      expect(res.status).toBe(202);
      await captureMessages();
    }

    for (const sid of [sessionId, otherSessionId]) {
      const res = await fetch(`${url}/attachments`, {
        method: "POST", headers,
        body: JSON.stringify({ sessionId: sid, data: PNG, mimeType: "image/png" }),
      });
      expect(res.status).toBe(201);
    }

    const res = await fetch(`${url}/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);

    await expect(fs.access(path.join(attachmentRoot, sessionId))).rejects.toThrow();
    // The neighbouring session must survive: a delete that reached it would
    // be the same failure mode Task 1 fixed, arriving through another door.
    await expect(fs.access(path.join(attachmentRoot, otherSessionId))).resolves.toBeUndefined();
    await close();
  });
});
