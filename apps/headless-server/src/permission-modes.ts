/**
 * Permission tiers offered to the web client.
 *
 * Only two tiers are exposed, and neither of them can produce an "ask"
 * decision — the gateway has no approval UI yet, and its auto-allow gate
 * would wave any "ask" through without the user ever seeing it.
 */

import type { PermissionConfig } from "@volto/core";

export type UiPermissionMode = "plan" | "auto-accept";

export const UI_PERMISSION_MODES: readonly UiPermissionMode[] = ["plan", "auto-accept"];

export function isUiPermissionMode(value: unknown): value is UiPermissionMode {
  return typeof value === "string" && (UI_PERMISSION_MODES as readonly string[]).includes(value);
}

export function buildPermissionConfig(mode: UiPermissionMode): PermissionConfig {
  if (mode === "plan") {
    // `mode` outranks `defaults` in core's resolution order, so these values
    // are a conservative fallback; core's plan mode drives the real decision.
    return {
      defaults: {
        READ_ONLY: "allow",
        WRITE_LOW: "deny",
        WRITE_HIGH: "deny",
        IRREVERSIBLE: "deny",
      },
      mode: "plan",
    };
  }

  // Deliberately no `mode` field. Core's "auto-accept" mode maps IRREVERSIBLE
  // to "ask"; combined with the auto-allow gate that silently permits
  // irreversible operations. Expressing the tier through tier defaults keeps
  // IRREVERSIBLE a hard deny. Do not "helpfully" add mode: "auto-accept" here.
  return {
    defaults: {
      READ_ONLY: "allow",
      WRITE_LOW: "allow",
      WRITE_HIGH: "allow",
      IRREVERSIBLE: "deny",
    },
  };
}
