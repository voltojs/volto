/**
 * SSE (Server-Sent Events) protocol layer for @volto/sdk.
 *
 * Provides typed message definitions, a server bridge (StreamChannel -> HTTP SSE),
 * and a client with auto-reconnect and typed event subscriptions.
 */

// Types
export { SSEEventType } from "./types.js";
export type {
  SSEMessage,
  ConnectionState,
  TokenData,
  ToolCallData,
  ToolResultData,
  ApprovalRequestData,
  ApprovalResponseData,
  StateChangeData,
  ErrorData,
} from "./types.js";

// Server
export { createSSEServer } from "./server.js";
export type {
  SSEServerOptions,
  SSEResponse,
  SSERequest,
} from "./server.js";

// Event mapping (internal runner events -> SSE protocol)
export { createEventMapper, formatSSEFrame } from "./event-mapper.js";
export type { InternalEvent, EventMapperOptions } from "./event-mapper.js";

// Client
export { createSSEClient } from "./client.js";
export type {
  SSEClientOptions,
  EventSourceLike,
  EventSourceFactory,
} from "./client.js";
