/**
 * Layered configuration — 全局 < 项目 < 运行时，纯合并 + 来源标注。
 *
 * 三层配置源按确定优先级深合并，产出带来源标注的 ResolvedConfig。
 * mergeConfig 是纯函数（无 I/O），可快照测试；读取（I/O）在 SDK / runtime 层。
 */

import type {
  PermissionConfig,
  CompactionConfig,
  JSONSchema,
  ToolScopeConfig,
  ToolSource,
} from "@volto/core";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Configuration source identifier for tracing provenance */
export type ConfigSource = "global" | "project" | "runtime";

/**
 * Single-layer configuration shape.
 * All fields are optional — an empty layer contributes nothing.
 * This mirrors the subset of CreateAgentOptions that can be configured
 * via config files (ports / adapters are runtime-only by design).
 */
export interface ConfigLayer {
  /** System prompt */
  systemPrompt?: string;

  /** Model name override */
  model?: string;

  /** Max tokens per model call */
  maxTokens?: number;

  /** Temperature */
  temperature?: number;

  /** Max inner-loop iterations */
  maxIterations?: number;

  /** Token budget per turn */
  tokenBudget?: number;

  /** Max tool calls per turn */
  maxToolCalls?: number;

  /** @deprecated Use maxDollarsPerTurn or maxTokensPerTurn */
  maxCostTokens?: number;

  /** Max raw token count per turn (input + output) */
  maxTokensPerTurn?: number;

  /** Max dollar cost per turn (requires pricing) */
  maxDollarsPerTurn?: number;

  /** Max wallclock milliseconds per turn */
  maxWallclockMs?: number;

  /** Max consecutive identical failed tool calls */
  maxLoopCount?: number;

  /** Permission policy */
  permissionConfig?: PermissionConfig;

  /** Compaction config (without tokenizer — tokenizer is runtime-injected) */
  compaction?: Omit<CompactionConfig, "tokenizer">;

  /** Tool visibility trimming */
  toolVisibility?: {
    scope?: ToolScopeConfig;
    limit?: number;
  };

  /**
   * Tool sources to register.
   * Array merge strategy: default concat+dedup by tool name; can declare replace.
   */
  toolSources?: ToolSource[];

  /** Available capabilities */
  capabilities?: string[];

  /** Enable the task sub-agent tool */
  enableTaskTool?: boolean;

  /** Reasoning strategy */
  reasoningStrategy?: "emit" | "record" | "meter-only";

  /** Response format */
  responseFormat?: { type: "json"; schema?: JSONSchema };

  /**
   * Plugins to register (names only — actual plugin objects are runtime-injected).
   * Layer merging: concat+dedup by name; replace if declared.
   */
  pluginNames?: string[];
}

/** Metadata about which source provided each resolved field */
export type ResolvedFrom = Record<string, ConfigSource>;

/**
 * Fully resolved configuration after merging all layers.
 * Includes provenance metadata so callers can trace each field's origin.
 */
export interface ResolvedConfig {
  /** The merged config values */
  config: ConfigLayer;

  /** For each top-level key, which source provided the winning value */
  resolvedFrom: ResolvedFrom;
}

// ──────────────────────────────────────────────
// Merge strategies
// ──────────────────────────────────────────────

/** How to merge a specific array field */
export type ArrayMergeStrategy = "concat" | "replace";

/**
 * Per-field merge overrides.
 * Keys are config field names; values specify the merge strategy for arrays.
 * Scalar fields always use last-writer-wins.
 */
export interface MergeStrategy {
  /** Override merge strategy for specific array fields */
  arrayFields?: Record<string, ArrayMergeStrategy>;
}

// ──────────────────────────────────────────────
// Pure merge function
// ──────────────────────────────────────────────

