// @agent-core/sdk — facade: createAgent, run / stream / resume

export { createAgent } from "./create-agent.js";
export type { CreateAgentOptions, AgentInstance, ResolvedPorts } from "./create-agent.js";

// M9: Model layer
export { createModelRouter } from "./model-router.js";
export type { ModelRouterOptions } from "./model-router.js";
export { createCostMeter } from "./cost-meter.js";
export type { CostMeterOptions, PricingTable, PricingEntry, CostMeterResult } from "./cost-meter.js";

// M12: Audit
export { defaultAuditSink } from "./audit.js";
export type { AuditEntry, AuditSink } from "./audit.js";

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
} from "@agent-core/core";

// Re-export runner types for advanced usage
export type { Runner, RunnerOptions, ToolExecutor } from "@agent-core/runtime-node";

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
export { createTimeTravelDebugger, createInitialState } from "./debugger.js";
export type { Checkpoint, DebuggerOptions, TimeTravelDebugger } from "./debugger.js";
