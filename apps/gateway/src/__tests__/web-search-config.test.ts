import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  WebSearchConfigError,
  loadWebSearchConfig,
  readWebSearchSettingsView,
  updateWebSearchConfig,
} from "../config/web-search.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-config-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeConfig(section: unknown): Promise<void> {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ version: 1, webSearch: section }),
    "utf-8",
  );
}

async function writeProviders(providers: unknown[]): Promise<void> {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ version: 1, providers }),
    "utf-8",
  );
}

const openAiProvider = {
  kind: "catalog",
  id: "openai",
  name: "OpenAI",
  piProvider: "openai",
  baseURL: null,
  apiKeyEnc: null,
  models: [{ code: "gpt-x" }],
};

const deepSeekProvider = {
  kind: "catalog",
  id: "deepseek",
  name: "DeepSeek",
  piProvider: "deepseek",
  baseURL: null,
  apiKeyEnc: null,
  models: [{ code: "deepseek-chat" }],
};

describe("loadWebSearchConfig", () => {
  it("returns the documented defaults when the section is absent", async () => {
    const { config, warnings } = await loadWebSearchConfig(dir);
    expect(config.source).toBe("auto");
    expect(config.custom).toEqual([]);
    expect(config.deepseek.apiKeyEnc).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("warns instead of throwing on an invalid source", async () => {
    await writeConfig({ source: "nope" });
    const { config, warnings } = await loadWebSearchConfig(dir);
    expect(config.source).toBe("auto");
    expect(warnings.join(" ")).toContain("source");
  });

  it("ignores unknown keys with a warning (a typo must not stop sessions)", async () => {
    await writeConfig({ source: "glm", glmm: {} });
    const { config, warnings } = await loadWebSearchConfig(dir);
    expect(config.source).toBe("glm");
    expect(warnings.join(" ")).toContain("glmm");
  });
});

describe("readWebSearchSettingsView / updateWebSearchConfig", () => {
  it("masks keys in the view and never returns plaintext", async () => {
    await updateWebSearchConfig(dir, { source: "glm", glm: { apiKey: "sk-1234567890" } });
    const view = await readWebSearchSettingsView(dir);
    expect(view.builtins.glm.apiKeyMasked).toContain("7890");
    expect(view.builtins.glm.apiKeyMasked).not.toBe("sk-1234567890");
    expect(JSON.stringify(view)).not.toContain("sk-1234567890");
  });

  it("clears a key with null", async () => {
    await updateWebSearchConfig(dir, { source: "brave", brave: { apiKey: "kkkkkkkkkk" } });
    const view = await updateWebSearchConfig(dir, { brave: { apiKey: null } });
    expect(view.builtins.brave.apiKeyMasked).toBeNull();
  });

  it("rejects an unknown key and a bad source on write", async () => {
    await expect(updateWebSearchConfig(dir, { source: "nope" })).rejects.toBeInstanceOf(
      WebSearchConfigError,
    );
    await expect(
      updateWebSearchConfig(dir, { glm: { apiKey: "k", bogus: 1 } as never }),
    ).rejects.toBeInstanceOf(WebSearchConfigError);
  });

  it("rejects a base URL that is not http(s)", async () => {
    await expect(
      updateWebSearchConfig(dir, { deepseek: { baseUrl: "file:///etc/passwd" } }),
    ).rejects.toBeInstanceOf(WebSearchConfigError);
  });
});

describe("provider channel candidates", () => {
  it("only offers DeepSeek-capable channels", async () => {
    await writeProviders([openAiProvider, deepSeekProvider]);
    const view = await readWebSearchSettingsView(dir);
    expect(view.candidates.map((c) => c.id)).toEqual(["deepseek"]);
  });

  it("rejects a sourceProviderId that is not a DeepSeek channel", async () => {
    await writeProviders([openAiProvider]);
    await expect(
      updateWebSearchConfig(dir, { deepseek: { sourceProviderId: "openai" } }),
    ).rejects.toBeInstanceOf(WebSearchConfigError);
  });

  it("accepts a DeepSeek channel id", async () => {
    await writeProviders([deepSeekProvider]);
    const view = await updateWebSearchConfig(dir, { deepseek: { sourceProviderId: "deepseek" } });
    expect(view.builtins.deepseek.sourceProviderId).toBe("deepseek");
  });
});
