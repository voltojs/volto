import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createProviderStore, type PublicProvider } from "../config/providers.js";

/**
 * Narrows a `PublicProvider` to its "custom" variant. Every pre-existing
 * test below creates providers implicitly as "custom" (no `kind` passed) —
 * this cast just gives TS what it needs to see `.models` on the result.
 */
function asCustom(p: PublicProvider): Extract<PublicProvider, { kind: "custom" }> {
  if (p.kind !== "custom") throw new Error(`expected a custom provider, got kind=${p.kind}`);
  return p;
}

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
    const created = asCustom(await createProviderStore(dir).create(INPUT));
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
    const created = asCustom(await store.create(INPUT));
    const resolved = await store.resolveModel(created.id, created.models[0]!.id);
    expect(resolved).toEqual({
      kind: "custom",
      baseURL: "https://example.com/v1",
      apiKey: "sk-abcdefgh3f2a",
      code: "mimo-v2.5",
    });
  });

  it("returns null when resolving an unknown provider or model", async () => {
    const store = createProviderStore(dir);
    const created = asCustom(await store.create(INPUT));
    expect(await store.resolveModel("nope", created.models[0]!.id)).toBeNull();
    expect(await store.resolveModel(created.id, "nope")).toBeNull();
  });

  it("keeps the existing key when update omits apiKey", async () => {
    const store = createProviderStore(dir);
    const created = asCustom(await store.create(INPUT));
    const updated = asCustom((await store.update(created.id, { name: "Renamed" }))!);
    expect(updated?.name).toBe("Renamed");
    expect(updated?.apiKeyMasked).toBe("sk-…3f2a");

    const resolved = await store.resolveModel(created.id, created.models[0]!.id);
    expect(resolved?.apiKey).toBe("sk-abcdefgh3f2a");
  });

  it("replaces the key when update provides a new apiKey", async () => {
    const store = createProviderStore(dir);
    const created = asCustom(await store.create(INPUT));
    await store.update(created.id, { apiKey: "sk-zzzzzzzz9999" });
    const resolved = await store.resolveModel(created.id, created.models[0]!.id);
    expect(resolved?.apiKey).toBe("sk-zzzzzzzz9999");
  });

  it("assigns ids to newly added models on update", async () => {
    const store = createProviderStore(dir);
    const created = asCustom(await store.create(INPUT));
    const updated = asCustom(
      (await store.update(created.id, {
        models: [
          { id: created.models[0]!.id, name: "MiMo-V2.5-Pro", code: "mimo-v2.5" },
          { name: "MiMo-Lite", code: "mimo-lite" },
        ],
      }))!,
    );
    expect(updated?.models).toHaveLength(2);
    expect(updated?.models[1]!.id).toBeTruthy();
  });

  it("treats an empty model id as a new model", async () => {
    const store = createProviderStore(dir);
    const created = asCustom(await store.create(INPUT));
    const updated = asCustom(
      (await store.update(created.id, {
        models: [{ id: "", name: "Fresh", code: "fresh" }],
      }))!,
    );
    expect(updated?.models[0]!.id).toBeTruthy();
  });

  it("removes a provider and reports whether it existed", async () => {
    const store = createProviderStore(dir);
    const created = await store.create(INPUT);
    expect(await store.remove(created.id)).toBe(true);
    expect(await store.remove(created.id)).toBe(false);
  });

  // -- F5: a corrupt file must surface an error, not be treated as empty --

  it("throws instead of treating a corrupt file as empty", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "providers.json"), "{not valid json", "utf-8");
    await expect(createProviderStore(dir).listPublic()).rejects.toThrow();
  });

  it("does not silently discard existing providers (and their apiKeys) when the file is corrupt", async () => {
    const store = createProviderStore(dir);
    await store.create(INPUT);

    // Simulate corruption (e.g. a crash mid-write under the old
    // non-atomic writeAll) rather than the code under test producing it.
    const file = path.join(dir, "providers.json");
    await fs.writeFile(file, "{not valid json", "utf-8");

    // Before the fix, create() would read the corrupt file as `[]` and
    // persist only the new provider, discarding the encrypted apiKey above.
    await expect(store.create({ name: "second", models: [] })).rejects.toThrow();
    expect(await fs.readFile(file, "utf-8")).toBe("{not valid json");
  });

  it("writes atomically: no leftover temp file after a successful write", async () => {
    await createProviderStore(dir).create(INPUT);
    const entries = (await fs.readdir(dir)).filter((name) => name !== "key");
    expect(entries).toEqual(["providers.json"]);
  });
});

