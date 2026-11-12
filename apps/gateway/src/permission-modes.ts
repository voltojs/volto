/**
 * The permission presets offered to clients.
 *
 * The vocabulary and the preset table live in `@volto/core` (spec 2026-11-11
 * D1): the SDK dispatches sub-agents by the same names the UI shows, and two
 * copies of "what does `read-only` mean" would be two truths. This module is
 * the gateway's thin face over it — the names below are the ones the server's
 * routes, sessions and wiring already speak.
 */

import {
  PERMISSION_PRESETS,
  isPermissionPreset,
  permissionConfigOf,
  type PermissionPreset,
} from "@volto/core";
import type { PermissionConfig, SandboxMode } from "@volto/core";

export type UiPermissionMode = PermissionPreset;

/** In escalating order — a client renders the picker in this order. */
export const UI_PERMISSION_MODES: readonly UiPermissionMode[] = PERMISSION_PRESETS;

/**
 * Retired preset names, still readable from persisted transcripts. Accepted
 * only on the read path — `isUiPermissionMode` rejects them, so a client
 * cannot ask for one. ("plan" used to live here as an alias for "read-only";
 * it is a first-class preset now, so persisted "plan" reads back as itself.)
 */
const LEGACY_ALIASES: Record<string, UiPermissionMode> = {
  "auto-accept": "auto",
};

/** The preset a session gets when nothing else is known. */
const DEFAULT_MODE: UiPermissionMode = "ask";

export function isUiPermissionMode(value: unknown): value is UiPermissionMode {
  return isPermissionPreset(value);
}

/**
 * Coerce a persisted or otherwise untrusted value into a preset. Retired
 * names migrate to their equivalent; anything unrecognised falls back to the
 * default rather than to the widest tier.
 */
export function normaliseUiPermissionMode(value: unknown): UiPermissionMode {
  if (isUiPermissionMode(value)) return value;
  if (typeof value === "string" && Object.hasOwn(LEGACY_ALIASES, value)) {
    // Object.hasOwn already proved `value` is an own key, so the lookup
    // cannot be undefined despite noUncheckedIndexedAccess.
    return LEGACY_ALIASES[value]!;
  }
  return DEFAULT_MODE;
}

export function buildPermissionConfig(mode: UiPermissionMode): PermissionConfig {
  return permissionConfigOf(mode);
}

/** The sandbox knob a preset bundles — what wiring.ts hands the decorators. */
export function sandboxModeFor(mode: UiPermissionMode): SandboxMode {
  return permissionConfigOf(mode).sandbox;
}