/** Top-level config keys that can carry values */
const LAYER_KEYS = [
  "systemPrompt",
  "model",
  "maxTokens",
  "temperature",
  "maxIterations",
  "tokenBudget",
  "maxToolCalls",
  "maxCostTokens",
  "maxTokensPerTurn",
  "maxDollarsPerTurn",
  "maxWallclockMs",
  "maxLoopCount",
  "permissionConfig",
  "compaction",
  "toolVisibility",
  "toolSources",
  "capabilities",
  "enableTaskTool",
  "reasoningStrategy",
  "responseFormat",
  "pluginNames",
] as const;

/**
 * Merge two deep objects, with the latter overriding the former for scalars.
 * Arrays are merged according to the strategy map (default: concat + dedup by
 * identity for primitives, by JSON serialization for objects).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  arrayStrategies: Record<string, ArrayMergeStrategy>,
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;

    const tgtVal = result[key];

    if (Array.isArray(srcVal)) {
      const strategy = arrayStrategies[key] ?? "concat";
      if (strategy === "replace" || !Array.isArray(tgtVal)) {
        result[key] = srcVal;
      } else {
        // concat + dedup
        const seen = new Set<string>();
        const merged: unknown[] = [];
        for (const item of [...tgtVal, ...srcVal]) {
          const k = typeof item === "object" && item !== null ? JSON.stringify(item) : String(item);
          if (!seen.has(k)) {
            seen.add(k);
            merged.push(item);
          }
        }
        result[key] = merged;
      }
    } else if (
      typeof srcVal === "object" &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
        arrayStrategies,
      );
    } else {
      result[key] = srcVal;
    }
  }

  return result;
}

/**
 * Pure function: merge three config layers in priority order (global < project < runtime).
 *
 * - Last-writer-wins for scalars and objects
 * - Arrays: default concat+dedup, per-field override via strategy
 * - Every winning field is annotated with its source in resolvedFrom
 *
 * @returns ResolvedConfig with merged values and provenance metadata
 */
export function mergeConfig(
  global?: ConfigLayer,
  project?: ConfigLayer,
  runtime?: ConfigLayer,
  strategy?: MergeStrategy,
): ResolvedConfig {
  const arrayStrategies = strategy?.arrayFields ?? {};
  const sources: Array<[ConfigLayer | undefined, ConfigSource]> = [
    [global, "global"],
    [project, "project"],
    [runtime, "runtime"],
  ];

  const merged: Record<string, unknown> = {};
  const resolvedFrom: ResolvedFrom = {};

  for (const [layer, source] of sources) {
    if (!layer) continue;

    for (const key of LAYER_KEYS) {
      const val = (layer as Record<string, unknown>)[key];
      if (val === undefined) continue;

      const prevVal = merged[key];
      const arrayStrategy = arrayStrategies[key];

      if (Array.isArray(val)) {
        if (arrayStrategy === "replace" || !Array.isArray(prevVal)) {
          merged[key] = val;
          resolvedFrom[key] = source;
        } else {
          // concat + dedup
          const seen = new Set<string>();
          const tgtArr = prevVal as unknown[];
          const mergedArr: unknown[] = [];
          for (const item of [...tgtArr, ...val]) {
            const k = typeof item === "object" && item !== null ? JSON.stringify(item) : String(item);
            if (!seen.has(k)) {
              seen.add(k);
              mergedArr.push(item);
            }
          }
          merged[key] = mergedArr;
          // resolvedFrom stays at first source that introduced this key
          if (!resolvedFrom[key]) resolvedFrom[key] = source;
        }
      } else if (
        typeof val === "object" &&
        val !== null &&
        typeof prevVal === "object" &&
        prevVal !== null &&
        !Array.isArray(prevVal)
      ) {
        merged[key] = deepMerge(
          prevVal as Record<string, unknown>,
          val as Record<string, unknown>,
          arrayStrategies,
        );
        // resolvedFrom: first source that set this key, but nested fields may differ
        // For simplicity at top level, track the latest source that touched this object
        resolvedFrom[key] = source;
      } else {
        merged[key] = val;
        resolvedFrom[key] = source;
      }
    }
  }

  return {
    config: merged as ConfigLayer,
    resolvedFrom,
  };
}
