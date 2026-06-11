/**
 * EventSink adapters for headless server streaming.
 * Converts internal EventSink.emit() to SSE frames and WebSocket messages.
 */

import type { EventSink } from "@agent-core/core";

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
