import * as http from "node:http";
import { describe, it, expect } from "vitest";
import { startTestServer } from "./helpers.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const auth = (t: string) => ({
  authorization: `Bearer ${t}`,
  "content-type": "application/json",
});

/**
 * GET with a request target sent verbatim — `fetch` cannot express one the
 * URL parser would rewrite, and the traversal check has to see what the
 * client actually sent.
 */
function rawGet(
  base: URL,
  target: string,
  token: string,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: base.hostname,
        port: base.port,
        path: target,
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

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

  it("F-171 accepts text/*, application/json and application/pdf; rejects zip", async () => {
    const { url, token, sessionId, close } = await startTestServer();
    try {
      const post = (mimeType: string, extra?: Record<string, unknown>) =>
        fetch(`${url}/attachments`, {
          method: "POST",
          headers: auth(token),
          body: JSON.stringify({ sessionId, data: "aGk=", mimeType, ...extra }),
        });

      // A non-empty name lands in the returned meta verbatim (spec D4).
      const named = await post("text/plain", { name: "a.txt" });
      expect(named.status).toBe(201);
      expect(await named.json()).toMatchObject({ mimeType: "text/plain", name: "a.txt" });

      // An omitted name stays absent — the field is optional end to end.
      const unnamed = await post("text/plain");
      expect(unnamed.status).toBe(201);
      expect("name" in ((await unnamed.json()) as object)).toBe(false);

      for (const mimeType of ["text/markdown", "application/json", "application/pdf"]) {
        const res = await post(mimeType);
        expect(res.status, `${mimeType} should upload`).toBe(201);
      }

      // Binaries have no conversion path; zip is the D1 rejection case.
      const zip = await post("application/zip");
      expect(zip.status).toBe(400);
      expect(await zip.json()).toMatchObject({ error: "Unsupported mimeType: application/zip" });
    } finally {
      await close();
    }
  });

  it("F-171 enforces per-kind size limits", async () => {
    const { url, token, sessionId, close } = await startTestServer();
    try {
      const post = (data: string, mimeType: string) =>
        fetch(`${url}/attachments`, {
          method: "POST",
          headers: auth(token),
          body: JSON.stringify({ sessionId, data, mimeType }),
        });

      // These bodies sit just under ATTACHMENT_BODY_LIMIT, so a 413 here is
      // the per-kind base64 cap rejecting — not the raw body reader.
      // Text/json cap at 2 MiB: one base64 char over -> 413.
      expect((await post("A".repeat(2 * 1024 * 1024 + 1), "text/plain")).status).toBe(413);
      // PDF shares the image cap of 5 MiB: one base64 char over -> 413.
      expect((await post("A".repeat(5 * 1024 * 1024 + 1), "application/pdf")).status).toBe(413);
      // Image regression: the existing 5 MiB cap keeps its current behavior.
      expect((await post("A".repeat(5 * 1024 * 1024 + 1), "image/png")).status).toBe(413);
      // Under the cap, text still uploads — the 413 is a size rule, not a ban.
      expect((await post("aGk=", "text/plain")).status).toBe(201);
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
      // Sent OVER THE WIRE literally, because `fetch`'s URL parser would
      // collapse the dot segment client-side: `/attachments/..` becomes `/`,
      // which tests the parser rather than the route. Percent-encoded is not
      // enough either — WHATWG URL decoding happens after dot-segment
      // removal but Node's server re-parses afterwards, and the two disagree.
      const res = await rawGet(new URL(url), `/attachments/%2E%2E?sessionId=${sessionId}`, token);
      expect(res.status).toBe(404);
      expect(Buffer.from(res.body).toString("base64")).not.toBe(PNG);
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
