/**
 * SSE (Server-Sent Events) protocol layer for @volto/sdk.
 *
 * Provides typed frame definitions, an event mapper (transcript events and
 * deltas -> wire frames), a server bridge (StreamChannel -> HTTP SSE), and a
 * client with auto-reconnect and typed event subscriptions. Also re-exports
 * the core projections so the web app can project without importing
 * @volto/core directly and without touching this package's Node-only root.
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

// Re-exported so the web app can project without importing @volto/core
// directly and without touching this package's Node-only root entry.
export {
  buildTurnRecords,
  applyPartial,
  toConversationView,
  toTrajectoryView,
  groupConversationBlocks,
} from "@volto/core";
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
  VerificationSummary,
  FileChange,
  TurnUsage,
  RouteSource,
  TrajectoryView,
  TrajectoryRow,
  TodoItem,
  UserMessageSource,
} from "@volto/core";
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
} from "@volto/core";
export type {
  ContextUsageFold,
  ContextUsageHeader,
  ContextUsageAnchor,
  ContextUsageView,
  ContextUsageSnapshot,
  ContextUsageHeaderEstimate,
} from "@volto/core";
export { classifyCommandRisk } from "@volto/core";
export type { CommandRiskKind } from "@volto/core";
export { tokenizeCommand, isMatchableCommandToken } from "@volto/core";
export type { ContextReminderKind } from "@volto/core";
