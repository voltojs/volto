/**
 * The model-facing description of the permission boundary in force.
 *
 * Without this the model learns the boundary exists only by hitting it, and a
 * bare refusal reads like a broken tool — which is why an observed session
 * answered a refused `git_push` by running the same push through `bash`.
 *
 * Two constraints shape everything here:
 *
 * 1. The wording is DERIVED from the matrix (`decide`/`ceilingOf`) rather than
 *    written out by hand, so the description cannot drift from the decisions
 *    actually taken.
 * 2. Only `sandbox`/`approval` vocabulary is used. Preset names like "auto" are
 *    a host concept; core does not know them (see permission-modes.ts).
 *
 * Zero I/O, zero side effects — callers decide when to inject the result.
 */

import type { PermissionConfig } from "./permission-policy.js";
import { ceilingOf, decide } from "./permission-policy.js";
import type { RiskTier } from "./tool.js";

/**
 * A stable identity for a permission configuration.
 *
 * Used to answer "has the model already been told about this boundary?", so it
 * must cover every field that changes what the reminder would say — including
 * `rules`, which outrank the matrix.
 */
export function permissionFingerprint(config: PermissionConfig): string {
  const rules = (config.rules ?? [])
    .map((r) => `${r.toolName ?? ""}|${r.toolPattern ?? ""}|${r.capability ?? ""}|${r.decision}`)
    .join(";");
  return `${config.sandbox}/${config.approval}/${rules}`;
}

/**
 * Describe the filesystem write boundary.
 *
 * The sandbox mode fixes the SCOPE of writes; what happens when the agent
 * reaches past that scope comes from `decide`, never from a hand-written
 * assumption. Under `read-only` a write sits above the ceiling, so an `ask`
 * approval policy escalates it to the user instead of refusing it — telling
 * the model "every write is refused" there would be simply false.
 */
function writeBoundaryLine(config: PermissionConfig): string {
  switch (config.sandbox) {
    case "read-only": {
      const onWrite = decide(ceilingOf(config.sandbox), config.approval, "WRITE_LOW");
      return onWrite === "deny"
        ? "- You cannot write to the filesystem at all. Every write is refused."
        : "- You cannot write to the filesystem on your own. Every write is put to the user for approval first.";
    }
    case "workspace-write":
      return "- Filesystem writes are confined to the workspace. Writes outside it are refused.";
    case "danger-full-access":
      return "- Filesystem writes are unrestricted. Nothing confines them to the workspace.";
  }
}

function approvalLine(config: PermissionConfig): string {
  return config.approval === "ask"
    ? "- Higher-risk tool calls stop and ask you before they run."
    : "- This session will not stop to ask for confirmation; the policy decides everything on its own.";
}

/**
 * Describe how the matrix treats the tier above the sandbox ceiling, if there
 * is one. Derived, not hardcoded: `decide` is the same function the Runner
 * consults, so this sentence cannot claim a behaviour that will not happen.
 */
function ceilingLine(config: PermissionConfig): string | null {
  const ceiling = ceilingOf(config.sandbox);
  const order: RiskTier[] = ["READ_ONLY", "WRITE_LOW", "WRITE_HIGH", "IRREVERSIBLE"];
  const above = order.slice(order.indexOf(ceiling) + 1);
  if (above.length === 0) return null;

  const refused = above.filter((tier) => decide(ceiling, config.approval, tier) === "deny");
  if (refused.length === 0) return null;

  return `- Operations classified ${refused.join(" / ")} are above this session's ceiling and are refused outright.`;
}

const NO_ROUTING_AROUND =
  "If a tool is refused by this policy, that is a boundary the user configured, " +
  "not a malfunction. Do not reach the same effect through a different tool — in " +
  "particular, do not use `bash` to perform an operation a named tool just " +
  "refused. Stop and tell the user what was refused and which permission setting " +
  "would allow it.";

/**
 * Build the reminder text for a permission configuration.
 *
 * @param previous - the configuration the model was last told about. When
 *   given, the opening frames this as a mid-session change; the body is
 *   identical either way, because a changed boundary has to be restated in
 *   full rather than as a diff the model has to apply itself.
 */
export function buildPermissionReminder(
  config: PermissionConfig,
  previous?: PermissionConfig,
): string {
  const opening = previous
    ? "The permission boundary for this session has changed. It is now:"
    : "Permission boundary for this session:";

  const lines = [writeBoundaryLine(config), approvalLine(config)];
  const ceiling = ceilingLine(config);
  if (ceiling) lines.push(ceiling);

  return `<system-reminder>\n${opening}\n\n${lines.join("\n")}\n\n${NO_ROUTING_AROUND}\n</system-reminder>`;
}
