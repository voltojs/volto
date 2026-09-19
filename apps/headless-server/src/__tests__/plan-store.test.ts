import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createPlanStore } from "../config/plan-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-plan-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("createPlanStore", () => {
  it("saves, reads, and overwrites the plan at the session-scoped path", async () => {
    const store = createPlanStore(dir);
    const projectPath = "/tmp/the-project";
    await store.save("sess-1", projectPath, "# v1");
    const file = path.join(dir, "sessions", "-tmp-the-project", "sess-1.plan.md");
    expect(await fs.readFile(file, "utf-8")).toBe("# v1");
    await store.save("sess-1", projectPath, "# v2");
    await expect(store.read("sess-1", projectPath)).resolves.toBe("# v2");
  });

  it("read returns null when no plan exists", async () => {
    const store = createPlanStore(dir);
    await expect(store.read("nope", "/tmp/the-project")).resolves.toBeNull();
  });

  it("deleteBySession removes the plan file only for that session", async () => {
    const store = createPlanStore(dir);
    await store.save("s1", "/tmp/p", "# a");
    await store.save("s2", "/tmp/p", "# b");
    await store.deleteBySession("s1", "/tmp/p");
    await expect(store.read("s1", "/tmp/p")).resolves.toBeNull();
    await expect(store.read("s2", "/tmp/p")).resolves.toBe("# b");
  });
});
