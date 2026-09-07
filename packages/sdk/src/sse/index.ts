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
  ConversationToolCall,
  TrajectoryView,
  TrajectoryRow,
} from "@volto/core";
export {
  emptyContextUsageFold,
  foldContextUsageEvent,
  contextUsageView,
  computeContextUsage,
  createCharTokenizer,
  createHeuristicTokenizer,
} from "@volto/core";
export type {
  ContextUsageFold,
  ContextUsageHeader,
  ContextUsageAnchor,
  ContextUsageView,
} from "@volto/core";
