import { describe, it, expect } from "vitest";
import { startTestServer } from "./helpers.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const auth = (t: string) => ({
  authorization: `Bearer ${t}`,
  "content-type": "application/json",
});

/** Upload raw bytes as an attachment, returning the stored id. */
async function upload(
  url: string,
  token: string,
  sessionId: string,
  body: { data: string; mimeType: string; name?: string },
): Promise<string> {
  const res = await fetch(`${url}/attachments`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ sessionId, ...body }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** One content entry of the captured user message. */
interface UserContentEntry {
  type: string;
  text?: string;
  source?: { type: string; id: string; mediaType: string };
}

describe("POST /messages with attachments", () => {
  it("turns attachment ids into image blocks on the user message", async () => {
    const { url, token, sessionId, turnConfig, openEvents, captureMessages, close } =
      await startTestServer();
    try {
      await openEvents(sessionId);

      const { id } = (await (
        await fetch(`${url}/attachments`, {
          method: "POST",
          headers: auth(token),
          body: JSON.stringify({ sessionId, data: PNG, mimeType: "image/png" }),
        })
      ).json()) as { id: string };

      const res = await fetch(`${url}/messages`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          sessionId,
          message: "what is this",
          attachments: [id],
          ...turnConfig,
        }),
      });
      expect(res.status).toBe(202);

      const user = (await captureMessages()).find((m) => m.role === "user");
      expect(user).toBeDefined();
      expect(Array.isArray(user!.content)).toBe(true);
      expect(user!.content).toContainEqual(
        expect.objectContaining({
          type: "image",
          source: expect.objectContaining({ type: "ref", id }),
        }),
      );
      // The text block rides alongside the image, never replaced by it.
      expect(user!.content).toContainEqual({ type: "text", text: "what is this" });
    } finally {
      await close();
    }
  });

  it("rejects an unknown attachment id without starting a turn", async () => {
    const { url, token, sessionId, turnConfig, openEvents, captureMessages, turnCount, close } =
      await startTestServer();
    try {
      await openEvents(sessionId);

      // One successful turn first so the counter is non-zero — a counter that
      // never moves would make the "unchanged" assertion vacuous.
      await fetch(`${url}/messages`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ sessionId, message: "hi", ...turnConfig }),
      });
      await captureMessages();
      const before = turnCount();
      expect(before).toBeGreaterThan(0);

      const res = await fetch(`${url}/messages`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          sessionId,
          message: "hi",
          attachments: ["no-such-id"],
          ...turnConfig,
        }),
      });

      expect(res.status).toBe(400);
      expect(turnCount()).toBe(before);
    } finally {
      await close();
    }
  });

  it("still requires a message even when attachments are present", async () => {
    const { url, token, sessionId, turnConfig, openEvents, close } = await startTestServer();
    try {
      await openEvents(sessionId);
      const res = await fetch(`${url}/messages`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ sessionId, attachments: ["whatever"], ...turnConfig }),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("leaves a plain text message unchanged", async () => {
    const { url, token, sessionId, turnConfig, openEvents, captureMessages, close } =
      await startTestServer();
    try {
      await openEvents(sessionId);
      await fetch(`${url}/messages`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ sessionId, message: "just text", ...turnConfig }),
      });
      const user = (await captureMessages()).find((m) => m.role === "user");
      expect(user).toBeDefined();
      expect(user!.content).toBe("just text");
    } finally {
      await close();
    }
  });

  it("F-174 a text attachment answers 202 with inline blocks in user_message.content", async () => {
    const { url, token, sessionId, turnConfig, openEvents, captureMessages, close } =
      await startTestServer();
    try {
      await openEvents(sessionId);
      const id = await upload(url, token, sessionId, {
        data: Buffer.from("hello inline\n", "utf8").toString("base64"),
        mimeType: "text/plain",
        name: "notes.txt",
      });

      const res = await fetch(`${url}/messages`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          sessionId,
          message: "read my notes",
          attachments: [id],
          ...turnConfig,
        }),
      });
      expect(res.status).toBe(202);

      const user = (await captureMessages()).find((m) => m.role === "user");
      expect(user).toBeDefined();
      expect(user!.content).toEqual([
        { type: "text", text: "read my notes" },
        { type: "text", text: "[attachment: notes.txt (text/plain)]\nhello inline\n" },
      ]);
    } finally {
      await close();
    }
  });

  it("F-174 keeps mixed image and text attachments in the caller's order", async () => {
    const { url, token, sessionId, turnConfig, openEvents, captureMessages, close } =
      await startTestServer();
    try {
      await openEvents(sessionId);
      const imageId = await upload(url, token, sessionId, { data: PNG, mimeType: "image/png" });
      const textId = await upload(url, token, sessionId, {
        data: Buffer.from("second\n", "utf8").toString("base64"),
        mimeType: "text/plain",
        name: "second.txt",
      });

      const res = await fetch(`${url}/messages`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          sessionId,
          message: "look at both",
          attachments: [imageId, textId],
          ...turnConfig,
        }),
      });
      expect(res.status).toBe(202);

      const user = (await captureMessages()).find((m) => m.role === "user");
      expect(user).toBeDefined();
      const content = user!.content as UserContentEntry[];
      expect(content).toHaveLength(3);
      expect(content[0]).toEqual({ type: "text", text: "look at both" });
      // The image keeps the ref-block shape — inline conversion never touches it.
      expect(content[1]).toMatchObject({
        type: "image",
        source: { type: "ref", id: imageId, mediaType: "image/png" },
      });
      expect(content[2]).toEqual({
        type: "text",
        text: "[attachment: second.txt (text/plain)]\nsecond\n",
      });
    } finally {
      await close();
    }
  });

  it("F-174 a text-only model is NOT rejected by the image gate for text attachments", async () => {
    const { url, token, sessionId, turnConfig, openEvents, close } = await startTestServer();
    try {
      // deepseek-v4-pro declares ["text"] input in pi-ai's catalog — the same
      // known pair messages-vision-gate.test.ts pins.
      const providerRes = await fetch(`${url}/providers`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          name: "text-only provider",
          kind: "catalog",
          piProvider: "deepseek",
          apiKey: "sk-test",
          models: [{ code: "deepseek-v4-pro" }],
        }),
      });
      expect(providerRes.status).toBe(201);
      const provider = (await providerRes.json()) as { id: string };
      const binding = { providerId: provider.id, modelId: "deepseek-v4-pro" };

      await openEvents(sessionId);
      const textId = await upload(url, token, sessionId, {
        data: Buffer.from("just words\n", "utf8").toString("base64"),
        mimeType: "text/plain",
        name: "words.txt",
      });
      const textRes = await fetch(`${url}/messages`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          sessionId,
          message: "summarize this",
          attachments: [textId],
          projectId: turnConfig.projectId,
          ...binding,
        }),
      });
      // assertImageInput only sees image blocks: a text attachment passes.
      expect(textRes.status).toBe(202);

      // Regression pin: the SAME text-only model still refuses an image.
      const imageId = await upload(url, token, sessionId, { data: PNG, mimeType: "image/png" });
      const imageRes = await fetch(`${url}/messages`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          sessionId,
          message: "what is this",
          attachments: [imageId],
          projectId: turnConfig.projectId,
          ...binding,
        }),
      });
      expect(imageRes.status).toBe(400);
      expect(((await imageRes.json()) as { error: string }).error).toMatch(/image/i);
    } finally {
      await close();
    }
  });
});
