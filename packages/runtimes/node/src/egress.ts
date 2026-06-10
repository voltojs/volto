/**
 * Egress-aware Network wrapper — intercepts fetch requests and checks
 * the target hostname against an allow/deny list.
 *
 * Denied requests return a structured error result, never throw.
 */

import type { Network, NetworkRequest, NetworkResponse } from "@agent-core/core";

export interface EgressPolicy {
  /** If defined, only these hostnames are allowed (allowlist mode) */
  allowHosts?: string[];
  /** If defined, these hostnames are always denied (denylist mode, takes precedence) */
  denyHosts?: string[];
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isHostAllowed(host: string, policy: EgressPolicy): boolean {
  // Denylist takes precedence
  if (policy.denyHosts?.includes(host)) return false;
  // Allowlist mode: if set, host must be in the list
  if (policy.allowHosts !== undefined) {
    return policy.allowHosts.includes(host);
  }
  // No policy → allow all
  return true;
}

/**
 * Wrap a Network adapter with egress control.
 * Denied requests return `{ status: 403, body: "..." }` instead of throwing.
 */
export function wrapNetworkWithEgress(inner: Network, policy: EgressPolicy): Network {
  return {
    async fetch(req: NetworkRequest): Promise<NetworkResponse> {
      const host = extractHost(req.url);

      if (!isHostAllowed(host, policy)) {
        return {
          status: 403,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            error: "egress_denied",
            message: `Network egress denied: host "${host}" is not in the allowed list.`,
          }),
        };
      }

      return inner.fetch(req);
    },
  };
}
