/**
 * Plugin protocol and registry — M13 Phase 2.
 *
 * Plugins declare capabilities via `register(registry)`, the registry
 * aggregates tools / providers / hooks / commands / skills / agentSpecs,
 * and `createAgent` consumes the registry to wire everything into the
 * existing ToolSource / capability-gating / permission pipeline.
 *
 * Plugins are local trusted code (M13 Non-Goal 6); sandboxing is M11's concern.
 */

import type {
  ToolDefinition,
  ToolSource,
} from "@agent-core/core";
import type { Tool } from "@agent-core/tools-common";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/**
 * A plugin is a named bundle that registers its capabilities into the registry.
 * `register` is called exactly once during `collectPlugins`.
 */
export interface Plugin {
  /** Unique plugin name (used for dedup and logging) */
  name: string;
  /** Register tools / providers / hooks / commands / skills / agentSpecs */
  register(registry: PluginRegistry): void;
}

/**
 * Mutable registry that collects plugin products during the装配 phase.
 * Each add* method is idempotent for the same name (last write wins for
 * tools; arrays are append-only for hooks/commands/skills/agentSpecs).
 */
export interface PluginRegistry {
  /** Register a tool (last write wins on name collision) */
  addTool(tool: Tool): void;
  /** Register a provider by name */
  addProvider(name: string, provider: unknown): void;
  /** Register a hook (append-only) */
  addHook(hook: PluginHook): void;
  /** Register a slash command (append-only) */
  addCommand(command: PluginCommand): void;
  /** Register a skill (append-only) */
  addSkill(skill: PluginSkill): void;
  /** Register an agent spec (append-only) */
  addAgentSpec(spec: PluginAgentSpec): void;
}

// ──────────────────────────────────────────────
// Plugin product types (Phase 3-5 will flesh these out)
// ──────────────────────────────────────────────

/** Hook placeholder — will be fully defined in Phase 3 */
export interface PluginHook {
  name: string;
  /** Lifecycle point this hook listens to */
  lifecycle: string;
  /** Handler function — signature TBD by Phase 3 */
  handler: (...args: unknown[]) => unknown;
}

/** Slash command placeholder — will be fully defined in Phase 5 */
export interface PluginCommand {
  name: string;
  scope?: "user" | "project";
  template: string;
  args?: Record<string, unknown>;
}

/** Skill placeholder — will be fully defined in Phase 5 */
export interface PluginSkill {
  name: string;
  description: string;
  trigger?: string;
  resources?: string[];
}

/** Agent spec placeholder — will be fully defined in Phase 4 */
export interface PluginAgentSpec {
  name: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  capabilities?: string[];
}

// ──────────────────────────────────────────────
// Registry implementation
// ──────────────────────────────────────────────

export interface CollectedPlugins {
  /** Tools registered by plugins (deduped by name, last write wins) */
  tools: Tool[];
  /** Providers registered by name */
  providers: Map<string, unknown>;
  /** Hooks registered by plugins (append-order) */
  hooks: PluginHook[];
  /** Commands registered by plugins */
  commands: PluginCommand[];
  /** Skills registered by plugins */
  skills: PluginSkill[];
  /** Agent specs registered by plugins */
  agentSpecs: PluginAgentSpec[];
}

/**
 * Create a fresh PluginRegistry and return it along with a getter
 * for the collected products after all plugins have registered.
 */
export function createPluginRegistry(): {
  registry: PluginRegistry;
  collected: CollectedPlugins;
} {
  const toolMap = new Map<string, Tool>();
  const providers = new Map<string, unknown>();
  const hooks: PluginHook[] = [];
  const commands: PluginCommand[] = [];
  const skills: PluginSkill[] = [];
  const agentSpecs: PluginAgentSpec[] = [];

  const registry: PluginRegistry = {
    addTool(tool) {
      toolMap.set(tool.definition.name, tool);
    },
    addProvider(name, provider) {
      providers.set(name, provider);
    },
    addHook(hook) {
      hooks.push(hook);
    },
    addCommand(command) {
      commands.push(command);
    },
    addSkill(skill) {
      skills.push(skill);
    },
    addAgentSpec(spec) {
      agentSpecs.push(spec);
    },
  };

  const collected: CollectedPlugins = {
    get tools() {
      return [...toolMap.values()];
    },
    providers,
    hooks,
    commands,
    skills,
    agentSpecs,
  };

  return { registry, collected };
}

// ──────────────────────────────────────────────
// Plugin collection
// ──────────────────────────────────────────────

/**
 * Iterate all plugins, call their `register`, and return collected products.
 * Tools are deduped by name (last write wins).
 * No I/O — pure aggregation.
 */
export function collectPlugins(plugins: Plugin[]): CollectedPlugins {
  const { registry, collected } = createPluginRegistry();

  for (const plugin of plugins) {
    plugin.register(registry);
  }

  return collected;
}

// ──────────────────────────────────────────────
// ToolSource adapter for plugin tools
// ──────────────────────────────────────────────

/**
 * Wrap collected plugin tools as a ToolSource, so they integrate with
 * the existing ToolSource / capability-gating pipeline in createAgent.
 * Tools are returned as ToolDefinitions for list(); the actual Tool
 * objects (with handlers) are kept separately for routing.
 */
export function createPluginToolSource(pluginTools: Tool[]): ToolSource & {
  /** Get all plugin tools (with handlers) by name */
  getTool(name: string): Tool | undefined;
} {
  const toolMap = new Map<string, Tool>();
  for (const t of pluginTools) {
    toolMap.set(t.definition.name, t);
  }

  return {
    async list(): Promise<ToolDefinition[]> {
      return pluginTools.map((t) => t.definition);
    },
    getTool(name: string): Tool | undefined {
      return toolMap.get(name);
    },
  };
}
