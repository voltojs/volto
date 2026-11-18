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

  it("persists the section inside config.json and nowhere else", async () => {
    await updateWebSearchConfig(dir, { source: "glm", glm: { apiKey: "sk-1234567890" } });
    const file = path.join(dir, "config.json");
    const document = JSON.parse(await fs.readFile(file, "utf8")) as {
      version: number;
      webSearch: { source: string; glm: { apiKeyEnc: string | null } };
    };
    expect(document.webSearch.source).toBe("glm");
    expect(document.webSearch.glm.apiKeyEnc).toEqual(expect.any(String));
    // Stored encrypted: the plaintext never reaches the document.
    expect(document.webSearch.glm.apiKeyEnc).not.toContain("sk-1234567890");
    // One document for every section — no per-domain web-search file appears.
    const files = await fs.readdir(dir);
    expect(files.filter((name) => /web[-_]?search/.test(name))).toEqual([]);
    expect(files).toContain("config.json");
  });

  it("keeps sibling sections intact when the section is written", async () => {
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ version: 1, egress: { allowHosts: ["api.deepseek.com"] } }),
      "utf-8",
    );
    await updateWebSearchConfig(dir, { brave: { apiKey: "brave-key-value" } });
    const document = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")) as {
      egress: { allowHosts: string[] };
      webSearch: { brave: { apiKeyEnc: string | null } };
    };
    expect(document.egress.allowHosts).toEqual(["api.deepseek.com"]);
    expect(document.webSearch.brave.apiKeyEnc).toEqual(expect.any(String));
  });

  it("shows the saved key as configured in the settings view", async () => {
    await updateWebSearchConfig(dir, { source: "deepseek", deepseek: { apiKey: "sk-1234567890" } });
    const view = await readWebSearchSettingsView(dir);
    expect(view.resolved.sourceId).toBe("deepseek");
    expect(view.resolved.reason).toBe("configured");
  });

  it("surfaces resolution warnings in the view", async () => {
    await writeConfig({ source: "deepseek", deepseek: { sourceProviderId: "ghost" } });
    const view = await readWebSearchSettingsView(dir);
    expect(view.resolved.reason).toBe("unconfigured");
    expect(view.warnings.join(" ")).toContain("no API key");
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
