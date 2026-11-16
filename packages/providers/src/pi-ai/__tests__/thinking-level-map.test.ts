import { describe, expect, it, vi } from "vitest";
import type { ModelThinkingLevelInfo, ReasoningEffortId } from "@voltojs/core";
import { buildModels, describeModelInfo, type PiAiProviderConfig } from "../collection.js";
import { createPiAiModelPortFromModels } from "../model-port.js";
import { THINKING_LEVELS } from "../index.js";

type LevelId = (typeof THINKING_LEVELS)[number];
type LevelMap = Partial<Record<LevelId, ModelThinkingLevelInfo>>;

/** Index describeModelInfo's `levels` by id for terse assertions. */
function levelMap(info: ReturnType<typeof describeModelInfo>): LevelMap {
  const out: LevelMap = {};
  for (const level of info.reasoning?.levels ?? []) {
    out[level.id as LevelId] = level;
  }
  return out;
}

function effortIds(info: ReturnType<typeof describeModelInfo>): string[] {
  return (info.reasoning?.efforts ?? []).map((e) => e.id as string);
}

function catalogConfig(overrides: Partial<Extract<PiAiProviderConfig, { kind: "catalog" }>> = {}): PiAiProviderConfig {
  return {
    kind: "catalog",
    id: "my-deepseek",
    piProvider: "deepseek",
    apiKey: "ds-key",
    modelCodes: ["deepseek-flash"],
    ...overrides,
  };
}

describe("THINKING_LEVELS export", () => {
  it("is the seven-level order including off", () => {
    expect(THINKING_LEVELS).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("catalog provider: thinkingLevelMapOverrides merge", () => {
  // deepseek-flash's catalog map is { minimal: null, low: "low", medium: null,
  // high: "high", max: "max" }. Merging { low: "custom", xhigh: "xc" } must
  // produce a report where the override decides low/xhigh and everything
  // else keeps the catalog's own answer.
  it("reports merged effective levels with per-level overridden flags", () => {
    const models = buildModels([
      catalogConfig({
        thinkingLevelMapOverrides: {
          "deepseek-flash": { low: "custom", xhigh: "xc" },
        },
      }),
    ]);

    const info = describeModelInfo(models, "deepseek", "deepseek-flash");
    const levels = levelMap(info);

    expect(info.reasoning?.levels?.length).toBe(7);

    expect(levels.low).toMatchObject({ supported: true, value: "custom", overridden: true });
    expect(levels.xhigh).toMatchObject({ supported: true, value: "xc", overridden: true });
    // Inherited from the catalog map: supported, catalog value, not overridden.
    expect(levels.high).toMatchObject({ supported: true, value: "high", overridden: false });
    expect(levels.max).toMatchObject({ supported: true, value: "max", overridden: false });
    // Catalog nulls survive the merge: unsupported, decided by the catalog.
    expect(levels.minimal).toMatchObject({ supported: false, overridden: false });
    expect(levels.medium).toMatchObject({ supported: false, overridden: false });
    // No explicit off value anywhere: supported (default), no reported value.
    expect(levels.off).toMatchObject({ supported: true, overridden: false });
    expect(levels.off?.value).toBeUndefined();

    // efforts stay non-"off" supported levels only.
    expect(effortIds(info)).toEqual(["low", "high", "xhigh", "max"]);
  });

  it("an override to null marks the level unsupported and removes it from efforts", () => {
    const models = buildModels([
      catalogConfig({
        thinkingLevelMapOverrides: {
          "deepseek-flash": { medium: null },
        },
      }),
    ]);

    const info = describeModelInfo(models, "deepseek", "deepseek-flash");
    const levels = levelMap(info);

    expect(levels.medium).toMatchObject({ supported: false, overridden: true });
    expect(effortIds(info)).not.toContain("medium");
  });

  it("an override to off:null reports off unsupported", () => {
    const models = buildModels([
      catalogConfig({
        thinkingLevelMapOverrides: {
          "deepseek-flash": { off: null },
        },
      }),
    ]);

    const levels = levelMap(describeModelInfo(models, "deepseek", "deepseek-flash"));
    expect(levels.off).toMatchObject({ supported: false, overridden: true });
    expect(levels.off?.value).toBeUndefined();
  });

  it("an explicit string value for off is reported as the effective value", () => {
    const models = buildModels([
      catalogConfig({
        thinkingLevelMapOverrides: {
          "deepseek-flash": { off: "none" },
        },
      }),
    ]);

    const levels = levelMap(describeModelInfo(models, "deepseek", "deepseek-flash"));
    expect(levels.off).toMatchObject({ supported: true, value: "none", overridden: true });
  });

  it("reasoningOverrides false + a map override keeps efforts empty (current behavior)", () => {
    // Review focus 2: forcing the model non-reasoning wins over any map;
    // describeModelInfo publishes no reasoning block at all.
    const models = buildModels([
      catalogConfig({
        reasoningOverrides: { "deepseek-flash": false },
        thinkingLevelMapOverrides: {
          "deepseek-flash": { low: "custom", xhigh: "xc" },
        },
      }),
    ]);

    const info = describeModelInfo(models, "deepseek", "deepseek-flash");
    expect(info.reasoning).toBeUndefined();
  });

  it("the merged map lands on Model.thinkingLevelMap so validation sees it", () => {
    const models = buildModels([
      catalogConfig({
        thinkingLevelMapOverrides: {
          "deepseek-flash": { low: "custom", xhigh: "xc" },
        },
      }),
    ]);

    const wire = models.getModel("deepseek", "deepseek-flash")?.thinkingLevelMap;
    expect(wire).toMatchObject({ low: "custom", xhigh: "xc", high: "high", minimal: null });
  });
});

describe("custom provider: per-model thinkingLevelMap", () => {
  it("applies the declared map and falls back to the level id without one", () => {
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [{ code: "m", reasoning: true, thinkingLevelMap: { high: "h8" } }],
      },
    ]);

    const info = describeModelInfo(models, "gw", "m");
    const levels = levelMap(info);

    expect(levels.high).toMatchObject({ supported: true, value: "h8", overridden: true });
    // No entry for low: default-supported, effective value is the id itself.
    expect(levels.low).toMatchObject({ supported: true, value: "low", overridden: false });
    expect(levels.medium).toMatchObject({ supported: true, value: "medium", overridden: false });
    // xhigh/max have no default support and no declaration here.
    expect(levels.xhigh).toMatchObject({ supported: false, overridden: false });
    expect(levels.max).toMatchObject({ supported: false, overridden: false });
    expect(effortIds(info)).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("a custom map can enable xhigh/max or disable defaults", () => {
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [
          {
            code: "m",
            reasoning: true,
            thinkingLevelMap: { minimal: null, xhigh: "x-high" },
          },
        ],
      },
    ]);

    const info = describeModelInfo(models, "gw", "m");
    const levels = levelMap(info);

    expect(levels.minimal).toMatchObject({ supported: false, overridden: true });
    expect(levels.xhigh).toMatchObject({ supported: true, value: "x-high", overridden: true });
    expect(effortIds(info)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("pins the full levels payload for a custom model with no map at all", () => {
    // The levels array is new visible payload on GET /providers (the gateway
    // inlines info.reasoning wholesale) — intentional per spec, so pin its
    // exact content for the default case: non-off levels fall back to their
    // id as the effective wire value, off reports none, nothing overridden.
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [{ code: "m", reasoning: true }],
      },
    ]);

    expect(describeModelInfo(models, "gw", "m").reasoning?.levels).toEqual([
      { id: "off", supported: true, overridden: false },
      { id: "minimal", supported: true, value: "minimal", overridden: false },
      { id: "low", supported: true, value: "low", overridden: false },
      { id: "medium", supported: true, value: "medium", overridden: false },
      { id: "high", supported: true, value: "high", overridden: false },
      { id: "xhigh", supported: false, overridden: false },
      { id: "max", supported: false, overridden: false },
    ]);
  });

  it("without a map the behavior is byte-identical to before this feature", () => {
    // Regression: no levels array pressure on existing fields — efforts,
    // wire model shape and baseUrl normalization stay exactly as they were.
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [{ code: "m", reasoning: true }],
      },
    ]);

    const info = describeModelInfo(models, "gw", "m");
    expect(effortIds(info)).toEqual(["minimal", "low", "medium", "high"]);
    const wire = models.getModel("gw", "m");
    expect(wire?.thinkingLevelMap).toBeUndefined();
    expect(wire?.baseUrl).toBe("https://gateway.example/v1");
  });
});

