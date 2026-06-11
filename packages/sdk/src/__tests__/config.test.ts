import { describe, it, expect } from "vitest";
import { mergeConfig, type ConfigLayer, type MergeStrategy } from "../config.js";

describe("mergeConfig", () => {
  it("returns empty config when no layers provided", () => {
    const result = mergeConfig();
    expect(result.config).toEqual({});
    expect(result.resolvedFrom).toEqual({});
  });

  it("global only — global values win", () => {
    const global: ConfigLayer = { model: "gpt-4", maxTokens: 1024 };
    const result = mergeConfig(global);
    expect(result.config.model).toBe("gpt-4");
    expect(result.config.maxTokens).toBe(1024);
    expect(result.resolvedFrom.model).toBe("global");
    expect(result.resolvedFrom.maxTokens).toBe("global");
  });

  it("project overrides global for scalars", () => {
    const global: ConfigLayer = { model: "gpt-4", maxTokens: 1024 };
    const project: ConfigLayer = { model: "gpt-4o" };
    const result = mergeConfig(global, project);
    expect(result.config.model).toBe("gpt-4o");
    expect(result.config.maxTokens).toBe(1024);
    expect(result.resolvedFrom.model).toBe("project");
    expect(result.resolvedFrom.maxTokens).toBe("global");
  });

  it("runtime overrides project overrides global", () => {
    const global: ConfigLayer = { model: "gpt-4", maxTokens: 1024, temperature: 0.5 };
    const project: ConfigLayer = { model: "gpt-4o", temperature: 0.7 };
    const runtime: ConfigLayer = { model: "gpt-4o-mini" };
    const result = mergeConfig(global, project, runtime);
    expect(result.config.model).toBe("gpt-4o-mini");
    expect(result.config.maxTokens).toBe(1024);
    expect(result.config.temperature).toBe(0.7);
    expect(result.resolvedFrom.model).toBe("runtime");
    expect(result.resolvedFrom.maxTokens).toBe("global");
    expect(result.resolvedFrom.temperature).toBe("project");
  });

  it("missing layers are skipped gracefully", () => {
    const project: ConfigLayer = { model: "gpt-4o" };
    const result = mergeConfig(undefined, project, undefined);
    expect(result.config.model).toBe("gpt-4o");
    expect(result.resolvedFrom.model).toBe("project");
  });

  it("arrays default to concat+dedup", () => {
    const global: ConfigLayer = { capabilities: ["fs", "shell"] };
    const project: ConfigLayer = { capabilities: ["shell", "network"] };
    const result = mergeConfig(global, project);
    expect(result.config.capabilities).toEqual(["fs", "shell", "network"]);
  });

  it("array replace strategy", () => {
    const global: ConfigLayer = { capabilities: ["fs", "shell"] };
    const project: ConfigLayer = { capabilities: ["network"] };
    const strategy: MergeStrategy = { arrayFields: { capabilities: "replace" } };
    const result = mergeConfig(global, project, undefined, strategy);
    expect(result.config.capabilities).toEqual(["network"]);
  });

  it("deep-merges nested objects", () => {
    const global: ConfigLayer = {
      toolVisibility: { limit: 10 },
    };
    const project: ConfigLayer = {
      toolVisibility: { scope: { groups: { core: { priority: 5 } } } },
    };
    const result = mergeConfig(global, project);
    expect(result.config.toolVisibility).toEqual({
      limit: 10,
      scope: { groups: { core: { priority: 5 } } },
    });
    expect(result.resolvedFrom.toolVisibility).toBe("project");
  });

  it("runtime overrides nested object fields", () => {
    const global: ConfigLayer = {
      toolVisibility: { limit: 10, scope: { groups: { all: {} } } },
    };
    const runtime: ConfigLayer = {
      toolVisibility: { limit: 5 },
    };
    const result = mergeConfig(global, undefined, runtime);
    expect(result.config.toolVisibility).toEqual({ limit: 5, scope: { groups: { all: {} } } });
  });

  it("pure function — same inputs produce same output", () => {
    const global: ConfigLayer = { model: "gpt-4", capabilities: ["fs"] };
    const project: ConfigLayer = { maxTokens: 2048 };
    const r1 = mergeConfig(global, project);
    const r2 = mergeConfig(global, project);
    expect(r1).toEqual(r2);
  });

  it("snapshot test — merged config matches snapshot", () => {
    const global: ConfigLayer = {
      model: "gpt-4",
      maxTokens: 1024,
      temperature: 0.5,
      capabilities: ["fs", "shell"],
      toolVisibility: { limit: 10 },
    };
    const project: ConfigLayer = {
      model: "gpt-4o",
      capabilities: ["shell", "network"],
      toolVisibility: { scope: { groups: { core: { priority: 5 } } } },
      enableTaskTool: true,
    };
    const runtime: ConfigLayer = {
      temperature: 0.8,
      systemPrompt: "You are helpful.",
    };
    const result = mergeConfig(global, project, runtime);
    expect(result).toMatchInlineSnapshot(`
      {
        "config": {
          "capabilities": [
            "fs",
            "shell",
            "network",
          ],
          "enableTaskTool": true,
          "maxTokens": 1024,
          "model": "gpt-4o",
          "systemPrompt": "You are helpful.",
          "temperature": 0.8,
          "toolVisibility": {
            "limit": 10,
            "scope": {
              "groups": {
                "core": {
                  "priority": 5,
                },
              },
            },
          },
        },
        "resolvedFrom": {
          "capabilities": "global",
          "enableTaskTool": "project",
          "maxTokens": "global",
          "model": "project",
          "systemPrompt": "runtime",
          "temperature": "runtime",
          "toolVisibility": "project",
        },
      }
    `);
  });
});
