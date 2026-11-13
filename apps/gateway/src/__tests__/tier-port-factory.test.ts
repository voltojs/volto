/**
 * Task 3 — wiring/sessions injection chain for model routing tiers (spec
 * 2026-10-29 D6): the per-dispatch subagent ModelPort factory
 * (`buildSubagentModelPortFactory`) plus the tier-table passthrough into
 * createAgent.
 *
 * Three seams are pinned here:
 * 1. the factory — target resolution through the provider store, a
 *    single-model port built on the TARGET provider's config, and the
 *    capability facts (`visionSupported` / `contextWindow`) carried on the
 *    resolution;
 * 2. `sessions.rebuild()` — reads the routing-tier table (redirected via
 *    VOLTO_CONFIG_DIR) and hands `buildAgent` BOTH keys together — or
 *    neither. The SDK reads `routingTiers !== undefined` as tier mode, so an
 *    empty table must arrive as no key at all, never `[]`, while an absent
 *    file arrives as the factory template (spec v2 D7/D8);
 * 3. `wiring.createWiredAgent` — forwards both keys verbatim to
 *    createAgent().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgent } from "@voltojs/sdk";
import type { Message, ModelPort, ReducerState } from "@voltojs/core";
import { buildSubagentModelPortFactory, createSessionRegistry } from "../sessions.js";
import { createWiredAgent } from "../wiring.js";
import { createRoutingTierStore, type RoutingTierRecord } from "../config/routing-tiers.js";

/**
 * Wrap the real createAgent so its options object can be asserted while the
 * agent itself is still built for real (same partial-mock precedent as
 * lsp-db-session.test.ts).
 */
vi.mock("@voltojs/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@voltojs/sdk")>();
  return {
    ...actual,
    createAgent: vi.fn(actual.createAgent),
  };
});

const ECONOMY: RoutingTierRecord = {
  id: "economy",
  label: "Economy",
  description: "cheap model for bulk sub-agent work",
  target: { providerId: "prov-b", modelId: "m-b" },
};

/**
 * The factory template spelled out verbatim (spec v2 D7/D8) — a local
 * literal, not the production constant, so a reordering of the presets is
 * caught here instead of following the constant blindly.
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

/** Minimal model port that ends every stream immediately. */
const IDLE_PORT: ModelPort = {
  async *stream() {
    yield { type: "done", stopReason: "end_turn" };
  },
  describeModel: async (model: string) => ({ model }),
};

let tempConfigDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-tier-config-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-tier-home-"));
  originalConfigDir = process.env["VOLTO_CONFIG_DIR"];
  process.env["VOLTO_CONFIG_DIR"] = tempConfigDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tempHomeDir;
  vi.mocked(createAgent).mockClear();
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fs.rm(tempConfigDir, { recursive: true, force: true });
  await fs.rm(tempHomeDir, { recursive: true, force: true });
});

