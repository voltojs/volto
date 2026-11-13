/**
 * Routing tier registry — the model routing table sub-agent dispatches
 * resolve tier ids against. Persisted in `~/.volto/config.json` under
 * `routingTiers`. Before the first write the table is the factory template
 * (`DEFAULT_TIER_TEMPLATES`), served unpersisted (spec v2 D7/D8).
 *
 * The store only owns persistence plus id validation. Two decisions live
 * outside it, at the call site that has the context for them:
 *
 * - Target resolvability — the HTTP route checks each `target` against the
 *   provider registry (`resolveModel`), because the store knows nothing
 *   about providers.
 * - Deletion safety — `collectTierReferences` scans agent definitions for
 *   tier ids that are about to disappear, so a delete that would strand a
 *   definition can answer 409 instead of silently breaking it.
 */

import * as fs from "node:fs/promises";
import type { AgentEntry, AgentSpec } from "@voltojs/sdk";
import { scanAgentEntries } from "../agents/routes.js";
import { getConfigDir } from "./paths.js";
import { getConfigStore } from "./store.js";
import { t, type Locale } from "@voltojs/sdk/i18n";

export interface RoutingTierRecord {
  id: string;
  label: string;
  description: string;
  /**
   * Dispatch target, or `null` for "unassigned" (spec v2 D7/D8) — a legal
   * state, not an error: such a tier degrades to the parent model at dispatch
   * time and skips the provider-registry lookup on submit.
   */
  target: { providerId: string; modelId: string } | null;
  /**
   * Optional reasoning effort carried on the tier. Its VALUE is never
   * validated here — the port layer's per-call gate owns that (spec D10).
   */
  reasoningEffort?: string;
}

/**
 * Factory presets the table starts from (spec v2 D7/D8): `list()` falls back
 * to them only while `routing-tiers.json` does not exist, so the routing UI
 * and the sub-agent dropdown have tiers to show before anyone configures
 * anything. They are never written to disk — the first `replace()` persists
 * the user's own table and the presets stop applying (a present file, even
 * an empty one, is returned verbatim). Every target is `null` (unassigned).
 */
export function defaultTierTemplates(locale: Locale): RoutingTierRecord[] {
  return [
    {
      id: "premium",
      label: t(locale, "server.routingTier.advanced.label"),
      description: t(locale, "server.routingTier.advanced.description"),
      target: null,
    },
    {
      id: "fast",
      label: t(locale, "server.routingTier.fast.label"),
      description: t(locale, "server.routingTier.fast.description"),
      target: null,
    },
    {
      id: "economy",
      label: t(locale, "server.routingTier.economy.label"),
      description: t(locale, "server.routingTier.economy.description"),
      target: null,
    },
  ];
}

/** Presets in the default locale, for callers with no request locale. */
export const DEFAULT_TIER_TEMPLATES: readonly RoutingTierRecord[] = defaultTierTemplates("zh");

/**
 * Sentinel the web agent form uses for "inherit the parent model"
 * (`MODEL_INHERIT_VALUE` in apps/web SubagentForm). A tier id colliding
 * with it would render that tier's option as the inherit choice and make
 * it permanently unselectable, so it is reserved out of the id space.
 */
const INHERIT_SENTINEL_ID = "__inherit__";

/** Validation failure carrying a client-safe message (the route answers 400). */
export class RoutingTierValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingTierValidationError";
  }
}

/**
 * Validates a submitted tier array and narrows it. Every failure names the
 * offending tier (its id, or its index before an id exists) so the client
 * can point at the row instead of guessing.
 */
export function validateTierRecords(input: unknown): RoutingTierRecord[] {
  if (!Array.isArray(input)) {
    throw new RoutingTierValidationError("routing tiers body must be an array of tier records");
  }
  const seen = new Set<string>();
  return input.map((record: unknown, index: number): RoutingTierRecord => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new RoutingTierValidationError(`routing tier at index ${index} must be an object`);
    }
    const fields = record as Record<string, unknown>;
    const id = fields["id"];
    // Whitespace-only ids are rejected together with empty ones — a blank
    // id can never be matched by a dispatch, yet `length === 0` let " " in.
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new RoutingTierValidationError(
        `routing tier at index ${index} must have a non-empty id (whitespace-only ids are rejected)`,
      );
    }
    if (id === INHERIT_SENTINEL_ID) {
      throw new RoutingTierValidationError(
        `routing tier at index ${index} must not use the reserved inherit sentinel id "${INHERIT_SENTINEL_ID}"`,
      );
    }
    if (seen.has(id)) {
      throw new RoutingTierValidationError(`duplicate routing tier id "${id}" (index ${index})`);
    }
    seen.add(id);
    const label = fields["label"];
    if (typeof label !== "string") {
      throw new RoutingTierValidationError(`routing tier "${id}" must have a string label`);
    }
    const description = fields["description"];
    if (typeof description !== "string") {
      throw new RoutingTierValidationError(
        `routing tier "${id}" must have a string description`,
      );
    }
    // `reasoningEffort` is opaque data: only its JSON shape is enforced here,
    // its value is not — the port layer's per-call gate owns that (spec D10).
    // `null` means "cleared" and is stored as absent.
    const reasoningEffort = fields["reasoningEffort"];
    if (
      reasoningEffort !== undefined &&
      reasoningEffort !== null &&
      typeof reasoningEffort !== "string"
    ) {
      throw new RoutingTierValidationError(
        `routing tier "${id}" reasoningEffort must be a string when provided`,
      );
    }
    const target = fields["target"];
    // `null` = "unassigned" (spec v2 D7/D8): a legal tier state with no model
    // to resolve, so the provider-registry lookup is skipped for it.
    if (target === null) {
      return {
        id,
        label,
        description,
        target: null,
        ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
      };
    }
    const providerId =
      typeof target === "object" && target !== null
        ? (target as Record<string, unknown>)["providerId"]
        : undefined;
    const modelId =
      typeof target === "object" && target !== null
        ? (target as Record<string, unknown>)["modelId"]
        : undefined;
    if (typeof providerId !== "string" || typeof modelId !== "string") {
      throw new RoutingTierValidationError(
        `routing tier "${id}" must have a target with string providerId and modelId, or null when unassigned`,
      );
    }
    return {
      id,
      label,
      description,
      target: { providerId, modelId },
      ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
    };
  });
}

