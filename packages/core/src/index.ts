// @volto/core — pure functional kernel, zero dependencies

export const VERSION = "0.0.1";

// Types — State
export type {
  AgentStatus,
  TextContent,
  ImageContent,
  ToolUseContent,
  ToolResultContent,
  ReasoningContent,
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
  SelfCorrectInput,
  AgentInput,
} from "./input.js";

// Types — Effect
export type {
  CallModelEffect,
  RequestApprovalEffect,
  EmitEffect,
  CheckpointEffect,
  DoneEffect,
  Effect,
} from "./effect.js";

// Export ReasoningEffortId as a value (constructor function + type)
export { ReasoningEffortId } from "./ports.js";
export type {
  ReasoningEffortInfo,
  ModelReasoningInfo,
  ResolvedModelInfo,
} from "./ports.js";

// Types — Ports
export type {
  ModelEventTextDelta,
  ModelEventReasoningDelta,
  ModelEventToolUseStart,
  ModelEventToolUseDelta,
  ModelEventUsage,
  ModelEventDone,
  ModelEventError,
  ModelEventUsageUnavailable,
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
  ChatSessionMeta,
  TokenUsage,
  TurnEndReason,
  TranscriptEventMap,
  TranscriptEventType,
  TranscriptEventInput,
  TranscriptEvent,
  TranscriptStore,
  TranscriptReader,
  SkillInvocationPolicy,
  SkillSummary,
  LoadedSkill,
  SkillRegistry,
  EventSink,
  ApprovalGate,
  ApprovalDenialReason,
  ApprovalResult,
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

// Transcript projection — event log → Message[] for session resume
export { projectMessages, projectMessageEntries } from "./transcript-projection.js";
export type { ProjectedMessage } from "./transcript-projection.js";

// View projection — event log → turn/step records for the trajectory UI
export { buildTurnRecords } from "./view-projection.js";
export type {
  TurnRecord,
  StepRecord,
  AssistantRecord,
  PartialAssistant,
  ToolCallRecord,
  UserInputRecord,
  RetryRecord,
} from "./view-projection.js";

// View projection — turn records → chat feed for the web UI
export { toConversationView } from "./view-projection.js";
export type {
  ConversationView,
  ConversationMessage,
  ConversationBlock,
  ConversationToolCall,
} from "./view-projection.js";

// View projection — streaming partials + trajectory audit ledger
export { applyPartial, toTrajectoryView } from "./view-projection.js";
export type { TranscriptDelta, TrajectoryView, TrajectoryRow } from "./view-projection.js";

// Reducer
export { step, createInitialState, resetTurnForNextInput } from "./reducer.js";
export type { StepResult, StepContext, ReducerState } from "./reducer.js";

// ToolRouter
export { validateToolInput, filterVisibleTools, filterByScope, routeToolCall } from "./tool-router.js";
export type { ToolScopeConfig, ScopeGroupConfig } from "./tool-router.js";

// Hooks — M13
export { runHookPipeline } from "./hooks.js";
export type { Hook, HookOutcome, HookPatch, HookContext, HookLifecycle, HookHandler } from "./hooks.js";

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
export type { ContextLayer, AssembleContextOptions, AssembledContext } from "./context-assembler.js";

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
export { evaluatePermission, createDefaultPermissionConfig, isWriteTier, ceilingOf, decide, policyDenialMessage } from "./permission-policy.js";
export type { PermissionConfig, SandboxMode, ApprovalPolicy, Decision, PermissionRule } from "./permission-policy.js";

// Text extraction — shared helpers for Message → string
export { extractMessageText, extractBlockText, extractPlainText } from "./text-extract.js";

// Pricing — shared cost arithmetic (core ← runtimes-* and core ← sdk)
export { computeUsageCost, totalUsageTokens } from "./pricing.js";
export type { PricingEntry, PricingTable, UsageCounts } from "./pricing.js";

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

// Skill invocation — the `/name` user gesture (pure)
export { parseSkillInvocation, renderSkillInjection, capSkillInjection } from "./skill-invocation.js";

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

// Workspace instructions — AGENTS.md & friends chain path helpers (pure, zero I/O)
export {
  ancestorChain,
  candidateFileNames,
  dedupeInstructions,
  instructionLayerId,
  renderInstructionLayers,
  truncateUtf8,
  userInstructionDirs,
  BASE_INSTRUCTION_FILES,
  LOCAL_INSTRUCTION_FILES,
  FS_PATH_TOOLS,
  descendantChain,
  extractTouchedToolPaths,
  DEFAULT_MAX_DISCOVERED_DIRS,
} from "./workspace-instructions.js";
export type {
  LoadedInstructionFile,
  InstructionOrigin,
  RenderedInstructions,
  TruncationRecord,
  ContextLayerHints,
} from "./workspace-instructions.js";

// Heuristic tokenizer — the production default behind the Tokenizer port
export { createHeuristicTokenizer } from "./heuristic-tokenizer.js";

// Context usage — how full the model's context window is (pure projection)
export {
  emptyContextUsageFold,
  foldContextUsageEvent,
  contextUsageView,
  computeContextUsage,
  emptyContextUsageSnapshot,
  snapshotFold,
  foldSnapshotEvent,
  snapshotView,
} from "./context-usage.js";
export type {
  ContextUsageFold,
  ContextUsageHeader,
  ContextUsageAnchor,
  ContextUsageView,
  ContextUsageSnapshot,
  ContextUsageHeaderEstimate,
} from "./context-usage.js";

// Testing utilities
export {
  createMockModelPort,
  textDelta,
  reasoningDelta,
  toolUseStart,
  toolUseDelta,
  usage,
  modelDone,
  modelDoneWithMeta,
  modelError,
  toolCallScript,
  textScript,
} from "./testing/mock-model-port.js";
export type { ModelPortScript } from "./testing/mock-model-port.js";

// Testing tokenizer utilities
export { createCharTokenizer, createFixedTokenizer, createMappedTokenizer } from "./testing/char-tokenizer.js";