describe("model contextWindow", () => {
  it("persists a valid contextWindow and returns it publicly", async () => {
    const store = createProviderStore(dir);
    await store.create({
      name: "p1",
      models: [{ name: "M", code: "m-1", contextWindow: 128000 }],
    });
    const [provider] = await store.listPublic();
    expect(asCustom(provider!).models[0]).toMatchObject({ code: "m-1", contextWindow: 128000 });
    const raw = JSON.parse(await fs.readFile(path.join(dir, "providers.json"), "utf-8"));
    expect(raw[0].models[0].contextWindow).toBe(128000);
  });

  it("rejects zero, negative and non-integer contextWindow with a 400-worthy error", async () => {
    const store = createProviderStore(dir);
    await expect(
      store.create({ name: "p1", models: [{ name: "M", code: "m-1", contextWindow: 0 }] }),
    ).rejects.toThrow(/contextWindow/);
    await expect(
      store.create({ name: "p1", models: [{ name: "M", code: "m-1", contextWindow: -5 }] }),
    ).rejects.toThrow(/contextWindow/);
    await expect(
      store.create({ name: "p1", models: [{ name: "M", code: "m-1", contextWindow: 12.5 }] }),
    ).rejects.toThrow(/contextWindow/);
  });

  it("drops contextWindow on update when omitted and keeps it when unchanged", async () => {
    const store = createProviderStore(dir);
    const created = asCustom(
      await store.create({
        name: "p1",
        models: [{ name: "M", code: "m-1", contextWindow: 128000 }],
      }),
    );
    // models 未随 update 提交 → 维持原样
    await store.update(created.id, { name: "p1-renamed" });
    expect(asCustom((await store.listPublic())[0]!).models[0]!.contextWindow).toBe(128000);
    // models 提交但不含 contextWindow → 新 models 生效且字段移除
    await store.update(created.id, { models: [{ id: created.models[0]!.id, name: "M", code: "m-1" }] });
    expect(asCustom((await store.listPublic())[0]!).models[0]!.contextWindow).toBeUndefined();
  });
});