export function createRoutingTierStore(dir: string = getConfigDir()): {
  list(locale?: Locale): Promise<RoutingTierRecord[]>;
  replace(tiers: RoutingTierRecord[]): Promise<void>;
} {
  const store = getConfigStore(dir);

  return {
    // A missing section is the first-run state: the factory template comes
    // back UNPERSISTED (spec v2 D7/D8) — reading never writes, so the first
    // `replace()` is what makes the table user-owned. A present section is
    // returned verbatim (even `[]`, so the template can never override user
    // data); a corrupt document throws instead — see config/store.ts.
    async list(locale: Locale = "zh"): Promise<RoutingTierRecord[]> {
      const stored = (await store.read())["routingTiers"] as
        | RoutingTierRecord[]
        | undefined;
      if (stored !== undefined) return stored;
      // Fresh copies so a caller mutating the result cannot poison the
      // presets for the next read.
      return defaultTierTemplates(locale);
    },

    async replace(tiers: RoutingTierRecord[]): Promise<void> {
      // Id non-empty + unique, before anything touches disk — a rejected
      // replace must never half-write the table.
      validateTierRecords(tiers);
      await store.update("routingTiers", () => tiers);
    },
  };
}

/** One agent definition whose `model:` names a tier being removed. */
export interface TierReference {
  name: string;
  scope: "project" | "user" | "plugin";
}

/** A registered project the scan could not read, with the reason it was skipped. */
export interface TierScanSkip {
  projectPath: string;
  reason: string;
}

export interface TierReferenceScan {
  references: TierReference[];
  skipped: TierScanSkip[];
}

/** Sources the reference scan walks. */
export interface TierScanContext {
  /** Every registered project root — one project-scope scan per root. */
  projectPaths: readonly string[];
  configDir: string;
  /** Plugin-provided specs; their hits are hints only and never block. */
  pluginSpecs?: AgentSpec[];
}

/**
 * Collects the agent definitions whose `model:` names one of `tierIds` —
 * the reference check a deletion has to pass before the tier disappears.
 *
 * Sources mirror the /agents scan exactly (same helper): each registered
 * project's project-scope definitions, the user domain, and the plugin
 * specs. A project root that vanished or cannot be read is reported in
 * `skipped` and left out of the decision rather than failing the scan, so
 * one dead entry cannot freeze the whole table.
 */
export async function collectTierReferences(
  tierIds: readonly string[],
  ctx: TierScanContext,
): Promise<TierReferenceScan> {
  const wanted = new Set(tierIds);
  const references: TierReference[] = [];
  const skipped: TierScanSkip[] = [];
  const seen = new Set<string>();

  const collect = (entry: AgentEntry): void => {
    const model = entry.spec.model;
    if (model === undefined || !wanted.has(model)) return;
    // Two same-named definitions in different projects cannot be told apart
    // on the wire (`{name, scope}` is all a reference carries), so they
    // collapse into one entry.
    const key = `${entry.scope}:${entry.spec.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ name: entry.spec.name, scope: entry.scope });
  };

  // User domain + plugin specs in one pass. `cwd` only selects the
  // project-scope directories and those entries are filtered out here — the
  // user and plugin sources are cwd-independent, so one pass covers them no
  // matter how many projects are registered.
  const shared = await scanAgentEntries({
    cwd: ctx.configDir,
    configDir: ctx.configDir,
    pluginSpecs: ctx.pluginSpecs ?? [],
  });
  for (const entry of shared) {
    if (entry.scope !== "project") collect(entry);
  }

  // Each registered project contributes its own project-scope definitions.
  for (const projectPath of ctx.projectPaths) {
    try {
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) {
        skipped.push({ projectPath, reason: "not a directory" });
        continue;
      }
    } catch (err) {
      skipped.push({ projectPath, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      const entries = await scanAgentEntries({
        cwd: projectPath,
        configDir: ctx.configDir,
        pluginSpecs: [],
      });
      for (const entry of entries) {
        if (entry.scope === "project") collect(entry);
      }
    } catch (err) {
      skipped.push({ projectPath, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { references, skipped };
}
