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
export { validateToolInput, filterVisibleTools, filterByScope, routeToolCall } from "./tool-router.js";
export type { ToolScopeConfig, ScopeGroupConfig } from "./tool-router.js";

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
export { evaluatePermission, createDefaultPermissionConfig, isWriteTier } from "./permission-policy.js";
export type { PermissionConfig, PermissionMode, PermissionRule } from "./permission-policy.js";

// Text extraction — shared helpers for Message → string
export { extractMessageText, extractBlockText, extractPlainText } from "./text-extract.js";

// Loop detector — oscillation detection (pure function)
export { detectLoop } from "./loop-detector.js";
export type { LoopDetectionResult } from "./loop-detector.js";

// Error taxonomy — pure classification for retry decisions
export { classifyError } from "./error-taxonomy.js";
export type { ErrorKind, ErrorClassification } from "./error-taxonomy.js";

// Guardrails — content safety (untrusted annotation + PII masking)
export {
  annotateUntrusted,
  isUntrusted,
  maskPII,
  containsPII,
  UNTRUSTED_PREFIX,
} from "./guardrails.js";
export type { PIIMaskResult } from "./guardrails.js";

// Self-correction — validation-repair pure decision logic
export {
  decideSelfCorrect,
  createSchemaValidator,
  DEFAULT_MAX_SELF_CORRECTIONS,
} from "./self-correct.js";
export type { ValidationResult, SelfCorrectDecision, Validator } from "./self-correct.js";

// Instructions — project instruction loading with @import expansion
export { expandInstructions, mergeInstructionLayers } from "./instructions.js";
export type { InstructionExpandResult, InstructionReference } from "./instructions.js";

// RAG retrieval — slot placement for augmented context
export { computeRAGInjectionIndex, buildRAGMessage } from "./retrieval.js";

// State diff — pure function for time-travel debugger
export { diffState } from "./state-diff.js";
export type { StateDiff } from "./state-diff.js";

// Orchestration — topology spec types (pure data)
export type {
  TopologyKind,
  TopologyNodeSpec,
  TopologySpec,
  TopologyResult,
} from "./orchestration.js";

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
