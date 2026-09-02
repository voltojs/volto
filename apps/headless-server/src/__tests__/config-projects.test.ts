import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createProjectStore, InvalidPathError } from "../config/projects.js";

let dir: string;
let workdir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-proj-"));
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-work-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(workdir, { recursive: true, force: true });
});

describe("createProjectStore", () => {
  it("starts empty", async () => {
    expect(await createProjectStore(dir).list()).toEqual([]);
  });

  it("creates and persists a project across store instances", async () => {
    const created = await createProjectStore(dir).create({ name: "demo", path: workdir });
    expect(created.id).toBeTruthy();
    expect(created.path).toBe(workdir);

    const reloaded = await createProjectStore(dir).list();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.name).toBe("demo");
  });

  it("rejects a path that does not exist", async () => {
    const store = createProjectStore(dir);
    await expect(
      store.create({ name: "ghost", path: path.join(workdir, "nope") }),
    ).rejects.toBeInstanceOf(InvalidPathError);
  });

  it("rejects a path that is a file rather than a directory", async () => {
    const file = path.join(workdir, "a.txt");
    await fs.writeFile(file, "x");
    await expect(
      createProjectStore(dir).create({ name: "file", path: file }),
    ).rejects.toBeInstanceOf(InvalidPathError);
  });

  it("rejects a relative path", async () => {
    await expect(
      createProjectStore(dir).create({ name: "rel", path: "./somewhere" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
  });

  it("removes a project and reports whether it existed", async () => {
    const store = createProjectStore(dir);
    const created = await store.create({ name: "demo", path: workdir });
    expect(await store.remove(created.id)).toBe(true);
    expect(await store.remove(created.id)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("looks a project up by id", async () => {
    const store = createProjectStore(dir);
    const created = await store.create({ name: "demo", path: workdir });
    expect((await store.findById(created.id))?.path).toBe(workdir);
    expect(await store.findById("missing")).toBeNull();
  });
});
