/**
 * Server-side backstop for spec §7's `vision: false` gate.
 *
 * The composer hides its attachment entry for a text-only model, but UI
 * gating is not a boundary: a client that posts attachments anyway must be
 * refused here rather than having the images travel to a provider that
 * cannot read them.
 *
 * Only an explicit `false` gates. UNKNOWN still goes through — see §7 on why
 * a silently vanished image path costs more than a provider 400.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers.js";

/** 1×1 PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function authJson(): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  };
}

/** Configure a catalog provider and return ids usable as a turn binding. */
async function bindCatalogModel(
  piProvider: string,
  code: string,
): Promise<{ providerId: string; modelId: string }> {
  const res = await fetch(`${server.url}/providers`, {
    method: "POST",
    headers: authJson(),
    body: JSON.stringify({
      name: `${piProvider} provider`,
      kind: "catalog",
      piProvider,
      apiKey: "sk-test",
      models: [{ code }],
    }),
  });
  expect(res.status).toBe(201);
  const provider = (await res.json()) as { id: string };
  // A catalog model is identified by its code; there is no server-assigned id.
  return { providerId: provider.id, modelId: code };
}

async function uploadImage(): Promise<string> {
  const res = await fetch(`${server.url}/attachments`, {
    method: "POST",
    headers: authJson(),
    body: JSON.stringify({
      sessionId: server.sessionId,
      data: PNG_B64,
      mimeType: "image/png",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function postWithAttachment(
  binding: { providerId: string; modelId: string },
  attachmentId: string,
): Promise<{ status: number; body: { error?: string } }> {
  const res = await fetch(`${server.url}/messages`, {
    method: "POST",
    headers: authJson(),
    body: JSON.stringify({
      sessionId: server.sessionId,
      message: "what is this",
      attachments: [attachmentId],
      projectId: server.turnConfig.projectId,
      ...binding,
    }),
  });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

describe("POST /messages vision gate", () => {
  it("refuses attachments for a model that declares no image input", async () => {
    // deepseek-v4-pro is ["text"] in pi-ai's catalog — a known fact, not a
    // guess (collection.test.ts pins the same pair).
    const binding = await bindCatalogModel("deepseek", "deepseek-v4-pro");
    const attachmentId = await uploadImage();
    await server.openEvents(server.sessionId);

    const { status, body } = await postWithAttachment(binding, attachmentId);

    expect(status).toBe(400);
    expect(body.error).toMatch(/image/i);
    // Refused before the turn began, not mid-stream.
    expect(server.turnCount()).toBe(0);
  });

  it("accepts attachments for a model that declares image input", async () => {
    const binding = await bindCatalogModel("openai", "gpt-4o");
    const attachmentId = await uploadImage();
    await server.openEvents(server.sessionId);

    const { status } = await postWithAttachment(binding, attachmentId);

    expect(status).toBe(202);
  });

  it("accepts attachments when image support is unknown", async () => {
    // The helper's own hand-declared provider never declares vision.
    const attachmentId = await uploadImage();
    await server.openEvents(server.sessionId);

    const { status } = await postWithAttachment(
      { providerId: server.turnConfig.providerId, modelId: server.turnConfig.modelId },
      attachmentId,
    );

    expect(status).toBe(202);
  });
});
