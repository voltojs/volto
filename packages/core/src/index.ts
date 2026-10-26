// @volto/core — pure functional kernel, zero dependencies

export const VERSION = "0.0.1";

// Types — State
export type {
  AgentStatus,
  TextContent,
  ImageContent,
  StructuredContent,
  ToolUseContent,
  ToolResultBlock,
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
  TodoItem,
  TodoStatus,
  BackgroundTask,
  AgentState,
} from "./state.js";
export { normalizeToolResultContent } from "./state.js";

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
  LoopReminderInput,
  LoopInterventionInput,
  ToolResultsPrunedInput,
  CompactionAppliedInput,
  BackgroundTaskStartedInput,
  BackgroundTaskCompletedInput,
  FileChangedInput,
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
  ModelInputValue,
  ModelInputLimits,
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
  FileReadBytesResult,
  FileListResult,
  FileGlobResult,
  FileGrepResult,
  FileSystem,
  ShellEventStdout,
  ShellEventStderr,
  ShellEventExit,
  ShellEvent,
  ShellExecOptions,
  ShellProcessInfo,
  ShellProcessOutput,
  ShellLaunchOptions,
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
  ContextReminderKind,
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
  FileWatchEvent,
  FileWatchRegistration,
  FileWatcher,
  Scheduler,
  PolicyRequest,
  PolicyEngine,
  StoredAttachment,
  AttachmentStore,
  SpillWriteInput,
  SpillStore,
  PlanStore,
} from "./ports.js";

// Types — Tool
export type {
  JSONSchema,
  Capability,
  RiskTier,
  ToolDefinition,
  ToolResult,
} from "./tool.js";
export { CAP_MODEL_VISION } from "./tool.js";

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
  RouteSource,
} from "./view-projection.js";

// View projection — turn records → chat feed for the web UI
export { toConversationView } from "./view-projection.js";
export type {
  ConversationView,
  ConversationMessage,
  ConversationBlock,
  ConversationToolCall,
  TurnUsage,
} from "./view-projection.js";

// View projection — streaming partials + trajectory audit ledger
export { applyPartial, toTrajectoryView } from "./view-projection.js";
export type { TranscriptDelta, TrajectoryView, TrajectoryRow } from "./view-projection.js";

// Reducer
export { step, createInitialState, resetTurnForNextInput } from "./reducer.js";
export type { StepResult, StepContext, ReducerState } from "./reducer.js";

// ToolRouter
export { validateToolInput, filterVisibleTools, filterByScope, routeToolCall, CAP_AGENT_DEPTH_AVAILABLE } from "./tool-router.js";
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
  TODO_LIST_LAYER_ID,
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
  isPermissionReminder,
  buildSummaryPrompt,
} from "./compactor.js";
export type { CompactionOptions, CompactionDecision, CompactionConfig } from "./compactor.js";

// Compaction budget — window-aware threshold derivation (pure)
export {
  deriveCompactionMaxTokens,
  DEFAULT_COMPACTION_MAX_TOKENS,
  DEFAULT_COMPACTION_WINDOW_RATIO,
} from "./compaction-budget.js";
export type { CompactionBudgetInput } from "./compaction-budget.js";

// Todo standing-list formatter — model-facing injection text (pure)
export { formatTodoListForModel, formatTodoCounts, todoStatusIcon, foldStandingTodos } from "./todo-format.js";

// Tool-result pruning — deterministic head/tail cut under a char budget
export { pruneOversizedToolResults, resolvePruneOptions } from "./tool-result-prune.js";
export type { PruneToolResultOptions, PrunedToolResult } from "./tool-result-prune.js";

// Tool-result spill — pure decision + model-facing reference rendering
export { decideSpill, renderSpillReference } from "./tool-result-spill.js";
export type { SpillDecisionOptions, SpillDecision, SpillReferenceInput } from "./tool-result-spill.js";

// Compaction image offload — pure plan decision + preserved-marker rendering
export { planImageOffload, renderImagePreservedMarker } from "./compaction-image-offload.js";
export type { OffloadCandidate, ImageOffloadPlan } from "./compaction-image-offload.js";

// PermissionPolicy — pure permission decision logic
export { evaluatePermission, resolvePermission, createDefaultPermissionConfig, isWriteTier, ceilingOf, riskRank, decide, policyDenialMessage, userDenialMessage, narrowPermission, hasParameterRules, hasCommandRules } from "./permission-policy.js";
export type { PermissionConfig, SandboxMode, ApprovalPolicy, Decision, PermissionRule, ResolvedToolInput, PermissionResolution } from "./permission-policy.js";

// PermissionPrompt — model-facing description of the permission boundary
export { permissionFingerprint, buildPermissionReminder } from "./permission-prompt.js";

// Text extraction — shared helpers for Message → string
export {
  extractMessageText,
  extractBlockText,
  extractPlainText,
  estimateBlockTokens,
  estimateImageTokens,
  IMAGE_TOKEN_FALLBACK,
} from "./text-extract.js";

// Pricing — shared cost arithmetic (core ← runtimes-* and core ← sdk)
export { computeUsageCost, totalUsageTokens } from "./pricing.js";
export type { PricingEntry, PricingTable, UsageCounts } from "./pricing.js";

// Loop detector — oscillation detection (pure function)
export { detectLoop, renderLoopReminder, renderLoopIntervention } from "./loop-detector.js";
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
} from "./workspace-instructions.js";
export type {
  LoadedInstructionFile,
  InstructionOrigin,
  RenderedInstructions,
  TruncationRecord,
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

// Command risk classifier — display-only labelling for the approval prompt, never a permission gate
export { classifyCommandRisk } from "./command-risk.js";
export type { CommandRiskKind } from "./command-risk.js";

// Command matching — strict argv tokenization + prefix matching for commandPrefix rules
export { tokenizeCommand, matchesCommandPrefix, isMatchableCommandToken } from "./command-match.js";

// Prompt-budget estimators and anchored prompt arithmetic
export {
  estimateContextLayerTokens,
  estimateToolDefinitionTokens,
} from "./prompt-budget.js";
export { estimateFromAnchor } from "./prompt-budget.js";
export type { PromptAnchor, PromptAnchorState } from "./prompt-budget.js";
