/**
 * The permission presets offered to clients.
 *
 * A preset is nothing but a bundle of core's two orthogonal knobs — the
 * sandbox boundary and the approval policy. Core knows nothing about presets;
 * this table is the whole of the concept, and the same sandbox value also
 * drives the shell and filesystem decorators in wiring.ts, so the permission
 * decision and the enforced boundary come from one source of truth.
 */

import type { ApprovalPolicy, PermissionConfig, SandboxMode } from "@volto/core";

export type UiPermissionMode = "read-only" | "ask" | "auto" | "full";

/** In escalating order — a client renders the picker in this order. */
export const UI_PERMISSION_MODES: readonly UiPermissionMode[] = [
  "read-only",
  "ask",
  "auto",
  "full",
];

const PRESETS: Record<UiPermissionMode, { sandbox: SandboxMode; approval: ApprovalPolicy }> = {
  "read-only": { sandbox: "read-only", approval: "never" },
  ask: { sandbox: "workspace-write", approval: "ask" },
  auto: { sandbox: "workspace-write", approval: "never" },
  full: { sandbox: "danger-full-access", approval: "never" },
};

/**
 * Retired preset names, still readable from persisted transcripts. Accepted
 * only on the read path — `isUiPermissionMode` rejects them, so a client
 * cannot ask for one.
 */
const LEGACY_ALIASES: Record<string, UiPermissionMode> = {
  plan: "read-only",
  "auto-accept": "auto",
};

/** The preset a session gets when nothing else is known. */
const DEFAULT_MODE: UiPermissionMode = "ask";

export function isUiPermissionMode(value: unknown): value is UiPermissionMode {
  return typeof value === "string" && (UI_PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Coerce a persisted or otherwise untrusted value into a preset. Retired
 * names migrate to their equivalent; anything unrecognised falls back to the
 * default rather than to the widest tier.
 */
export function normaliseUiPermissionMode(value: unknown): UiPermissionMode {
  if (isUiPermissionMode(value)) return value;
  if (typeof value === "string" && Object.hasOwn(LEGACY_ALIASES, value)) {
    return LEGACY_ALIASES[value];
  }
  return DEFAULT_MODE;
}

export function buildPermissionConfig(mode: UiPermissionMode): PermissionConfig {
  return { ...PRESETS[mode] };
}

/** The sandbox knob a preset bundles — what wiring.ts hands the decorators. */
export function sandboxModeFor(mode: UiPermissionMode): SandboxMode {
  return PRESETS[mode].sandbox;
}
