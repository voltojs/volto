import { describe, it, expect } from "vitest";
import { startTestServer } from "./helpers.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const auth = (t: string) => ({
  authorization: `Bearer ${t}`,
  "content-type": "application/json",
});

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
});
