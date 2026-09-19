import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadEgressPolicy } from "../config/egress.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-egress-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(path.join(dir, "egress.json"), content, "utf-8");
}

describe("loadEgressPolicy", () => {
  it("returns null when no config file exists", async () => {
    expect(await loadEgressPolicy(dir)).toBeNull();
  });

  it("parses and normalizes hosts (trim + lowercase)", async () => {
    await writeConfig(
      JSON.stringify({ allowHosts: ["  API.Example.COM "], denyHosts: ["Evil.Org"] }),
    );
    expect(await loadEgressPolicy(dir)).toEqual({
      allowHosts: ["api.example.com"],
      denyHosts: ["evil.org"],
    });
  });

  it("returns null for an object without any rule keys", async () => {
    await writeConfig("{}");
    expect(await loadEgressPolicy(dir)).toBeNull();
  });

  it("keeps an empty allowHosts array — it means deny-all, not 'no policy'", async () => {
    await writeConfig(JSON.stringify({ allowHosts: [] }));
    expect(await loadEgressPolicy(dir)).toEqual({ allowHosts: [] });
  });

  it("throws on malformed JSON", async () => {
    await writeConfig("{ not json");
    await expect(loadEgressPolicy(dir)).rejects.toThrow(/egress\.json/);
  });

  it("throws on a non-object top level", async () => {
    await writeConfig(JSON.stringify(["api.example.com"]));
    await expect(loadEgressPolicy(dir)).rejects.toThrow(/object/);
  });

  it("throws when a host entry is not a string", async () => {
    await writeConfig(JSON.stringify({ allowHosts: ["ok.example.com", 42] }));
    await expect(loadEgressPolicy(dir)).rejects.toThrow(/must be an array of hostnames/);
  });

  it("throws on unknown keys — a typo must not silently disable the policy", async () => {
    await writeConfig(JSON.stringify({ allowHost: "api.example.com" }));
    await expect(loadEgressPolicy(dir)).rejects.toThrow(/allowHost/);
  });
});
