/**
 * EventSink adapters for headless server streaming.
 *
 * `createSseEventSink` writes raw internal events as anonymous `data:` frames.
 * This is the legacy shape consumed by `apps/ide-extension` and
 * `apps/chat-adapter`, kept for backwards compatibility. Clients on the
 * `@volto/sdk/sse` protocol (named `event:` frames with monotonic ids) are
 * served by the session registry instead — see `sessions.ts`.
 */

import type { EventSink } from "@volto/core";

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
