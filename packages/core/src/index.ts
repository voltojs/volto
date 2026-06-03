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
  CancelInput,
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
export { step, createInitialState } from "./reducer.js";
export type { StepResult, StepContext, ReducerState } from "./reducer.js";

// ToolRouter
export { validateToolInput, filterVisibleTools, routeToolCall } from "./tool-router.js";

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
