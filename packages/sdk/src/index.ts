// @agent-core/sdk — facade: createAgent, run / stream / resume

export { createAgent } from "./create-agent.js";
export type { CreateAgentOptions, AgentInstance, ResolvedPorts } from "./create-agent.js";

// Re-export commonly needed types
export type {
  ModelPort,
  ToolDefinition,
  ToolResult,
  EventSink,
  SessionStore,
  AgentInput,
  ReducerState,
  PermissionConfig,
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
