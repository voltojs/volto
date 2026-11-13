/**
 * Resolve the parameter facts a permission rule needs from a tool call's raw
 * input: canonical paths and hostnames.
 *
 * This is the Runner side of the split in
 * docs/superpowers/specs/2026-09-20-parameter-permission-rules-design.md (D2/D4):
 * core decides, the Runner does the I/O. Path resolution reuses the sandbox's
 * own `realResolve` on purpose — the permission layer and the boundary must
 * compare paths in exactly the same terms, or a rule can match a path the
 * sandbox resolves somewhere else.
 */

import * as path from "node:path";
import type { ResolvedToolInput, ToolDefinition } from "@voltojs/core";
import { realResolve, realResolveRoot } from "./sandboxed-filesystem.js";

export interface ToolInputFactResolver {
  resolve(
    definition: ToolDefinition,
    input: Record<string, unknown>,
  ): Promise<ResolvedToolInput | undefined>;
}

/** Lowercased hostname, or undefined when the value is not a URL. */
function hostOf(value: string): string | undefined {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

export function createToolInputFactResolver(root: string): ToolInputFactResolver {
  const lexicalRoot = path.resolve(root);
  // Lazy + cached, same discipline as the sandbox's writable roots: the
  // resolver must be cheap to construct (the Runner builds it per turn) and a
  // root that does not exist yet must not throw.
  let realRootPromise: Promise<string> | undefined;
  function getRealRoot(): Promise<string> {
    if (!realRootPromise) realRootPromise = realResolveRoot(lexicalRoot);
    return realRootPromise;
  }

  return {
    async resolve(definition, input) {
      const paths: NonNullable<ResolvedToolInput["paths"]> = [];
      const hosts: NonNullable<ResolvedToolInput["hosts"]> = [];

      if (definition.pathInputs !== undefined && definition.pathInputs.length > 0) {
        const realRoot = await getRealRoot();
        for (const field of definition.pathInputs) {
          const raw = input[field];
          const values = Array.isArray(raw) ? raw : [raw];
          for (const value of values) {
            if (typeof value !== "string" || value.length === 0) continue;
            // Producers expand `~`; a literal one here is never a real path,
            // and guessing a home directory would make the permission layer
            // disagree with the sandbox about what is being written.
            if (value.startsWith("~")) continue;
            // Relative inputs resolve against the workspace root, exactly as
            // the sandbox's `toCandidate` does — never against process.cwd().
            const target = path.isAbsolute(value) ? value : path.join(lexicalRoot, value);
            const absolute = await realResolve(target);
            paths.push({ field, absolute, relative: path.relative(realRoot, absolute) });
          }
        }
      }

      if (definition.hostInputs !== undefined && definition.hostInputs.length > 0) {
        for (const field of definition.hostInputs) {
          const raw = input[field];
          if (typeof raw !== "string" || raw.length === 0) continue;
          const host = hostOf(raw);
          if (host !== undefined) hosts.push({ field, host });
        }
      }

      if (paths.length === 0 && hosts.length === 0) return undefined;
      return {
        ...(paths.length > 0 ? { paths } : {}),
        ...(hosts.length > 0 ? { hosts } : {}),
      };
    },
  };
}
