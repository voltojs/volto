/**
 * Routing tier config store + `/config/routing-tiers` routes + deletion
 * reference scan (spec 2026-10-29 task 2), plus the factory template and
 * unassigned (null) targets (spec v2 D7/D8, task 8).
 *
 * Route tests run against a real server via startRouteTestServer and create
 * referencing agent definitions through POST /agents — the same write path
 * the UI uses, so the scan is exercised against real definition files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createRoutingTierStore,
  type RoutingTierRecord,
} from "../config/routing-tiers.js";
import { getConfigPath } from "../config/paths.js";
import { startRouteTestServer } from "./helpers.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const authJson = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

const TIER_TARGET = { providerId: "p", modelId: "m" };

/**
 * The factory template spelled out verbatim (spec v2 D7/D8): the brief's
 * copy is contract — labels, descriptions and order are pinned literally
 * instead of importing the production constant.
 */
const FACTORY_TEMPLATE: RoutingTierRecord[] = [
  {
    id: "premium",
    label: "高级",
    description: "最强能力，复杂任务与深度推理",
    target: null,
  },
  {
    id: "fast",
    label: "快速",
    description: "低延迟，简单问答与快速检索",
    target: null,
  },
  {
    id: "economy",
    label: "经济",
    description: "省成本，批量与低风险子任务",
    target: null,
  },
];

function tier(id: string, target: RoutingTierRecord["target"] = TIER_TARGET): RoutingTierRecord {
  return { id, label: `${id} label`, description: `${id} description`, target };
}

describe("createRoutingTierStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-tiers-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns the factory template when no config file exists", async () => {
    // First-run state (spec v2 D7/D8): the presets are visible without being
    // persisted — listing must not create the config file either.
    expect(await createRoutingTierStore(dir).list()).toEqual(FACTORY_TEMPLATE);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("persists replaced records and preserves order across instances", async () => {
    const records = [tier("economy"), tier("premium")];
    await createRoutingTierStore(dir).replace(records);
    expect(await createRoutingTierStore(dir).list()).toEqual(records);
  });

  it("rejects a duplicate id and names it", async () => {
    await expect(
      createRoutingTierStore(dir).replace([tier("economy"), tier("premium"), tier("economy")]),
    ).rejects.toThrow(/economy/);
  });

  it("rejects an empty id, naming the offending record", async () => {
    await expect(
      createRoutingTierStore(dir).replace([{ ...tier("economy"), id: "" }]),
    ).rejects.toThrow(/index 0.*non-empty id/);
  });

  it("rejects a whitespace-only id, naming the offending record", async () => {
    await expect(
      createRoutingTierStore(dir).replace([{ ...tier("economy"), id: " " }]),
    ).rejects.toThrow(/index 0.*non-empty id/);
  });

  it("writes nothing when validation fails", async () => {
    const store = createRoutingTierStore(dir);
    await expect(store.replace([tier("economy"), tier("economy")])).rejects.toThrow();
    // Nothing persisted: the directory is untouched, so a read still falls
    // back to the factory template.
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await store.list()).toEqual(FACTORY_TEMPLATE);
  });
});

