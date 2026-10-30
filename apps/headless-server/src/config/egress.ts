/**
 * Egress policy config — `egress.json` in the user config dir, loaded once
 * per session build (an edit reaches newly built sessions without a
 * restart).
 *
 * Scope, stated plainly because pretending otherwise would be the exact
 * illusion SAFETY.md warns about: this policy governs the Network port only
 * (web_fetch / web_search / http_query). It cannot reach the model's own
 * transport and it cannot reach anything the bash tool launches.
 *
 * Fail-closed: a malformed file refuses the policy (throws) instead of
 * silently running without it — a user who wrote one expects it to be
 * enforced. Unknown keys are rejected for the same reason: a typo
 * (`allowHost`) must not quietly disable the whole policy.
 */

import { ConfigCorruptError } from "./io.js";
import { getConfigStore } from "./store.js";
import type { EgressPolicy } from "@volto/runtime-node";

const HOST_LIST_KEYS = ["allowHosts", "denyHosts"] as const;

export class EgressConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressConfigError";
  }
}

/** Parse and normalize one host list: trim, lowercase, drop nothing silently. */
function normalizeHostList(key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new EgressConfigError(
      `egress.json: "${key}" must be an array of hostnames`,
    );
  }
  return (value as string[]).map((entry) => {
    const host = entry.trim().toLowerCase();
    if (host.length === 0) {
      throw new EgressConfigError(`egress.json: "${key}" contains an empty hostname`);
    }
    return host;
  });
}

/**
 * Load the egress policy from `<configDir>/egress.json`. Returns `null`
 * when the file is absent or carries no rule keys; an explicit
 * `{ "allowHosts": [] }` is meaningful (deny-all) and is preserved.
 */
export async function loadEgressPolicy(configDir: string): Promise<EgressPolicy | null> {
  let section: unknown;
  try {
    section = (await getConfigStore(configDir).read())["egress"];
  } catch (err) {
    if (err instanceof ConfigCorruptError) {
      throw new EgressConfigError(
        `config.json could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
  if (section === undefined) return null;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new EgressConfigError("config.json: egress must be a JSON object");
  }
  const obj = section as Record<string, unknown>;
  const unknownKeys = Object.keys(obj).filter(
    (key) => !(HOST_LIST_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new EgressConfigError(
      `egress.json has unknown key(s): ${unknownKeys.join(", ")} — expected ${HOST_LIST_KEYS.join(" / ")}`,
    );
  }

  const policy: EgressPolicy = {};
  for (const key of HOST_LIST_KEYS) {
    if (obj[key] === undefined) continue;
    if (key === "allowHosts") policy.allowHosts = normalizeHostList(key, obj[key]);
    else policy.denyHosts = normalizeHostList(key, obj[key]);
  }
  if (policy.allowHosts === undefined && policy.denyHosts === undefined) return null;
  return policy;
}
