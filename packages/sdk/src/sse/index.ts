/**
 * SSE (Server-Sent Events) protocol layer for @voltojs/sdk.
 *
 * Provides typed frame definitions, an event mapper (transcript events and
 * deltas -> wire frames), a server bridge (StreamChannel -> HTTP SSE), and a
 * client with auto-reconnect and typed event subscriptions. Also re-exports
 * the core projections so the web app can project without importing
 * @voltojs/core directly and without touching this package's Node-only root.
 */

// Types
export { SSEFrameType } from "./types.js";
export type {
  SSEMessage,
  ConnectionState,
  ErrorData,
  ConnectedData,
  TaggedTranscriptDelta,
} from "./types.js";

// Server
export { createSSEServer } from "./server.js";
export type {
  SSEServerOptions,
  SSEResponse,
  SSERequest,
} from "./server.js";

// Event mapping (transcript events / deltas -> wire frames)
export { createEventMapper, formatSSEFrame } from "./event-mapper.js";
export type { EventMapperOptions } from "./event-mapper.js";

// Client
export { createSSEClient } from "./client.js";
export type {
  SSEClientOptions,
  EventSourceLike,
  EventSourceFactory,
} from "./client.js";

// Re-exported so the web app can project without importing @voltojs/core
// directly and without touching this package's Node-only root entry.
export {
  buildTurnRecords,
  applyPartial,
  toConversationView,
  toTrajectoryView,
  groupConversationBlocks,
} from "@voltojs/core";
export type {
  TurnRecord,
  StepRecord,
  PartialAssistant,
  TranscriptDelta,
  TranscriptEvent,
  TranscriptEventInput,
  ConversationView,
  ConversationMessage,
  ConversationBlock,
  ConversationSegment,
  ConversationToolCall,
  ConversationImage,
  ModelRequestManifest,
  ModelRequestMessage,
  VerificationSummary,
  FileChange,
  TurnUsage,
  RouteSource,
  TrajectoryView,
  TrajectoryRow,
  TodoItem,
  UserMessageSource,
} from "@voltojs/core";
export {
  emptyContextUsageFold,
  foldContextUsageEvent,
  contextUsageView,
  computeContextUsage,
  createCharTokenizer,
  createHeuristicTokenizer,
  emptyContextUsageSnapshot,
  foldSnapshotEvent,
  snapshotView,
  foldStandingTodos,
} from "@voltojs/core";
export type {
  ContextUsageFold,
  ContextUsageHeader,
  ContextUsageAnchor,
  ContextUsageView,
  ContextUsageSnapshot,
  ContextUsageHeaderEstimate,
} from "@voltojs/core";
export { classifyCommandRisk } from "@voltojs/core";
export type { CommandRiskKind } from "@voltojs/core";
export { tokenizeCommand, isMatchableCommandToken } from "@voltojs/core";
export type { ContextReminderKind } from "@voltojs/core";