describe("unknown catalog code synthesized from a map override alone", () => {
  it("describeModelInfo resolves and streamSimple effort validation passes", async () => {
    // Review focus 1: previously an unknown code was only materialized when
    // the user forced reasoning or declared input; a stored map override is
    // just as much intent and must keep the code resolvable.
    const providers: PiAiProviderConfig[] = [
      catalogConfig({
        modelCodes: ["brand-new-x"],
        thinkingLevelMapOverrides: { "brand-new-x": { xhigh: "xc" } },
      }),
    ];
    const models = buildModels(providers);

    const info = describeModelInfo(models, "deepseek", "brand-new-x");
    const levels = levelMap(info);
    // Template inheritance: deepseek-flash's map (low/high/max usable) plus
    // the override enabling xhigh.
    expect(levels.low).toMatchObject({ supported: true, value: "low", overridden: false });
    expect(levels.xhigh).toMatchObject({ supported: true, value: "xc", overridden: true });
    expect(effortIds(info)).toContain("xhigh");

    // model-port's Step 2 validates `reasoningEffort` against exactly this
    // efforts list before any I/O; with the code absent from the collection
    // the request would fail at model resolution instead ("unable to
    // resolve model"). So passing validation here is what Review Focus 1
    // requires of the synthesis trigger.
    expect(effortIds(info)).toContain("low");
    expect(effortIds(info)).not.toContain("minimal");
  });
});

describe("streamSimple path unchanged", () => {
  it("still forwards reasoning as the level id verbatim", async () => {
    const models = buildModels([
      catalogConfig({
        thinkingLevelMapOverrides: { "deepseek-flash": { low: "custom" } },
      }),
    ]);

    const streamSimpleSpy = vi.spyOn(models, "streamSimple").mockReturnValue({
      async *[Symbol.asyncIterator]() {
        // empty stream: drain without I/O.
      },
    } as never);

    const port = createPiAiModelPortFromModels(models, "deepseek", undefined, "ds-key");
    const events = port.stream({
      model: "deepseek-flash",
      messages: [],
      tools: [],
      reasoningEffort: "low" as ReasoningEffortId,
    });
    for await (const _event of events) {
      // drain
    }

    expect(streamSimpleSpy).toHaveBeenCalledTimes(1);
    const options = streamSimpleSpy.mock.calls[0]![2]!;
    // Task 2 does not change the request behavior: the level id goes on the
    // wire, not the mapped API value ("custom").
    expect(options).toMatchObject({ reasoning: "low" });
  });
});
