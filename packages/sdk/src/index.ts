// @volto/sdk — facade: createAgent, run / stream / resume

export { createAgent } from "./create-agent.js";
export type { CreateAgentOptions, AgentInstance, ResolvedPorts } from "./create-agent.js";

// M9: Model layer
export { createModelRouter } from "./model-router.js";
export type { ModelRouterOptions } from "./model-router.js";
export { createCostMeter } from "./cost-meter.js";
export type { CostMeterOptions, PricingTable, PricingEntry, CostMeterResult } from "./cost-meter.js";

// M12: Audit
export { defaultAuditSink } from "@volto/runtime-node";
export type { AuditEntry, AuditSink } from "@volto/runtime-node";

// Re-export commonly needed types
export type {
  ModelPort,
  ToolDefinition,
  ToolResult,
  ToolSource,
  EventSink,
  SessionStore,
  AgentInput,
  ReducerState,
  PermissionConfig,
  ToolScopeConfig,
} from "@volto/core";

// Re-export runner types for advanced usage
export type { Runner, RunnerOptions, ToolExecutor } from "@volto/runtime-node";

// Re-export default ports for customization
export {
  defaultClock,
  defaultId,
  defaultRandom,
  defaultTokenizer,
  defaultEventSink,
  createDefaultSessionStore,
  // M8: new port defaults
  defaultToolSource,
  createDefaultMemoryStore,
  defaultEmbedder,
  defaultTelemetry,
  createDefaultCache,
  defaultSandbox,
  defaultSecrets,
  defaultScheduler,
  defaultPolicyEngine,
} from "./defaults.js";

// Re-export stream channel for advanced usage
export { createStreamChannel } from "./stream-channel.js";
export type { StreamChannel } from "./stream-channel.js";

// M12: Time-travel debugger
export { createTimeTravelDebugger, createInitialState, diffState } from "./debugger.js";
export type { Checkpoint, DebuggerOptions, TimeTravelDebugger, StateDiff } from "./debugger.js";

// M13: Layered config
export { mergeConfig } from "./config.js";
export type { ConfigLayer, ConfigSource, ResolvedConfig, ResolvedFrom, MergeStrategy } from "./config.js";

// M13: Plugin protocol
export { collectPlugins, createPluginToolSource, createPluginRegistry } from "./plugin.js";
export type {
  Plugin,
  PluginRegistry,
  CollectedPlugins,
  PluginHook,
  PluginCommand,
  PluginSkill,
  PluginAgentSpec,
} from "./plugin.js";

// M13: Hooks (re-exported from core)
export { runHookPipeline } from "@volto/core";
export type { Hook, HookOutcome, HookPatch, HookContext, HookLifecycle, HookHandler } from "@volto/core";

// M13: Declarative agent spec
export { resolveAgentSpec, loadAgentSpec } from "./agent-spec.js";
export type { AgentSpec, ResolvedAgentSpec, ToolRegistry, LoadAgentSpecOptions } from "./agent-spec.js";

// M13: Slash commands
export { renderCommand, parseArgs, findCommand } from "./commands.js";
export type { SlashCommand } from "./commands.js";

// M13: Skills
export { findTriggeredSkills, collectResources } from "./skills.js";
export type { Skill, ResourceLoader } from "./skills.js";

// M12: Multi-agent orchestration
export { createOrchestrator } from "./orchestration.js";
export type { OrchestratorOptions } from "./orchestration.js";

// SSE protocol layer (import as: import { sse } from '@volto/sdk')
export * as sse from "./sse/index.js";

// Transcript read facade
export { readConversation, readTrajectory } from "./transcript-reader.js";
