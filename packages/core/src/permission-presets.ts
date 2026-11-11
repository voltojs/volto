/**
 * Permission presets — the named bundles clients and dispatchers share.
 *
 * A preset is nothing but a bundle of core's two orthogonal knobs, the sandbox
 * boundary and the approval policy. Core knows nothing about "modes" as a
 * product concept; this table IS the whole of that concept, and it lives here
 * because `PermissionConfig` and `narrowPermission` do: the gateway, the SDK
 * and the web all need the same vocabulary, and a second copy would be a
 * second truth.
 *
 * Pure data and pure functions only — no I/O, no clock.
 */

import type { ApprovalPolicy, PermissionConfig, SandboxMode } from "./permission-policy.js";
import { ceilingOf, narrowPermission, riskRank } from "./permission-policy.js";

export type PermissionPreset = "read-only" | "plan" | "ask" | "auto" | "full";

/** In escalating order — a picker renders them in this order. */
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  "read-only",
  "plan",
  "ask",
  "auto",
  "full",
];

const PRESETS: Record<PermissionPreset, { sandbox: SandboxMode; approval: ApprovalPolicy }> = {
  "read-only": { sandbox: "read-only", approval: "never" },
  // Same boundary as read-only: the only write a plan-mode session makes is
  // the plan document itself, which lives in volto's own storage rather than
  // the workspace.
  plan: { sandbox: "read-only", approval: "never" },
  ask: { sandbox: "workspace-write", approval: "ask" },
  auto: { sandbox: "workspace-write", approval: "never" },
  full: { sandbox: "danger-full-access", approval: "never" },
};

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === "string" && (PERMISSION_PRESETS as readonly string[]).includes(value);
}

/** The config a preset stands for. Always a fresh object — never an alias. */
export function permissionConfigOf(preset: PermissionPreset): PermissionConfig {
  return { ...PRESETS[preset] };
}

/**
 * The preset a config is identical to, or undefined when no preset expresses
 * it (e.g. danger-full-access + ask). Callers that need a label must fall back
 * to rendering the raw config rather than picking a near neighbour.
 *
 * `plan` and `read-only` share one config, so a round trip through this
 * function yields the FIRST of them ("read-only"). That is deliberate: the
 * config cannot carry the difference (a plan-mode session differs by what it
 * is doing, not by its boundary), so pretending otherwise would be a lie.
 */
export function presetOf(config: PermissionConfig): PermissionPreset | undefined {
  return PERMISSION_PRESETS.find((preset) => {
    const candidate = PRESETS[preset];
    return candidate.sandbox === config.sandbox && candidate.approval === config.approval;
  });
}

/**
 * Whether dispatching at `preset` would exceed `parent`'s sandbox boundary.
 * Only the sandbox axis counts: an approval of `ask` is STRICTER for a
 * sub-agent (its gate refuses every prompt), and `narrowPermission` collapses
 * the pair to the parent's value anyway, so it can never widen anything.
 */
export function isWiderThan(preset: PermissionPreset, parent: PermissionConfig): boolean {
  // Compare RANKS, not tier names: `ceilingOf` returns labels whose
  // lexicographic order happens to disagree with risk order.
  return riskRank(ceilingOf(PRESETS[preset].sandbox)) > riskRank(ceilingOf(parent.sandbox));
}

/** The presets a parent may dispatch — never wider than its own boundary. */
export function allowedPresetsFor(parent: PermissionConfig): PermissionPreset[] {
  return PERMISSION_PRESETS.filter((preset) => !isWiderThan(preset, parent));
}

/**
 * Collapse a dispatch request into the parent's boundary. Shared by both
 * dispatch faces; the caller decides what a violation MEANS — the model-facing
 * one rejects it up front (so the model can self-correct), the author-facing
 * one just lets this narrow it.
 */
export function narrowToParent(
  parent: PermissionConfig,
  requested?: PermissionPreset,
): { config: PermissionConfig; requestedPreset?: PermissionPreset } {
  if (requested === undefined) return { config: { ...parent } };
  const wanted = permissionConfigOf(requested);
  // Same boundary as the parent: return the parent untouched. Running it
  // through `narrowPermission` would rebuild the config from the preset and
  // silently drop the parent's own `rules`, so "asked for the preset it
  // already has" would behave differently from "asked for nothing".
  if (wanted.sandbox === parent.sandbox && wanted.approval === parent.approval) {
    return { config: { ...parent }, requestedPreset: requested };
  }
  return {
    config: narrowPermission(parent, wanted),
    requestedPreset: requested,
  };
}