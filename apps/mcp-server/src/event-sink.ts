/**
 * EventSink adapter for MCP server.
 * Converts internal EventSink.emit() to MCP notifications.
 */

import type { EventSink } from "@agent-core/core";

export function createMcpEventSink(
  notify: (notification: string, params: Record<string, unknown>) => void,
): EventSink {
  return {
    emit(event: { type: string; data: Record<string, unknown> }): void {
      notify("notifications/progress", {
        progressToken: event.type,
        progress: 1,
        total: 1,
        ...event.data,
      });
    },
  };
}
