/**
 * `GET /providers` must publish each model's image-input capability.
 *
 * Without it the web app cannot honour spec §7's gating rule: the composer's
 * `visionSupported` prop has no source, so a model the catalog declares
 * text-only still shows an attachment entry that can only fail.
 *
 * Three-state on the wire: `true` / `false` are published verbatim, UNKNOWN
 * is the absence of the key — never `false`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInputLimits, ModelInputValue } from "@volto/core";
import { startTestServer, type TestServer } from "./helpers.js";

interface WireModel {
  code: string;
  vision?: boolean;
  input?: ModelInputValue;
  inputLimits?: ModelInputLimits;
}

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

async function createProvider(body: unknown): Promise<void> {
  const res = await fetch(`${server.url}/providers`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
}

/** The model with this code, wherever it is configured. */
async function findModel(code: string): Promise<WireModel | undefined> {
  const res = await fetch(`${server.url}/providers`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  const providers = (await res.json()) as Array<{ models: WireModel[] }>;
  return providers.flatMap((p) => p.models).find((m) => m.code === code);
}

describe("GET /providers vision capability", () => {
  it("publishes a catalog model's declared image support", async () => {
    // Known catalog facts, same pair collection.test.ts pins: gpt-4o is
    // ["text","image"], deepseek-v4-pro is ["text"].
    await createProvider({
      name: "vision catalog",
      kind: "catalog",
      piProvider: "openai",
      apiKey: "sk-test",
      models: [{ code: "gpt-4o" }],
    });
    await createProvider({
      name: "text-only catalog",
      kind: "catalog",
      piProvider: "deepseek",
      apiKey: "sk-test",
      models: [{ code: "deepseek-v4-pro" }, { code: "deepseek-flash" }],
    });

    expect((await findModel("gpt-4o"))?.vision).toBe(true);
    expect((await findModel("deepseek-v4-pro"))?.vision).toBe(false);
    expect((await findModel("gpt-4o"))?.input).toEqual(["text", "image"]);
    expect((await findModel("deepseek-v4-pro"))?.input).toEqual(["text"]);
    expect(
      (await findModel("deepseek-flash"))?.inputLimits?.images?.resize?.maxWidth,
    ).toBe(2000);
  });

  it("omits the key for a hand-declared model whose support is unknown", async () => {
    await createProvider({
      name: "custom gateway",
      kind: "custom",
      baseURL: "https://gateway.example",
      apiKey: "sk-test",
      models: [{ name: "Mystery", code: "mystery" }],
    });

    const model = await findModel("mystery");
    expect(model).toBeDefined();
    expect(model).not.toHaveProperty("vision");
    expect(model).not.toHaveProperty("input");
    expect(model).not.toHaveProperty("inputLimits");
  });
});
