// @agent-core/core — pure functional kernel, zero dependencies

export const VERSION = "0.0.1";

// Types — State
export type {
  AgentStatus,
  TextContent,
  ImageContent,
  ToolUseContent,
  ToolResultContent,
  ContentBlock,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  PendingToolCall,
  ReadFileRecord,
  AgentState,
} from "./state.js";

// Types — Input
export type {
  UserMessageInput,
  ModelChunkInput,
  ModelDoneInput,
  ModelErrorInput,
  ToolResultInput,
  ApprovalDecisionInput,
  RequestApprovalInput,
  CancelInput,
  BudgetExceededInput,
  AgentInput,
} from "./input.js";

// Types — Effect
export type {
  CallModelEffect,
  ExecuteToolEffect,
  RequestApprovalEffect,
  EmitEffect,
  CheckpointEffect,
  WaitForInputEffect,
  DoneEffect,
  Effect,
} from "./effect.js";

// Types — Ports
export type {
  ModelEventTextDelta,
  ModelEventReasoningDelta,
  ModelEventToolUseStart,
  ModelEventToolUseDelta,
  ModelEventUsage,
  ModelEventDone,
  ModelEventError,
  ModelEvent,
  ModelRequest,
  ModelPort,
  FileStat,
  FileReadResult,
  FileListResult,
  FileGlobResult,
  FileGrepResult,
  FileSystem,
  ShellEventStdout,
  ShellEventStderr,
  ShellEventExit,
  ShellEvent,
  ShellExecOptions,
  Shell,
  NetworkRequest,
  NetworkResponse,
  Network,
  SessionSnapshot,
  SessionStore,
  EventSink,
  ApprovalGate,
  Clock,
  Id,
  Random,
  Tokenizer,
  // M8: new port interfaces
  ToolSource,
  MemoryEntry,
  MemoryStore,
  Embedder,
  TelemetrySpan,
  Telemetry,
  Cache,
  SandboxExecSpec,
  SandboxEvent,
  Sandbox,
  Secrets,
  Scheduler,
  PolicyRequest,
  PolicyEngine,
} from "./ports.js";

// Types — Tool
export type {
  JSONSchema,
  Capability,
  RiskTier,
  ToolDefinition,
  ToolResult,
} from "./tool.js";

// Reducer
export { step, createInitialState, resetTurnForNextInput } from "./reducer.js";
export type { StepResult, StepContext, ReducerState } from "./reducer.js";

// ToolRouter
export { validateToolInput, filterVisibleTools, routeToolCall } from "./tool-router.js";

// File gate (read-before-edit + staleness) — pure decisions
export {
  recordFileAccess,
  findReadRecord,
  evaluateEditGate,
  evaluateOverwriteGate,
  extractFileAccess,
} from "./file-gate.js";
export type { FileAccess } from "./file-gate.js";

// ContextAssembler — cache-friendly message ordering
export {
  assembleContext,
  buildToolPrompt,
  computeStaticPrefixTokens,
} from "./context-assembler.js";
export type { AssembleContextOptions, AssembledContext } from "./context-assembler.js";

// Compactor — compression decision logic
export {
  decideCompaction,
  estimateTokens,
  estimateMessageTokens,
  extractFilePaths,
  hasIncompleteTodos,
  isToolInteraction,
  isKeyMessage,
} from "./compactor.js";
export type { CompactionOptions, CompactionDecision, CompactionConfig } from "./compactor.js";

// PermissionPolicy — pure permission decision logic
export { evaluatePermission, createDefaultPermissionConfig } from "./permission-policy.js";
export type { PermissionConfig } from "./permission-policy.js";

// Text extraction — shared helpers for Message → string
export { extractMessageText, extractBlockText, extractPlainText } from "./text-extract.js";

// Testing utilities
export {
  createMockModelPort,
  textDelta,
  reasoningDelta,
  toolUseStart,
  toolUseDelta,
  usage,
  modelDone,
  modelError,
  toolCallScript,
  textScript,
} from "./testing/mock-model-port.js";
export type { ModelPortScript } from "./testing/mock-model-port.js";

// Testing tokenizer utilities
export { createCharTokenizer, createFixedTokenizer, createMappedTokenizer } from "./testing/char-tokenizer.js";