describe("buildSubagentModelPortFactory", () => {
  it("resolves a configured target into a usable port whose describeModel answers the model code", async () => {
    // Declared per-model facts (custom-kind credentials, the shape
    // providerStore.resolveModel returns — see config/providers.ts).
    const store = {
      resolveModel: async () => ({
        kind: "custom" as const,
        baseURL: null,
        apiKey: "sk-test-secret",
        code: "m-a",
        contextWindow: 200_000,
        input: ["text", "image"] as const,
      }),
    };
    const resolve = buildSubagentModelPortFactory(store as never);

    const resolved = await resolve({ providerId: "prov-a", modelId: "m-a" });

    expect(resolved).not.toBeNull();
    expect(resolved!.model).toBe("m-a");
    const info = await resolved!.modelPort.describeModel!("m-a");
    expect(info.model).toBe("m-a");
    // Capability facts ride the resolution so the child dispatch gates images
    // and sizes compaction against the TIER model, not the parent's. The
    // declared values win — same precedence the main agent uses (rebuild
    // passes the declared window; createWiredAgent falls back to describeModel).
    expect(resolved!.visionSupported).toBe(true);
    expect(resolved!.contextWindow).toBe(200_000);
  });

  it("maps a text-only declaration to visionSupported: false and falls back to describeModel for the window", async () => {
    const textOnly = {
      resolveModel: async () => ({
        kind: "custom" as const,
        baseURL: null,
        apiKey: "sk-test-secret",
        code: "m-text",
        input: ["text"] as const,
      }),
    };
    const resolvedText = await buildSubagentModelPortFactory(textOnly as never)({
      providerId: "prov-a",
      modelId: "m-text",
    });
    // An explicit text-only list is what gates image reads for the child.
    expect(resolvedText!.visionSupported).toBe(false);
    // No declared window: the adapter's own describeModel answer is used
    // (custom-kind models fall back to the pi-ai 128k default).
    expect(resolvedText!.contextWindow).toBe(128_000);

    // No input declaration at all = UNKNOWN: the field must be omitted so the
    // SDK inherits the parent's vision gate instead of flipping it off.
    const unknownInput = {
      resolveModel: async () => ({
        kind: "custom" as const,
        baseURL: null,
        apiKey: "sk-test-secret",
        code: "m-unknown",
      }),
    };
    const resolvedUnknown = await buildSubagentModelPortFactory(unknownInput as never)({
      providerId: "prov-a",
      modelId: "m-unknown",
    });
    expect(resolvedUnknown).not.toHaveProperty("visionSupported");
  });

  it("returns null for a target the provider store cannot resolve", async () => {
    const store = { resolveModel: async () => null };
    const resolve = buildSubagentModelPortFactory(store as never);

    await expect(resolve({ providerId: "ghost", modelId: "nope" })).resolves.toBeNull();
  });

  it("builds each port on its own target's provider config id", async () => {
    // "fake credentials injected": the seam receives the target verbatim and
    // answers with that target's own credentials.
    const seen: Array<{ providerId: string; modelId: string }> = [];
    const credentialsResolver = vi.fn(
      async (target: { providerId: string; modelId: string }) => {
        seen.push(target);
        return {
          kind: "custom" as const,
          baseURL: null,
          apiKey: "sk-test-secret",
          code: target.providerId === "prov-a" ? "m-a" : "m-b",
        };
      },
    );
    const resolve = buildSubagentModelPortFactory(
      { resolveModel: async () => null } as never,
      credentialsResolver,
    );

    const resolvedA = await resolve({ providerId: "prov-a", modelId: "m-a" });
    const resolvedB = await resolve({ providerId: "prov-b", modelId: "m-b" });

    // The factory forwards the target pair untouched.
    expect(seen).toEqual([
      { providerId: "prov-a", modelId: "m-a" },
      { providerId: "prov-b", modelId: "m-b" },
    ]);
    // A port's provider route is observable only through its describeModel
    // lookup errors, which name the registered provider id — for custom-kind
    // configs that is exactly the provider config id the port was built with.
    // Each port must resolve against its OWN target's config id (and refuse
    // codes registered under any other provider).
    await expect(resolvedA!.modelPort.describeModel!("ghost")).rejects.toThrow(
      'unknown model "ghost" for provider "prov-a"',
    );
    await expect(resolvedB!.modelPort.describeModel!("ghost")).rejects.toThrow(
      'unknown model "ghost" for provider "prov-b"',
    );
    await expect(resolvedA!.modelPort.describeModel!("m-b")).rejects.toThrow(
      'unknown model "m-b" for provider "prov-a"',
    );
  });

  it("omits both capability fields when describeModel cannot describe the model", async () => {
    // Catalog credentials for a code the pi-ai catalog does not know and the
    // config says nothing about: the code is not even synthesized, so
    // describeModel throws and both fields must stay absent (UNKNOWN → the
    // SDK inherits the parent's values) rather than being invented.
    const store = {
      resolveModel: async () => ({
        kind: "catalog" as const,
        piProvider: "deepseek",
        baseURL: null,
        apiKey: "sk-test-secret",
        code: "deepseek-ghost",
      }),
    };
    const resolve = buildSubagentModelPortFactory(store as never);

    const resolved = await resolve({ providerId: "prov-c", modelId: "m-c" });

    expect(resolved).not.toBeNull();
    expect(resolved!.model).toBe("deepseek-ghost");
    expect(resolved).not.toHaveProperty("visionSupported");
    expect(resolved).not.toHaveProperty("contextWindow");
  });
});

