import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createStore } from "@volto/store-jsonl";
import type { ChatSessionRecord, JsonlSessionStore } from "@volto/store-jsonl";
import { createNodeAttachmentStore } from "@volto/runtime-node";
import type { AttachmentStore, PlanStore, TranscriptEventInput } from "@volto/core";
import { forkSession, ForkError } from "../session-fork.js";

let dir: string;
let store: JsonlSessionStore;
let attachmentRoot: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-store-"));
  attachmentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fork-att-"));
  store = createStore({ directory: dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(attachmentRoot, { recursive: true, force: true });
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function seed(): Promise<ChatSessionRecord> {
  const attachmentStore = createNodeAttachmentStore({ rootDir: attachmentRoot, sessionId: "src" });
  await attachmentStore.put(PNG, "image/png", { id: "img1", name: "shot.png" });
  const events: TranscriptEventInput[] = [
    { time: 1, type: "session_meta", data: { title: "Source", projectId: "p1", providerId: null, modelId: null, permissionMode: "ask" } },
    { time: 2, type: "user_message", data: { content: "first question" }, turn: 1 },
    { time: 3, type: "assistant_message", data: { content: [{ type: "text", text: "first answer" }], durationMs: 1 }, turn: 1 },
    { time: 4, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    { time: 5, type: "user_message", data: { content: [{ type: "text", text: "second" }, { type: "image", source: { type: "ref", id: "img1", mediaType: "image/png" }, width: 1, height: 1 }] }, turn: 2 },
    { time: 6, type: "assistant_message", data: { content: [{ type: "text", text: "second answer" }], durationMs: 1 }, turn: 2 },
    { time: 7, type: "turn_end", data: { turn: 2, reason: "done" }, turn: 2 },
  ];
  await store.appendEvents(null, "src", events);
  const record = await store.readSession("src");
  expect(record).toBeDefined();
  return record!;
}

function planStore(): PlanStore {
  const plans = new Map<string, string>();
  plans.set("src", "# Plan");
  return {
    async save(id, _p, content) { plans.set(id, content); },
    async read(id) { return plans.get(id) ?? null; },
    async deleteBySession(id) { plans.delete(id); },
  };
}

function deps(newId: string) {
  return {
    chatStore: store,
    attachmentStoreFor: (sessionId: string) => createNodeAttachmentStore({ rootDir: attachmentRoot, sessionId }),
    planStore: planStore(),
    projectPath: null,
    newId,
  };
}

describe("forkSession", () => {
  it("renders the branch marker in the requested locale", async () => {
    const source = await seed();
    const result = await forkSession(source, { locale: "en" }, deps("fork-en"));
    expect(result.title).toBe("Source (branch)");
  });

  it("copies the whole completed history, rewrites meta and copies attachments/plan", async () => {
    const source = await seed();
    const result = await forkSession(source, {}, deps("fork-1"));
    expect(result).toMatchObject({
      id: "fork-1",
      title: "Source（分支）",
      parentSessionId: "src",
      titleSuffix: "branch",
    });

    const forked = await store.readSession("fork-1");
    expect(forked).toBeDefined();
    expect(forked!.meta.title).toBe("Source（分支）");
    expect(forked!.meta.parentSessionId).toBe("src");
    expect(forked!.meta.origin).toBeUndefined();
    expect(forked!.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    const attachment = await createNodeAttachmentStore({ rootDir: attachmentRoot, sessionId: "fork-1" }).get("img1");
    expect(attachment?.name).toBe("shot.png");

    // Spec manual 8.2.2, automated: the branch message stream is verbatim
    // identical to the source prefix (only meta and seq differ).
    const sourceEvents = source.events;
    const branchMessages = forked!.events.filter((e) => e.type !== "session_meta");
    const sourceMessages = sourceEvents.filter((e) => e.type !== "session_meta");
    expect(branchMessages.map((e) => ({ type: e.type, data: e.data }))).toEqual(
      sourceMessages.map((e) => ({ type: e.type, data: e.data })),
    );
  });

  it("still forks when an attachment copy fails, degrading to a warning", async () => {
    const source = await seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const brokenDeps = {
      ...deps("fork-att-fail"),
      attachmentStoreFor: (sessionId: string) => {
        const store = createNodeAttachmentStore({ rootDir: attachmentRoot, sessionId });
        if (sessionId !== "fork-att-fail") return store;
        const failing: AttachmentStore = {
          get: (id) => store.get(id),
          put: async () => {
            throw new Error("disk full");
          },
          deleteBySession: (target) => store.deleteBySession(target),
        };
        return failing;
      },
    };

    // The branch is already durable; the request must not fail (a 500 here
    // would leave an orphaned-but-listed session that a retry duplicates).
    const result = await forkSession(source, {}, brokenDeps);
    expect(result.id).toBe("fork-att-fail");
    expect(await store.readSession("fork-att-fail")).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("copy failed"));
    warn.mockRestore();
  });

  it("refuses a target id that already exists instead of appending onto it", async () => {
    const source = await seed();
    await store.appendEvents(null, "occupied", [
      { time: 1, type: "session_meta", data: { title: "Occupied", projectId: null, providerId: null, modelId: null, permissionMode: null } },
    ]);

    // The store's write path resolves an existing id to its file and
    // APPENDS; forking into it would corrupt the target session.
    await expect(forkSession(source, {}, deps("occupied"))).rejects.toThrow(/already exists/);
    const untouched = await store.readSession("occupied");
    expect(untouched!.events).toHaveLength(1);
  });

  it("keeps branch attachments readable after the source session is deleted", async () => {
    const source = await seed();
    await forkSession(source, {}, deps("fork-survivor"));

    await store.deleteSession("src");
    expect(await store.readSession("src")).toBeUndefined();

    // Attachment bytes are copied into the branch's own directory, so the
    // branch stays readable once the source is gone (spec F-041).
    const branchAttachment = await createNodeAttachmentStore({
      rootDir: attachmentRoot,
      sessionId: "fork-survivor",
    }).get("img1");
    expect(branchAttachment?.data).toBe(PNG);
    expect(await store.readSession("fork-survivor")).toBeDefined();
  });

  it("keeps the branch title when a rename meta sits inside the prefix", async () => {
    const source = await seed();
    // PATCH rename appends a full meta event and the store merges metas
    // last-wins: a fork that only rewrote the first meta would surface the
    // renamed title without the branch marker.
    await store.appendEvents(null, "src", [
      { time: 8, type: "session_meta", data: { ...source.meta, title: "Renamed" } },
      { time: 9, type: "user_message", data: { content: "third" }, turn: 3 },
      { time: 10, type: "assistant_message", data: { content: [{ type: "text", text: "third answer" }], durationMs: 1 }, turn: 3 },
      { time: 11, type: "turn_end", data: { turn: 3, reason: "done" }, turn: 3 },
    ]);
    const renamed = (await store.readSession("src"))!;

    const result = await forkSession(renamed, {}, deps("fork-renamed"));
    expect(result.title).toBe("Renamed（分支）");

    const forked = await store.readSession("fork-renamed");
    expect(forked!.meta.title).toBe("Renamed（分支）");
    expect(forked!.meta.parentSessionId).toBe("src");
  });

  it("strips origin from every meta so a renamed subagent source stays visible", async () => {
    const source = await seed();
    await store.appendEvents(null, "src", [
      { time: 8, type: "session_meta", data: { ...source.meta, origin: "subagent" } },
      { time: 9, type: "user_message", data: { content: "sub" }, turn: 3 },
      { time: 10, type: "assistant_message", data: { content: [{ type: "text", text: "sub answer" }], durationMs: 1 }, turn: 3 },
      { time: 11, type: "turn_end", data: { turn: 3, reason: "done" }, turn: 3 },
    ]);
    const subagent = (await store.readSession("src"))!;

    await forkSession(subagent, {}, deps("fork-sub"));
    const forked = await store.readSession("fork-sub");
    expect(forked!.meta.origin).toBeUndefined();
    expect(forked!.meta.title).toBe("Source（分支）");
  });

  it("backs up to the last completed turn when throughTurn names a killed turn", async () => {
    await seed();
    // Turn 3 was killed mid-flight: user message exists, no turn_end.
    await store.appendEvents(null, "src", [
      { time: 8, type: "user_message", data: { content: "never finished" }, turn: 3 },
    ]);
    const killed = (await store.readSession("src"))!;

    // Spec D3: an incomplete turn falls back to the previous completed one
    // instead of failing with 400.
    const result = await forkSession(killed, { throughTurn: 3 }, deps("fork-fallback"));
    expect(result.id).toBe("fork-fallback");

    const forked = await store.readSession("fork-fallback");
    expect(forked!.events.filter((e) => e.type === "turn_end")).toHaveLength(2);
    expect(
      forked!.events.some(
        (e) =>
          e.type === "user_message" &&
          (e.data as { content?: unknown }).content === "never finished",
      ),
    ).toBe(false);

    // A cut naming a far-away turn also backs up to the latest completed one.
    const far = await forkSession(killed, { throughTurn: 99 }, deps("fork-far"));
    expect(far.id).toBe("fork-far");
    const farForked = await store.readSession("fork-far");
    expect(farForked!.events.filter((e) => e.type === "turn_end")).toHaveLength(2);
  });

  it("copies only through a completed turn and backs up a mid-turn seq", async () => {
    const source = await seed();
    await forkSession(source, { throughTurn: 1 }, deps("fork-turn1"));
    const turn1 = await store.readSession("fork-turn1");
    expect(turn1!.events.filter((e) => e.type === "turn_end")).toHaveLength(1);

    await forkSession(source, { throughSeq: 4 }, deps("fork-seq4"));
    const seq4 = await store.readSession("fork-seq4");
    expect(seq4!.events.map((e) => e.type)).toEqual([
      "session_meta", "user_message", "assistant_message", "turn_end",
    ]);
  });

  it("rejects a session with no completed turn and mutually exclusive cuts", async () => {
    await store.appendEvents(null, "empty", [
      { time: 1, type: "session_meta", data: { title: "Empty", projectId: null, providerId: null, modelId: null, permissionMode: null } },
      { time: 2, type: "user_message", data: { content: "pending" }, turn: 1 },
    ]);
    const source = (await store.readSession("empty"))!;
    await expect(forkSession(source, {}, deps("fork-empty"))).rejects.toBeInstanceOf(ForkError);
    await expect(
      forkSession(source, { throughSeq: 1, throughTurn: 1 }, deps("fork-both")),
    ).rejects.toBeInstanceOf(ForkError);
  });
});
