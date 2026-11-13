/**
 * EventSink adapters for headless server streaming.
 *
 * `createSseEventSink` writes raw internal events as anonymous `data:` frames.
 * This is the legacy shape, kept for out-of-tree clients built against it —
 * the in-repo hosts that once consumed it have been removed. Clients on the
 * `@voltojs/sdk/sse` protocol (named `event:` frames with monotonic ids) are
 * served by the session registry instead — see `sessions.ts`.
 */

import type { EventSink } from "@voltojs/core";

export function createSseEventSink(res: import("node:http").ServerResponse): EventSink {
  return {
    emit(event: { type: string; data: Record<string, unknown> }): void {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      res.write(frame);
    },
  };
}

export function createWsEventSink(socket: import("ws").WebSocket): EventSink {
  return {
    emit(event: { type: string; data: Record<string, unknown> }): void {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    },
  };
}
