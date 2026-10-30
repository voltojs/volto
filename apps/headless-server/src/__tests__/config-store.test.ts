import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureConfigMigrated, getConfigStore } from "../config/store.js";
import { ConfigCorruptError } from "../config/io.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-config-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ConfigStore", () => {
  it("serializes concurrent updates so none are lost", async () => {
    const dir = await tmp();
    const store = getConfigStore(dir);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.update<Record<string, unknown>>("preferences", (current) => ({
          ...current,
          [`k${i}`]: i,
        })),
      ),
    );

    const config = await store.read();
    expect(Object.keys(config["preferences"] as Record<string, unknown>)).toHaveLength(10);
  });

  it("keeps the previous document as config.json.bak", async () => {
    const dir = await tmp();
    const store = getConfigStore(dir);
    await store.update("preferences", () => ({ first: true }));
    await store.update("preferences", () => ({ second: true }));

    const backup = JSON.parse(
      await fs.readFile(path.join(dir, "config.json.bak"), "utf8"),
    ) as { preferences: Record<string, unknown> };
    expect(backup.preferences).toEqual({ first: true });
  });

  it("falls back to config.json.bak when config.json is corrupt", async () => {
    const dir = await tmp();
    const store = getConfigStore(dir);
    await store.update("preferences", () => ({ a: 1 }));

    const good = await fs.readFile(path.join(dir, "config.json"), "utf8");
    await fs.writeFile(path.join(dir, "config.json.bak"), good, "utf8");
    await fs.writeFile(path.join(dir, "config.json"), "{ not json", "utf8");

    const config = await store.read();
    expect(config["preferences"]).toEqual({ a: 1 });
  });

  it("throws when both config.json and config.json.bak are corrupt", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "config.json"), "{", "utf8");
    await fs.writeFile(path.join(dir, "config.json.bak"), "{", "utf8");

    await expect(getConfigStore(dir).read()).rejects.toThrow(ConfigCorruptError);
  });

  it("reads legacy per-domain files when config.json is absent", async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "projects.json"),
      JSON.stringify([{ id: "p1", name: "n", path: "/p", createdAt: 1 }]),
    );
    await fs.writeFile(
      path.join(dir, "routing-tiers.json"),
      JSON.stringify([{ id: "t", label: "T", description: "", target: null }]),
    );

    const config = await getConfigStore(dir).read();
    expect(config["projects"]).toHaveLength(1);
    expect(config["routingTiers"]).toHaveLength(1);
  });

  it("preserves unknown sections and unknown keys inside a section", async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({
        version: 1,
        preferences: { keep: "me" },
        permissions: { customKey: "keep", rules: [] },
      }),
      "utf8",
    );
    const store = getConfigStore(dir);
    await store.update<Record<string, unknown>>("preferences", (current) => ({
      ...current,
      added: true,
    }));

    const config = await store.read();
    expect(config["preferences"]).toEqual({ keep: "me", added: true });
    expect(config["permissions"]).toEqual({ customKey: "keep", rules: [] });
  });
});

describe("ensureConfigMigrated", () => {
  it("migrates legacy files once and never overwrites an existing config.json", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "projects.json"), JSON.stringify([{ id: "p1" }]));

    expect(await ensureConfigMigrated(dir)).toBe(true);
    const first = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")) as {
      projects: Array<{ id: string }>;
    };
    expect(first.projects).toEqual([{ id: "p1" }]);

    await fs.writeFile(path.join(dir, "projects.json"), JSON.stringify([{ id: "p2" }]));
    expect(await ensureConfigMigrated(dir)).toBe(false);
    const second = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")) as {
      projects: Array<{ id: string }>;
    };
    expect(second.projects).toEqual([{ id: "p1" }]);
  });

  it("does not create config.json on an empty directory", async () => {
    const dir = await tmp();
    expect(await ensureConfigMigrated(dir)).toBe(false);
    await expect(fs.access(path.join(dir, "config.json"))).rejects.toThrow();
  });

  it("skips a corrupt legacy file and still migrates the readable ones", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "projects.json"), JSON.stringify([{ id: "p1" }]));
    await fs.writeFile(path.join(dir, "providers.json"), "{ broken", "utf8");

    expect(await ensureConfigMigrated(dir)).toBe(true);
    const config = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")) as {
      projects: unknown[];
      providers?: unknown;
    };
    expect(config.projects).toHaveLength(1);
    expect(config.providers).toBeUndefined();
  });
});
