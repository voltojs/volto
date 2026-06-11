/**
 * Skills — M13 Phase 5.
 *
 * Skills are discoverable, on-demand capability bundles with metadata
 * and trigger conditions. Resource loading is delegated to M9's
 * instruction loading / @import expansion (injection point).
 *
 * This module provides: Skill type, discovery helpers, metadata registry.
 * No I/O in pure functions; discovery of user/project directories is
 * the host's responsibility (injected via callback).
 */

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface Skill {
  /** Unique skill name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Trigger condition (natural language or pattern) */
  trigger?: string;
  /**
   * Resource references — paths or URIs to instruction files.
   * Actual loading is delegated to M9's @import expansion mechanism.
   * This module only collects/registers the references.
   */
  resources?: string[];
}

/**
 * Resource loader callback — provided by the host (typically wrapping M9's
 * instruction loading). Takes a list of resource references and returns
 * the loaded content. This is the injection point for M9 integration.
 */
export type ResourceLoader = (resources: string[]) => Promise<string>;

// ──────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────

/**
 * Pure function: filter skills whose trigger matches a given user input.
 * Simple substring/keyword matching — no I/O.
 */
export function findTriggeredSkills(skills: Skill[], input: string): Skill[] {
  const lower = input.toLowerCase();
  return skills.filter(
    (s) => s.trigger && lower.includes(s.trigger.toLowerCase()),
  );
}

/**
 * Pure function: get all unique resource references from a set of skills.
 */
export function collectResources(skills: Skill[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const skill of skills) {
    for (const r of skill.resources ?? []) {
      if (!seen.has(r)) {
        seen.add(r);
        result.push(r);
      }
    }
  }
  return result;
}