describe("catalog/custom discriminator", () => {
  it("round-trips a custom provider with kind: custom", async () => {
    const store = createProviderStore(dir);
    const created = await store.create({ ...INPUT, kind: "custom" });
    expect(created.kind).toBe("custom");
    const [listed] = await store.listPublic();
    expect(listed!.kind).toBe("custom");
    expect(asCustom(listed!).models[0]).toMatchObject({ code: "mimo-v2.5" });
  });

  it("round-trips a catalog provider with piProvider and its model records", async () => {
    const store = createProviderStore(dir);
    const created = await store.create({
      name: "OpenAI",
      kind: "catalog",
      piProvider: "openai",
      apiKey: "sk-abcdefgh3f2a",
      models: [{ code: "gpt-5" }, { code: "gpt-5-mini" }],
    });
    if (created.kind !== "catalog") throw new Error("expected a catalog provider");
    expect(created.piProvider).toBe("openai");
    expect(created.models).toEqual([{ code: "gpt-5" }, { code: "gpt-5-mini" }]);
    expect(JSON.stringify(created)).not.toContain("sk-abcdefgh3f2a");

    const [listed] = await store.listPublic();
    expect(listed).toMatchObject({
      kind: "catalog",
      piProvider: "openai",
      models: [{ code: "gpt-5" }, { code: "gpt-5-mini" }],
    });
  });

  it("keeps a catalog model's overrides and resolves its maxOutputTokens", async () => {
    const store = createProviderStore(dir);
    const created = await store.create({
      name: "OpenAI",
      kind: "catalog",
      piProvider: "openai",
      models: [
        { code: "gpt-5", name: "我的 GPT-5", contextWindow: 200000, maxOutputTokens: 8192 },
        // An override-free model stays override-free: omitted fields must not
        // become explicit `undefined`, or they would shadow pi-ai's catalog.
        { code: "gpt-5-mini" },
      ],
    });
    if (created.kind !== "catalog") throw new Error("expected a catalog provider");
    expect(created.models[0]).toEqual({
      code: "gpt-5",
      name: "我的 GPT-5",
      contextWindow: 200000,
      maxOutputTokens: 8192,
    });
    expect(Object.keys(created.models[1]!)).toEqual(["code"]);

    const resolved = await store.resolveModel(created.id, "gpt-5");
    expect(resolved).toMatchObject({ kind: "catalog", code: "gpt-5", maxOutputTokens: 8192 });
    const bare = await store.resolveModel(created.id, "gpt-5-mini");
    expect(bare).toBeDefined();
    expect("maxOutputTokens" in bare!).toBe(false);
  });

  it("rejects a second record for a pi-ai provider that is already configured", async () => {
    const store = createProviderStore(dir);
    await store.create({
      name: "OpenAI",
      kind: "catalog",
      piProvider: "openai",
      models: [{ code: "gpt-5" }],
    });

    await expect(
      store.create({
        name: "OpenAI (second key)",
        kind: "catalog",
        piProvider: "openai",
        models: [{ code: "gpt-5-mini" }],
      }),
    ).rejects.toThrow(/already configured as "OpenAI"/);

    // A different pi-ai provider is unaffected, and so is updating the
    // existing record in place (its own piProvider must not clash with itself).
    await store.create({
      name: "DeepSeek",
      kind: "catalog",
      piProvider: "deepseek",
      models: [{ code: "deepseek-v4-flash" }],
    });
    const [first] = await store.listPublic();
    await expect(
      store.update(first!.id, { kind: "catalog", piProvider: "openai", name: "Renamed" }),
    ).resolves.toMatchObject({ name: "Renamed" });

    // ...but repointing it at an already-taken one is rejected.
    await expect(
      store.update(first!.id, { kind: "catalog", piProvider: "deepseek" }),
    ).rejects.toThrow(/already configured as "DeepSeek"/);
  });

  it("round-trips a catalog provider's baseURL override and resolves it", async () => {
    const store = createProviderStore(dir);
    const created = await store.create({
      name: "DeepSeek mirror",
      kind: "catalog",
      piProvider: "deepseek",
      baseURL: "https://mirror.internal/deepseek",
      models: [{ code: "deepseek-v4-flash" }],
    });
    if (created.kind !== "catalog") throw new Error("expected a catalog provider");
    expect(created.baseURL).toBe("https://mirror.internal/deepseek");

    const resolved = await store.resolveModel(created.id, "deepseek-v4-flash");
    expect(resolved).toMatchObject({ kind: "catalog", baseURL: "https://mirror.internal/deepseek" });

    // Clearing it explicitly returns the provider to pi-ai's own address;
    // omitting the field entirely leaves the override in place.
    await store.update(created.id, { kind: "catalog", name: "DeepSeek mirror" });
    const untouched = await store.resolveModel(created.id, "deepseek-v4-flash");
    expect(untouched).toMatchObject({ baseURL: "https://mirror.internal/deepseek" });

    await store.update(created.id, { kind: "catalog", baseURL: null });
    const cleared = await store.resolveModel(created.id, "deepseek-v4-flash");
    expect(cleared).toMatchObject({ baseURL: null });
  });

  it("defaults a legacy catalog record with no baseURL field to null", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "providers.json"),
      JSON.stringify([
        {
          kind: "catalog",
          id: "legacy-no-base",
          name: "DeepSeek",
          piProvider: "deepseek",
          apiKeyEnc: null,
          models: [{ code: "deepseek-v4-flash" }],
        },
      ]),
      "utf-8",
    );
    const store = createProviderStore(dir);
    const [listed] = await store.listPublic();
    expect(listed).toMatchObject({ kind: "catalog", baseURL: null });
    expect(await store.resolveModel("legacy-no-base", "deepseek-v4-flash")).toMatchObject({
      baseURL: null,
    });
  });

  it("rejects a non-positive contextWindow on a catalog model", async () => {
    const store = createProviderStore(dir);
    await expect(
      store.create({
        name: "OpenAI",
        kind: "catalog",
        piProvider: "openai",
        models: [{ code: "gpt-5", contextWindow: 0 }],
      }),
    ).rejects.toThrow(/contextWindow/);
  });

  it("reads a legacy catalog record's modelCodes as override-free models", async () => {
    // A catalog record written before enabled models became configurable:
    // a bare code list and no `models` at all. Read-time default, same as
    // `kind` — nothing on disk is rewritten until the user saves.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "providers.json"),
      JSON.stringify([
        {
          kind: "catalog",
          id: "legacy-catalog",
          name: "DeepSeek",
          piProvider: "deepseek",
          apiKeyEnc: null,
          modelCodes: ["deepseek-v4-flash", "deepseek-v4-pro"],
        },
      ]),
      "utf-8",
    );

    const [listed] = await createProviderStore(dir).listPublic();
    expect(listed).toMatchObject({
      kind: "catalog",
      models: [{ code: "deepseek-v4-flash" }, { code: "deepseek-v4-pro" }],
    });

    // Still routable: a turn on a legacy record must resolve by code.
    const resolved = await createProviderStore(dir).resolveModel(
      "legacy-catalog",
      "deepseek-v4-pro",
    );
    expect(resolved).toMatchObject({ kind: "catalog", code: "deepseek-v4-pro" });
  });

  it("reads a legacy record with no kind field as custom, with its model list intact", async () => {
    // Write a providers.json by hand that predates the discriminator — no
    // `kind` field at all, exactly the shape the file had before this change.
    await fs.mkdir(dir, { recursive: true });
    const legacy = [
      {
        id: "legacy-1",
        name: "Legacy Provider",
        baseURL: "https://legacy.example.com/v1",
        apiKeyEnc: null,
        models: [{ id: "m1", name: "Legacy Model", code: "legacy-code" }],
      },
    ];
    expect("kind" in legacy[0]!).toBe(false);
    await fs.writeFile(path.join(dir, "providers.json"), JSON.stringify(legacy), "utf-8");

    const store = createProviderStore(dir);
    const [listed] = await store.listPublic();
    expect(listed!.kind).toBe("custom");
    expect(asCustom(listed!).models).toEqual([{ id: "m1", name: "Legacy Model", code: "legacy-code" }]);
  });

  it("resolveModel returns a custom shape for a custom provider", async () => {
    const store = createProviderStore(dir);
    const created = asCustom(await store.create({ ...INPUT, kind: "custom" }));
    const resolved = await store.resolveModel(created.id, created.models[0]!.id);
    expect(resolved).toMatchObject({
      kind: "custom",
      baseURL: "https://example.com/v1",
      apiKey: "sk-abcdefgh3f2a",
      code: "mimo-v2.5",
    });
  });

  it("resolveModel returns a catalog shape for a catalog provider", async () => {
    const store = createProviderStore(dir);
    const created = await store.create({
      name: "OpenAI",
      kind: "catalog",
      piProvider: "openai",
      apiKey: "sk-abcdefgh3f2a",
      models: [{ code: "gpt-5" }],
    });
    const resolved = await store.resolveModel(created.id, "gpt-5");
    expect(resolved).toMatchObject({
      kind: "catalog",
      piProvider: "openai",
      apiKey: "sk-abcdefgh3f2a",
      code: "gpt-5",
    });
  });

  it("rejects update() when input.kind differs from the stored provider's kind", async () => {
    const store = createProviderStore(dir);
    const custom = await store.create({ ...INPUT, kind: "custom" });
    await expect(
      store.update(custom.id, {
        kind: "catalog",
        piProvider: "openai",
        models: [{ code: "gpt-5" }],
      } as never),
    ).rejects.toThrow(/kind/);
    // Rejected update must not have mutated the stored record.
    const [listed] = await store.listPublic();
    expect(listed!.kind).toBe("custom");

    const catalog = await store.create({
      name: "OpenAI",
      kind: "catalog",
      piProvider: "openai",
      apiKey: "sk-abcdefgh3f2a",
      models: [{ code: "gpt-5" }],
    });
    await expect(
      store.update(catalog.id, { kind: "custom", models: [] } as never),
    ).rejects.toThrow(/kind/);
  });

  it("never exposes a plaintext apiKey through listPublic for a catalog provider", async () => {
    const store = createProviderStore(dir);
    await store.create({
      name: "OpenAI",
      kind: "catalog",
      piProvider: "openai",
      apiKey: "sk-abcdefgh3f2a",
      models: [{ code: "gpt-5" }],
    });
    expect(JSON.stringify(await store.listPublic())).not.toContain("sk-abcdefgh3f2a");
  });
});

