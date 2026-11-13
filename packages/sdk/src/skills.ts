/**
 * Skills — legacy skill metadata types (M13 Phase 5).
 *
 * Discovery and loading now flow through the host-owned `SkillRegistry`
 * port (@voltojs/core) and the progressive disclosure pipeline in
 * create-agent (the `skill-catalog` context layer plus the model-facing
 * `skill` tool). The former trigger auto-injection API (the two pure
 * trigger/resource helpers and `Skill.trigger`) was removed by plan-016 —
 * skill bodies are loaded on demand through the registry, never
 * auto-injected.
 *
 * `Skill` and `ResourceLoader` remain exported for hosts that still model
 * skill metadata themselves (e.g. apps/gateway's skill directory
 * loader).
 */

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface Skill {
  /** Unique skill name */
  name: string;
  /** Human-readable description */
  description: string;
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