describe("/config/routing-tiers", () => {
  /** Creates a custom provider whose first model is a valid tier target. */
  async function createTarget(
    url: string,
    token: string,
  ): Promise<{ providerId: string; modelId: string }> {
    const res = await fetch(`${url}/providers`, {
      method: "POST",
      headers: authJson(token),
      body: JSON.stringify({ name: "tier-targets", models: [{ name: "m", code: "m" }] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; models: Array<{ id: string }> };
    return { providerId: body.id, modelId: body.models[0]!.id };
  }

  function putTiers(url: string, token: string, tiers: RoutingTierRecord[]): Promise<Response> {
    return fetch(`${url}/config/routing-tiers`, {
      method: "PUT",
      headers: authJson(token),
      body: JSON.stringify(tiers),
    });
  }

  function getTiers(url: string, token: string): Promise<Response> {
    return fetch(`${url}/config/routing-tiers`, { headers: auth(token) });
  }

  it("answers the factory template before anything is configured", async () => {
    const { url, token, close } = await startRouteTestServer();
    const res = await getTiers(url, token);
    expect(res.status).toBe(200);
    // Three presets in premium → fast → economy order, verbatim copy, and
    // every target unassigned (null) — a legal state, not an error.
    const body = (await res.json()) as { tiers: RoutingTierRecord[] };
    expect(body.tiers).toEqual(FACTORY_TEMPLATE);
    expect(body.tiers.map((t) => t.target)).toEqual([null, null, null]);
    await close();
  });

  it("never writes a config file when serving the template", async () => {
    const { url, token, close } = await startRouteTestServer();
    const tiersFile = getConfigPath("routing-tiers.json");
    // Template GETs are read-only: repeated reads stay on the template and
    // no routing-tiers.json ever appears (the first PUT persists instead).
    for (let i = 0; i < 2; i += 1) {
      const body = (await (await getTiers(url, token)).json()) as { tiers: RoutingTierRecord[] };
      expect(body.tiers.map((t) => t.id)).toEqual(["premium", "fast", "economy"]);
      expect(await fs.readdir(path.dirname(tiersFile))).not.toContain(path.basename(tiersFile));
    }
    await close();
  });

  it("accepts an unassigned (null) target without any provider lookup", async () => {
    const { url, token, close } = await startRouteTestServer();
    // No provider is created on purpose: `target: null` means "unassigned",
    // so validation must skip resolving it. `reasoningEffort` rides along
    // unvalidated — the port layer's per-call gate owns its value (spec D10).
    const records: RoutingTierRecord[] = [
      { ...tier("unassigned"), target: null, reasoningEffort: "ultra" },
    ];
    const put = await putTiers(url, token, records);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ tiers: records });
    expect(await (await getTiers(url, token)).json()).toEqual({ tiers: records });
    await close();
  });

  it("still rejects an unresolvable non-null target beside unassigned tiers", async () => {
    const { url, token, close } = await startRouteTestServer();
    const put = await putTiers(url, token, [
      { ...tier("unassigned"), target: null },
      tier("ghost", { providerId: "ghost-provider", modelId: "ghost-model" }),
    ]);
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    // The null-skip branch must not swallow the real target check.
    expect(body.error).toContain("ghost");
    expect(body.error).toContain("ghost-provider");
    expect(body.error).toContain("ghost-model");
    await close();
  });

  it("returns the persisted table verbatim once a config file exists", async () => {
    const { url, token, close } = await startRouteTestServer();
    const target = await createTarget(url, token);
    // Deliberately unlike the template (different ids, one assigned and one
    // not): a present file always wins over the factory presets.
    const records: RoutingTierRecord[] = [
      {
        id: "custom-a",
        label: "A",
        description: "first custom tier",
        target,
        reasoningEffort: "max",
      },
      { id: "custom-b", label: "B", description: "second custom tier", target: null },
    ];
    expect((await putTiers(url, token, records)).status).toBe(200);
    expect(await (await getTiers(url, token)).json()).toEqual({ tiers: records });
    await close();
  });

  it("shows the factory template only while no config file exists", async () => {
    const { url, token, close } = await startRouteTestServer();
    // An explicitly cleared table is a real, persisted `[]` — the template
    // must not resurrect over it...
    expect((await putTiers(url, token, [])).status).toBe(200);
    expect(await (await getTiers(url, token)).json()).toEqual({ tiers: [] });

    // ...and once the file is gone the first-run template comes back.
    await fs.rm(getConfigPath("routing-tiers.json"));
    expect(await (await getTiers(url, token)).json()).toEqual({ tiers: FACTORY_TEMPLATE });
    await close();
  });

  it("accepts a valid array and GET reads it back in order", async () => {
    const { url, token, close } = await startRouteTestServer();
    const target = await createTarget(url, token);
    const records = [tier("economy", target), tier("premium", target)];

    const put = await putTiers(url, token, records);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ tiers: records });

    const get = await getTiers(url, token);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ tiers: records });
    await close();
  });

  it("rejects a duplicate id with 400 naming the id", async () => {
    const { url, token, close } = await startRouteTestServer();
    const target = await createTarget(url, token);
    const put = await putTiers(url, token, [tier("economy", target), tier("economy", target)]);
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toContain("economy");
    // Validation must fail before anything is persisted — the read still
    // falls back to the untouched factory template.
    expect(await (await getTiers(url, token)).json()).toEqual({ tiers: FACTORY_TEMPLATE });
    await close();
  });

  it("rejects the reserved inherit sentinel id with 400 naming it", async () => {
    const { url, token, close } = await startRouteTestServer();
    const target = await createTarget(url, token);
    // `__inherit__` is the web form's sentinel for "inherit the parent
    // model"; a tier id colliding with it would make that tier unselectable
    // in the form, so the table must refuse to store it.
    const put = await putTiers(url, token, [tier("__inherit__", target)]);
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toContain("__inherit__");
    // Validation must fail before anything is persisted — the read still
    // falls back to the untouched factory template.
    expect(await (await getTiers(url, token)).json()).toEqual({ tiers: FACTORY_TEMPLATE });
    await close();
  });

  it("rejects a whitespace-only id with 400 naming the index", async () => {
    const { url, token, close } = await startRouteTestServer();
    const target = await createTarget(url, token);
    // A whitespace-only id is as unusable as an empty one (it can never be
    // matched by a dispatch), so the PUT must refuse it the same way.
    const put = await putTiers(url, token, [tier("economy", target), tier(" ", target)]);
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toContain("index 1");
    // Validation must fail before anything is persisted — the read still
    // falls back to the untouched factory template.
    expect(await (await getTiers(url, token)).json()).toEqual({ tiers: FACTORY_TEMPLATE });
    await close();
  });

  it("rejects a body that is not an array with 400", async () => {
    const { url, token, close } = await startRouteTestServer();
    const put = await fetch(`${url}/config/routing-tiers`, {
      method: "PUT",
      headers: authJson(token),
      body: JSON.stringify({ tiers: [] }),
    });
    expect(put.status).toBe(400);
    await close();
  });

  it("rejects a target that resolves to no model with 400 naming tier id and target", async () => {
    const { url, token, close } = await startRouteTestServer();
    const put = await putTiers(url, token, [
      tier("economy", { providerId: "ghost-provider", modelId: "ghost-model" }),
    ]);
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toContain("economy");
    expect(body.error).toContain("ghost-provider");
    expect(body.error).toContain("ghost-model");
    await close();
  });

  it("blocks removal with 409 when a user-scope definition references the tier", async () => {
    const { url, token, close } = await startRouteTestServer();
    const target = await createTarget(url, token);
    expect((await putTiers(url, token, [tier("economy", target)])).status).toBe(200);

    const create = await fetch(`${url}/agents`, {
      method: "POST",
      headers: authJson(token),
      body: JSON.stringify({ scope: "user", spec: { name: "thrifty", model: "economy" } }),
    });
    expect(create.status).toBe(201);

    const put = await putTiers(url, token, [tier("premium", target)]);
    expect(put.status).toBe(409);
    const body = (await put.json()) as {
      error: string;
      references: Array<{ name: string; scope: string }>;
    };
    expect(body.references).toContainEqual({ name: "thrifty", scope: "user" });
    expect(body.error).toContain("economy");
    // The blocked delete must not have changed anything.
    expect(await (await getTiers(url, token)).json()).toEqual({ tiers: [tier("economy", target)] });
    await close();
  });

  it("blocks removal with 409 when a project-scope definition references the tier", async () => {
    const { url, token, close } = await startRouteTestServer();
    const target = await createTarget(url, token);
    expect((await putTiers(url, token, [tier("economy", target)])).status).toBe(200);

    const create = await fetch(`${url}/agents`, {
      method: "POST",
      headers: authJson(token),
      body: JSON.stringify({ scope: "project", spec: { name: "reviewer", model: "economy" } }),
    });
    expect(create.status).toBe(201);

    const put = await putTiers(url, token, []);
    expect(put.status).toBe(409);
    const body = (await put.json()) as {
      references: Array<{ name: string; scope: string }>;
    };
    expect(body.references).toContainEqual({ name: "reviewer", scope: "project" });
    await close();
  });

  it("reports a vanished project in skipped and still deletes when nothing references the tier", async () => {
    const { url, token, close } = await startRouteTestServer();
    const target = await createTarget(url, token);
    expect((await putTiers(url, token, [tier("economy", target)])).status).toBe(200);

    // Register a project, then delete its directory: the scan must skip it
    // and say so instead of failing or silently deciding.
    const doomed = await fs.mkdtemp(path.join(os.tmpdir(), "volto-tiers-project-"));
    const registered = await fetch(`${url}/projects`, {
      method: "POST",
      headers: authJson(token),
      body: JSON.stringify({ name: "doomed", path: doomed }),
    });
    expect(registered.status).toBe(201);
    await fs.rm(doomed, { recursive: true, force: true });

    const put = await putTiers(url, token, []);
    expect(put.status).toBe(200);
    const body = (await put.json()) as {
      tiers: RoutingTierRecord[];
      skipped?: Array<{ projectPath: string; reason: string }>;
    };
    expect(body.tiers).toEqual([]);
    expect(body.skipped).toContainEqual({ projectPath: doomed, reason: expect.any(String) });
    await close();
  });

  it("still blocks on a user-scope reference while reporting the vanished project", async () => {
    const { url, token, close } = await startRouteTestServer();
    const target = await createTarget(url, token);
    expect((await putTiers(url, token, [tier("economy", target)])).status).toBe(200);

    const create = await fetch(`${url}/agents`, {
      method: "POST",
      headers: authJson(token),
      body: JSON.stringify({ scope: "user", spec: { name: "thrifty", model: "economy" } }),
    });
    expect(create.status).toBe(201);

    const doomed = await fs.mkdtemp(path.join(os.tmpdir(), "volto-tiers-project-"));
    const registered = await fetch(`${url}/projects`, {
      method: "POST",
      headers: authJson(token),
      body: JSON.stringify({ name: "doomed", path: doomed }),
    });
    expect(registered.status).toBe(201);
    await fs.rm(doomed, { recursive: true, force: true });

    const put = await putTiers(url, token, []);
    expect(put.status).toBe(409);
    const body = (await put.json()) as {
      references: Array<{ name: string; scope: string }>;
      skipped?: Array<{ projectPath: string; reason: string }>;
    };
    expect(body.references).toContainEqual({ name: "thrifty", scope: "user" });
    expect(body.skipped).toContainEqual({ projectPath: doomed, reason: expect.any(String) });
    await close();
  });

  it("treats plugin references as visible but non-blocking hints", async () => {
    const { url, token, close } = await startRouteTestServer({
      pluginAgents: [{ name: "plugin-fixer", model: "economy" }],
    });
    const target = await createTarget(url, token);
    expect((await putTiers(url, token, [tier("economy", target)])).status).toBe(200);

    const put = await putTiers(url, token, []);
    expect(put.status).toBe(200);
    const body = (await put.json()) as {
      tiers: RoutingTierRecord[];
      references?: Array<{ name: string; scope: string }>;
    };
    expect(body.tiers).toEqual([]);
    expect(body.references).toContainEqual({ name: "plugin-fixer", scope: "plugin" });
    await close();
  });

  it("requires authentication on both verbs", async () => {
    const { url, close } = await startRouteTestServer();
    const get = await fetch(`${url}/config/routing-tiers`);
    expect(get.status).toBe(401);
    const put = await fetch(`${url}/config/routing-tiers`, { method: "PUT", body: "[]" });
    expect(put.status).toBe(401);
    await close();
  });
});
