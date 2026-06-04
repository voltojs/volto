/**
 * Ports — interface contracts for all external capabilities.
 * These are types only; implementations are provided by adapters.
 * The core imports these interfaces, never their implementations.
 */

import type { AgentState, Message, PendingToolCall } from "./state.js";
import type { RiskTier, ToolDefinition } from "./tool.js";

// ──────────────────────────────────────────────
// ModelPort — the model provider interface
// ──────────────────────────────────────────────

export interface ModelEventTextDelta {
  type: "text_delta";
  text: string;
}

export interface ModelEventReasoningDelta {
  type: "reasoning_delta";
  text: string;
}

export interface ModelEventToolUseStart {
  type: "tool_use_start";
  toolCallId: string;
  toolName: string;
}

export interface ModelEventToolUseDelta {
  type: "tool_use_delta";
  toolCallId: string;
  argumentsDelta: string;
}

export interface ModelEventUsage {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
}

export interface ModelEventDone {
  type: "done";
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

export interface ModelEventError {
  type: "error";
  error: string;
  retriable?: boolean;
}

export type ModelEvent =
  | ModelEventTextDelta
  | ModelEventReasoningDelta
  | ModelEventToolUseStart
  | ModelEventToolUseDelta
  | ModelEventUsage
  | ModelEventDone
  | ModelEventError;

export interface ModelRequest {
  messages: Message[];
  tools: ToolDefinition[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export interface ModelPort {
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
}

// ──────────────────────────────────────────────
// FileSystem — file capabilities
// ──────────────────────────────────────────────

export interface FileStat {
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number; // epoch ms
}

export interface FileReadResult {
  content: string;
  totalLines: number;
  truncated: boolean;
}

export interface FileListResult {
  entries: Array<{ name: string; path: string; isDirectory: boolean }>;
}

export interface FileGlobResult {
  paths: string[];
}

export interface FileGrepResult {
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
}

export interface FileSystem {
  read(path: string, offset?: number, limit?: number): Promise<FileReadResult>;
  write(path: string, data: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  list(dir: string): Promise<FileListResult>;
  glob(pattern: string): Promise<FileGlobResult>;
  grep(query: string, opts?: { path?: string; glob?: string; limit?: number }): Promise<FileGrepResult>;
}

// ──────────────────────────────────────────────
// Shell — command execution
// ──────────────────────────────────────────────

export interface ShellEventStdout {
  type: "stdout";
  data: string;
}

export interface ShellEventStderr {
  type: "stderr";
  data: string;
}

export interface ShellEventExit {
  type: "exit";
  code: number;
}

export type ShellEvent = ShellEventStdout | ShellEventStderr | ShellEventExit;

export interface ShellExecOptions {
  cwd?: string;
  timeout?: number;
  runInBackground?: boolean;
  abortSignal?: AbortSignal;
}

export interface Shell {
  exec(cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent>;
  /** Launch a command in the background. Returns immediately with a process ID. */
  launch?(cmd: string, opts?: Omit<ShellExecOptions, "runInBackground">): Promise<string>;
}

// ──────────────────────────────────────────────
// Network — HTTP capabilities
// ──────────────────────────────────────────────

export interface NetworkRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface NetworkResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Network {
  fetch(req: NetworkRequest): Promise<NetworkResponse>;
}

// ──────────────────────────────────────────────
// SessionStore — checkpoint / resume persistence
// ──────────────────────────────────────────────

export interface SessionSnapshot {
  id: string;
  state: AgentState;
  createdAt: number;
}

export interface SessionStore {
  save(snapshot: SessionSnapshot): Promise<void>;
  load(id: string): Promise<SessionSnapshot | undefined>;
  list(): Promise<SessionSnapshot[]>;
}

// ──────────────────────────────────────────────
// EventSink — observable event output
// ──────────────────────────────────────────────

export interface EventSink {
  emit(event: { type: string; data: Record<string, unknown> }): void;
}

// ──────────────────────────────────────────────
// ApprovalGate — HITL approval
// ──────────────────────────────────────────────

export interface ApprovalGate {
  ask(call: PendingToolCall, riskTier: RiskTier): Promise<"allow" | "deny">;
}

// ──────────────────────────────────────────────
// Deterministic ports (Clock / Id / Random / Tokenizer)
// ──────────────────────────────────────────────

export interface Clock {
  now(): number;
}

export interface Id {
  next(): string;
}

export interface Random {
  next(): number;
}

export interface Tokenizer {
  count(text: string): number;
}
