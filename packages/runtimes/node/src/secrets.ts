/**
 * Node Secrets adapter — implements the M8 Secrets port.
 *
 * Resolves secret references with scope-based access control.
 * Credentials are NEVER stored in messages or state checkpoints —
 * they are used only within the adapter for actual operations.
 */

import type { Secrets } from "@voltojs/core";

export interface SecretsScope {
  /** Secret refs this scope may resolve. If undefined, all refs are allowed. */
  allowedRefs?: string[];
  /** Environment variable prefix to look up (default: "SECRET_") */
  envPrefix?: string;
  /** Pre-loaded secrets map (for testing / config-file injection) */
  secrets?: Record<string, string>;
}

export interface NodeSecretsOptions {
  scope?: SecretsScope;
}

/**
 * Create a scoped Secrets adapter.
 *
 * Resolution order:
 * 1. Pre-loaded `scope.secrets[ref]`
 * 2. Environment variable `${envPrefix}${ref.toUpperCase()}`
 * 3. Return undefined (secret not found)
 *
 * If `scope.allowedRefs` is defined and ref is not in the list, resolution
 * returns undefined (scope violation, not an error — the caller handles it).
 */
export function createNodeSecrets(opts?: NodeSecretsOptions): Secrets {
  const scope: SecretsScope = opts?.scope ?? {};
  const envPrefix = scope.envPrefix ?? "SECRET_";
  const secretsMap = scope.secrets ?? {};
  const allowedRefs = scope.allowedRefs;

  return {
    async resolve(ref: string): Promise<string | undefined> {
      // Scope check: if allowedRefs is set, ref must be in the list
      if (allowedRefs !== undefined && !allowedRefs.includes(ref)) {
        return undefined;
      }

      // 1. Pre-loaded secrets
      if (secretsMap[ref] !== undefined) {
        return secretsMap[ref]!;
      }

      // 2. Environment variable
      const envKey = `${envPrefix}${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
      const envVal = process.env[envKey];
      if (envVal !== undefined) {
        return envVal;
      }

      // 3. Not found
      return undefined;
    },
  };
}
