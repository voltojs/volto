import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EndpointSourceSpec } from "@voltojs/tools/web";
import {
  WebSearchConfigError,
  createCustomSource,
  deleteCustomSource,
  updateCustomSource,
  updateWebSearchConfig,
} from "../config/web-search.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-custom-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const spec: EndpointSourceSpec = {
  method: "POST",
  url: "https://s.example.com/search",
  bodyTemplate: '{"q":"{{query}}"}',
  paths: { list: "items", title: "title", url: "url" },
};

describe("custom search sources", () => {
  it("creates, updates and deletes a custom source", async () => {
    let view = await createCustomSource(dir, { name: "我的搜索", apiKey: "k", endpoint: spec });
    expect(view.custom).toHaveLength(1);
    const id = view.custom[0]!.id;
    expect(view.custom[0]!.apiKeyMasked).not.toBe("k");

    view = await updateCustomSource(dir, id, { name: "Renamed", endpoint: spec });
    expect(view.custom[0]!.name).toBe("Renamed");

    view = await deleteCustomSource(dir, id);
    expect(view.custom).toEqual([]);
  });

  it("falls back to auto when the deleted source was selected", async () => {
    const created = await createCustomSource(dir, { name: "S", endpoint: spec });
    const id = created.custom[0]!.id;
    await updateWebSearchConfig(dir, { source: id });
    const after = await deleteCustomSource(dir, id);
    expect(after.source).toBe("auto");
    expect(after.warnings.join(" ")).toContain("auto");
  });

  it("slugs ids and de-duplicates them", async () => {
    const first = await createCustomSource(dir, { name: "My Search", endpoint: spec });
    const second = await createCustomSource(dir, { name: "My Search", endpoint: spec });
    expect(first.custom[0]!.id).toBe("my-search");
    expect(second.custom[1]!.id).toBe("my-search-2");
  });

  it("rejects specs that cannot work", async () => {
    await expect(
      createCustomSource(dir, { name: "S", endpoint: { ...spec, method: "PUT" as never } }),
    ).rejects.toBeInstanceOf(WebSearchConfigError);
    await expect(
      createCustomSource(dir, { name: "S", endpoint: { ...spec, url: "file:///etc/passwd" } }),
    ).rejects.toBeInstanceOf(WebSearchConfigError);
    await expect(
      createCustomSource(dir, { name: "S", endpoint: { ...spec, bodyTemplate: "{" } }),
    ).rejects.toBeInstanceOf(WebSearchConfigError);
    await expect(
      createCustomSource(dir, {
        name: "S",
        endpoint: { ...spec, paths: { list: "items", title: "t", url: "" } },
      }),
    ).rejects.toBeInstanceOf(WebSearchConfigError);
    await expect(createCustomSource(dir, { name: "  ", endpoint: spec })).rejects.toBeInstanceOf(
      WebSearchConfigError,
    );
  });
});