/** Agent stub that captures every options object it was built with. */
function makeFactory() {
  const builds: Array<Record<string, unknown>> = [];
  const cumulative: Message[] = [];
  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    return {
      async *stream() {
        cumulative.push({
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: `m${cumulative.length + 1}` }],
        });
        yield { type: "text_delta", data: { text: "hi" } };
      },
      getState: () => ({ messages: [...cumulative] }) as unknown as ReducerState,
    };
  };
  return { builds, factory };
}

/** resolveModel stub answering any target with one custom-kind model. */
function makeProviderStore() {
  return {
    resolveModel: async () => ({
      kind: "custom" as const,
      baseURL: null,
      apiKey: "sk-test-secret",
      code: "m1",
    }),
  };
}

function makeRegistry(factory: ReturnType<typeof makeFactory>["factory"]) {
  const registry = createSessionRegistry({
    agentFactory: factory as never,
    projectStore: {
      findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }),
    } as never,
    providerStore: makeProviderStore() as never,
  });
  registry.attach("s1", { write: () => {}, on: () => {} } as never);
  return registry;
}

const baseConfig = {
  projectId: "p1",
  providerId: "v1",
  modelId: "m1",
  permissionMode: "ask" as const,
};

describe("sessions.rebuild tier passthrough", () => {
  it("forwards the tier table and the ModelPort factory to buildAgent when tiers are configured", async () => {
    await createRoutingTierStore(tempConfigDir).replace([ECONOMY]);
    const { builds, factory } = makeFactory();
    const registry = makeRegistry(factory);

    await registry.runTurn("s1", "one", baseConfig);

    expect(builds).toHaveLength(1);
    expect(builds[0]!["routingTiers"]).toEqual([ECONOMY]);
    const resolver = builds[0]!["resolveSubagentModelPort"] as (
      target: { providerId: string; modelId: string },
    ) => Promise<{ model: string; modelPort: ModelPort } | null>;
    expect(typeof resolver).toBe("function");
    // The forwarded factory is wired to the registry's provider store: a
    // resolvable target materializes into a fresh port on the spot.
    const resolved = await resolver({ providerId: "v1", modelId: "m1" });
    expect(resolved).not.toBeNull();
    expect(resolved!.model).toBe("m1");
  });

  it("forwards the factory template when no config file exists", async () => {
    const { builds, factory } = makeFactory();
    const registry = makeRegistry(factory);

    await registry.runTurn("s1", "one", baseConfig);

    // First-run state (spec v2 D7/D8): the factory template IS the table —
    // tier mode on, every tier unassigned — so a dispatch naming a preset
    // degrades visibly instead of leaking the id through as a raw model code.
    expect(builds[0]!["routingTiers"]).toEqual(FACTORY_TEMPLATE);
    expect(typeof builds[0]!["resolveSubagentModelPort"]).toBe("function");
  });

  it("omits both keys when the tier table is an empty array", async () => {
    await createRoutingTierStore(tempConfigDir).replace([]);
    const { builds, factory } = makeFactory();
    const registry = makeRegistry(factory);

    await registry.runTurn("s1", "one", baseConfig);

    // Tier mode must NOT be activated: `routingTiers !== undefined` hijacks
    // every legacy raw model code into tier resolution.
    expect(builds[0]).not.toHaveProperty("routingTiers");
    expect(builds[0]).not.toHaveProperty("resolveSubagentModelPort");
  });
});

describe("createWiredAgent tier forwarding", () => {
  it("forwards routingTiers and resolveSubagentModelPort verbatim to createAgent", async () => {
    const factory = async () => null;

    const agent = await createWiredAgent({
      modelPort: IDLE_PORT,
      routingTiers: [ECONOMY],
      resolveSubagentModelPort: factory,
    });

    const opts = vi.mocked(createAgent).mock.calls.at(-1)![0]!;
    expect(opts.routingTiers).toEqual([ECONOMY]);
    expect(opts.resolveSubagentModelPort).toBe(factory);
    await agent.dispose();
  });

  it("omits both keys when the caller supplies none", async () => {
    const agent = await createWiredAgent({ modelPort: IDLE_PORT });

    const opts = vi.mocked(createAgent).mock.calls.at(-1)![0]!;
    expect(opts).not.toHaveProperty("routingTiers");
    expect(opts).not.toHaveProperty("resolveSubagentModelPort");
    await agent.dispose();
  });
});
