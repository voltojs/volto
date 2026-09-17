import { describe, it, expect } from "vitest";
import { startTestServer } from "./helpers.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const auth = (t: string) => ({
  authorization: `Bearer ${t}`,
  "content-type": "application/json",
});

describe("/attachments", () => {
  it("stores an image and reports its dimensions", async () => {
    const { url, token, sessionId, close } = await startTestServer();
    try {
      const res = await fetch(`${url}/attachments`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ sessionId, data: PNG, mimeType: "image/png" }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ mimeType: "image/png", size: 70, width: 1, height: 1 });
    } finally {
      await close();
    }
  });

  it("rejects a payload above the shared size cap", async () => {
    const { url, token, sessionId, close } = await startTestServer();
    try {
      const res = await fetch(`${url}/attachments`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ sessionId, data: "A".repeat(6 * 1024 * 1024), mimeType: "image/png" }),
      });
      expect(res.status).toBe(413);
    } finally {
      await close();
    }
  });

  it("rejects a non-image mime type", async () => {
    const { url, token, sessionId, close } = await startTestServer();
    try {
      const res = await fetch(`${url}/attachments`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ sessionId, data: PNG, mimeType: "application/x-sh" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("serves the bytes back with the right content type", async () => {
    const { url, token, sessionId, close } = await startTestServer();
    try {
      const created = (await (
        await fetch(`${url}/attachments`, {
          method: "POST",
          headers: auth(token),
          body: JSON.stringify({ sessionId, data: PNG, mimeType: "image/png" }),
        })
      ).json()) as { id: string };

      const res = await fetch(`${url}/attachments/${created.id}?sessionId=${sessionId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/png");
      expect(Buffer.from(await res.arrayBuffer()).toString("base64")).toBe(PNG);
    } finally {
      await close();
    }
  });

  it("refuses to serve one session's attachment to another session", async () => {
    const { url, token, sessionId, otherSessionId, close } = await startTestServer();
    try {
      const created = (await (
        await fetch(`${url}/attachments`, {
          method: "POST",
          headers: auth(token),
          body: JSON.stringify({ sessionId, data: PNG, mimeType: "image/png" }),
        })
      ).json()) as { id: string };

      const res = await fetch(`${url}/attachments/${created.id}?sessionId=${otherSessionId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // 404 rather than 403: confirming the id exists elsewhere is itself a leak.
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it("requires authentication on both verbs", async () => {
    const { url, close } = await startTestServer();
    try {
      expect((await fetch(`${url}/attachments`, { method: "POST" })).status).toBe(401);
      expect((await fetch(`${url}/attachments/anything`)).status).toBe(401);
    } finally {
      await close();
    }
  });

  it("rejects a percent-encoded path-traversal id instead of serving another session", async () => {
    const { url, token, sessionId, otherSessionId, close } = await startTestServer();
    try {
      // A real attachment exists under the other session; the attack id
      // decodes to ../other-session/<real-id> and must not reach its bytes.
      const created = (await (
        await fetch(`${url}/attachments`, {
          method: "POST",
          headers: auth(token),
          body: JSON.stringify({ sessionId: otherSessionId, data: PNG, mimeType: "image/png" }),
        })
      ).json()) as { id: string };

      const escapedId = encodeURIComponent(`../${otherSessionId}/${created.id}`);
      const res = await fetch(`${url}/attachments/${escapedId}?sessionId=${sessionId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
      expect(Buffer.from(await res.arrayBuffer()).toString("base64")).not.toBe(PNG);
    } finally {
      await close();
    }
  });

  it("rejects a bare .. id", async () => {
    const { url, token, sessionId, close } = await startTestServer();
    try {
      // Percent-encoded so the URL parser does not collapse the segment.
      const res = await fetch(`${url}/attachments/%2E%2E?sessionId=${sessionId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
      expect(Buffer.from(await res.arrayBuffer()).toString("base64")).not.toBe(PNG);
    } finally {
      await close();
    }
  });

  it("rejects a path-traversal sessionId instead of escaping the store root", async () => {
    const { url, token, close } = await startTestServer();
    try {
      for (const bad of ["../escape", "..%2Fescape"]) {
        const res = await fetch(`${url}/attachments/any-id?sessionId=${bad}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        // Invalid sessionId is client input, not a server fault.
        expect(res.status).toBe(400);
        expect(Buffer.from(await res.arrayBuffer()).toString("base64")).not.toBe(PNG);
      }
    } finally {
      await close();
    }
  });
});
