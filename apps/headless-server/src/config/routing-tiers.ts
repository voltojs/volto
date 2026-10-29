/**
 * Routing tier registry — the model routing table sub-agent dispatches
 * resolve tier ids against. Persisted as `~/.volto/routing-tiers.json`.
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
import type { AgentEntry, AgentSpec } from "@volto/sdk";
import { scanAgentEntries } from "../agents/routes.js";
import { ensureConfigDir, getConfigDir, getConfigPath } from "./paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./io.js";

export interface RoutingTierRecord {
  id: string;
  label: string;
  description: string;
  target: { providerId: string; modelId: string };
}

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
    if (typeof id !== "string" || id.length === 0) {
      throw new RoutingTierValidationError(
        `routing tier at index ${index} must have a non-empty id`,
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
    const target = fields["target"];
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
        `routing tier "${id}" must have a target with string providerId and modelId`,
      );
    }
    return { id, label, description, target: { providerId, modelId } };
  });
}

export function createRoutingTierStore(dir: string = getConfigDir()): {
  list(): Promise<RoutingTierRecord[]>;
  replace(tiers: RoutingTierRecord[]): Promise<void>;
} {
  const file = getConfigPath("routing-tiers.json", dir);

  return {
    // A missing file means "no tiers configured yet" (the caller omits
    // routingTiers); a present-but-corrupt file throws instead — see
    // config/io.ts.
    list(): Promise<RoutingTierRecord[]> {
      return readJsonFile<RoutingTierRecord[]>(file, []);
    },

    async replace(tiers: RoutingTierRecord[]): Promise<void> {
      // Id non-empty + unique, before anything touches disk — a rejected
      // replace must never half-write the table.
      validateTierRecords(tiers);
      await ensureConfigDir(dir);
      await writeJsonFileAtomic(file, tiers);
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
  homeDir: string;
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
    homeDir: ctx.homeDir,
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
        homeDir: ctx.homeDir,
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
