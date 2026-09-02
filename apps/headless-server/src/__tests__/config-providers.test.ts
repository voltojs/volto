import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createProviderStore } from "../config/providers.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-prov-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const INPUT = {
  name: "MiMo",
  baseURL: "https://example.com/v1",
  apiKey: "sk-abcdefgh3f2a",
  models: [{ name: "MiMo-V2.5-Pro", code: "mimo-v2.5" }],
};

describe("createProviderStore", () => {
  it("creates a provider and returns it masked", async () => {
    const created = await createProviderStore(dir).create(INPUT);
    expect(created.apiKeyMasked).toBe("sk-…3f2a");
    expect(created.models[0]!.id).toBeTruthy();
    expect(JSON.stringify(created)).not.toContain("sk-abcdefgh3f2a");
  });

  it("never exposes the plaintext key through listPublic", async () => {
    const store = createProviderStore(dir);
    await store.create(INPUT);
    expect(JSON.stringify(await store.listPublic())).not.toContain("sk-abcdefgh3f2a");
  });

  it("stores the key encrypted on disk", async () => {
    await createProviderStore(dir).create(INPUT);
    const raw = await fs.readFile(path.join(dir, "providers.json"), "utf-8");
    expect(raw).not.toContain("sk-abcdefgh3f2a");
  });

  it("resolves a model to its plaintext credentials", async () => {
    const store = createProviderStore(dir);
    const created = await store.create(INPUT);
    const resolved = await store.resolveModel(created.id, created.models[0]!.id);
    expect(resolved).toEqual({
      baseURL: "https://example.com/v1",
      apiKey: "sk-abcdefgh3f2a",
      code: "mimo-v2.5",
    });
  });

  it("returns null when resolving an unknown provider or model", async () => {
    const store = createProviderStore(dir);
    const created = await store.create(INPUT);
    expect(await store.resolveModel("nope", created.models[0]!.id)).toBeNull();
    expect(await store.resolveModel(created.id, "nope")).toBeNull();
  });

  it("keeps the existing key when update omits apiKey", async () => {
    const store = createProviderStore(dir);
    const created = await store.create(INPUT);
    const updated = await store.update(created.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.apiKeyMasked).toBe("sk-…3f2a");

    const resolved = await store.resolveModel(created.id, created.models[0]!.id);
    expect(resolved?.apiKey).toBe("sk-abcdefgh3f2a");
  });

  it("replaces the key when update provides a new apiKey", async () => {
    const store = createProviderStore(dir);
    const created = await store.create(INPUT);
    await store.update(created.id, { apiKey: "sk-zzzzzzzz9999" });
    const resolved = await store.resolveModel(created.id, created.models[0]!.id);
    expect(resolved?.apiKey).toBe("sk-zzzzzzzz9999");
  });

  it("assigns ids to newly added models on update", async () => {
    const store = createProviderStore(dir);
    const created = await store.create(INPUT);
    const updated = await store.update(created.id, {
      models: [
        { id: created.models[0]!.id, name: "MiMo-V2.5-Pro", code: "mimo-v2.5" },
        { name: "MiMo-Lite", code: "mimo-lite" },
      ],
    });
    expect(updated?.models).toHaveLength(2);
    expect(updated?.models[1]!.id).toBeTruthy();
  });

  it("treats an empty model id as a new model", async () => {
    const store = createProviderStore(dir);
    const created = await store.create(INPUT);
    const updated = await store.update(created.id, {
      models: [{ id: "", name: "Fresh", code: "fresh" }],
    });
    expect(updated?.models[0]!.id).toBeTruthy();
  });

  it("removes a provider and reports whether it existed", async () => {
    const store = createProviderStore(dir);
    const created = await store.create(INPUT);
    expect(await store.remove(created.id)).toBe(true);
    expect(await store.remove(created.id)).toBe(false);
  });
});