describe("model maxOutputTokens", () => {
  it("persists a valid maxOutputTokens and returns it publicly", async () => {
    const store = createProviderStore(dir);
    await store.create({
      name: "p1",
      models: [{ name: "M", code: "m-1", maxOutputTokens: 8192 }],
    });
    const [provider] = await store.listPublic();
    expect(asCustom(provider!).models[0]).toMatchObject({ code: "m-1", maxOutputTokens: 8192 });
    const raw = JSON.parse(await fs.readFile(path.join(dir, "providers.json"), "utf-8"));
    expect(raw[0].models[0].maxOutputTokens).toBe(8192);
  });

  it("rejects zero, negative and non-integer maxOutputTokens", async () => {
    const store = createProviderStore(dir);
    await expect(
      store.create({ name: "p1", models: [{ name: "M", code: "m-1", maxOutputTokens: 0 }] }),
    ).rejects.toThrow(/maxOutputTokens/);
    await expect(
      store.create({ name: "p1", models: [{ name: "M", code: "m-1", maxOutputTokens: -5 }] }),
    ).rejects.toThrow(/maxOutputTokens/);
    await expect(
      store.create({ name: "p1", models: [{ name: "M", code: "m-1", maxOutputTokens: 12.5 }] }),
    ).rejects.toThrow(/maxOutputTokens/);
  });

  it("carries maxOutputTokens through resolveModel so a turn can be built with it", async () => {
    const store = createProviderStore(dir);
    const created = asCustom(
      await store.create({
        name: "p1",
        apiKey: "sk-abcdefgh3f2a",
        models: [{ name: "M", code: "m-1", maxOutputTokens: 4096 }],
      }),
    );
    const resolved = await store.resolveModel(created.id, created.models[0]!.id);
    expect(resolved).toMatchObject({ code: "m-1", maxOutputTokens: 4096 });
  });

  it("omits maxOutputTokens from resolveModel when the model has none", async () => {
    const store = createProviderStore(dir);
    const created = asCustom(await store.create({ name: "p1", models: [{ name: "M", code: "m-1" }] }));
    const resolved = await store.resolveModel(created.id, created.models[0]!.id);
    expect(resolved).not.toHaveProperty("maxOutputTokens");
  });
});
