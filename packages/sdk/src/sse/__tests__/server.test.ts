/**
 * SSE Server unit tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSSEServer } from "../server.js";
import type { SSEResponse, SSERequest } from "../server.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock SSEResponse for capturing written data. */
function createMockResponse(): SSEResponse & { written: string[] } {
  const written: string[] = [];
  const closeListeners: Array<() => void> = [];

  return {
    written,
    write(data: string) {
      written.push(data);
      return true;
    },
    end() {
      for (const listener of closeListeners) {
        listener();
      }
    },
    on(event: "close", listener: () => void) {
      if (event === "close") {
        closeListeners.push(listener);
      }
    },
  };
}

/** Create a mock StreamChannel from a fixed list of events. */
function createChannel(
  events: Array<{ type: string; data: Record<string, unknown> }>
) {
  return {
    eventSink: { emit: () => {} },
    done: () => {},
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    events() {
      return this[Symbol.asyncIterator]();
    },
  };
}

/** Check if written data contains a specific SSE event type line. */
function hasEvent(written: string[], eventType: string): boolean {
  return written.some((w: string) => w.includes(`event: ${eventType}`));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE Server", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("handleRequest", () => {
    it("should write SSE headers", () => {
      const server = createSSEServer();
      const res = createMockResponse();
      const req: SSERequest = { headers: {} };
      const channel = createChannel([]);

      server.handleRequest(req, res, channel);

      const joined = res.written.join("");
      expect(joined).toContain("Content-Type: text/event-stream");
      expect(joined).toContain("Cache-Control: no-cache");
      expect(joined).toContain("Connection: keep-alive");
    });

    it("should send heartbeat messages at configured interval", async () => {
      const server = createSSEServer({ heartbeatInterval: 1000 });
      const res = createMockResponse();
      const req: SSERequest = { headers: {} };
      const channel = createChannel([]);

      server.handleRequest(req, res, channel);

      // Before interval elapses — no heartbeat yet
      expect(hasEvent(res.written, "heartbeat")).toBe(false);

      // Advance timer by 1 second
      vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(10);

      expect(hasEvent(res.written, "heartbeat")).toBe(true);
    });

    it("should frame channel events verbatim as authoritative EVENT frames", async () => {
      const server = createSSEServer();
      const res = createMockResponse();
      const req: SSERequest = { headers: {} };
      const channel = createChannel([
        { type: "text_delta", data: { text: "hello" } },
        {
          type: "tool_use_complete",
          data: { toolCallId: "call-1", toolName: "fs_read" },
        },
      ]);

      server.handleRequest(req, res, channel);
      await vi.advanceTimersByTimeAsync(50);

      const joined = res.written.join("");
      // Every channel event rides an `event` frame with its payload untouched —
      // the transcript-level type lives inside the data.
      expect(joined).toContain("event: event");
      expect(joined).toContain('"text":"hello"');
      expect(joined).toContain('"toolCallId":"call-1"');
      // No v1 per-type frames remain on the wire.
      expect(hasEvent(res.written, "token")).toBe(false);
      expect(hasEvent(res.written, "tool_call")).toBe(false);
    });

    it("should end the stream without a terminal frame", async () => {
      const server = createSSEServer();
      const res = createMockResponse();
      const req: SSERequest = { headers: {} };
      const channel = createChannel([
        { type: "text_delta", data: { text: "hi" } },
      ]);

      server.handleRequest(req, res, channel);
      await vi.advanceTimersByTimeAsync(50);

      // Protocol v2 has no DONE frame — completion is a transcript event.
      expect(hasEvent(res.written, "done")).toBe(false);
    });

    it("should send ERROR event when stream throws", async () => {
      const server = createSSEServer();
      const res = createMockResponse();
      const req: SSERequest = { headers: {} };

      const errorChannel = {
        eventSink: { emit: () => {} },
        done: () => {},
        events() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  return Promise.reject(new Error("stream failed"));
                },
                return() {
                  return Promise.resolve({ done: true, value: undefined });
                },
              };
            },
          };
        },
      };

      server.handleRequest(req, res, errorChannel as never);
      await vi.advanceTimersByTimeAsync(50);

      expect(hasEvent(res.written, "error")).toBe(true);
      expect(res.written.some((w: string) => w.includes("STREAM_ERROR"))).toBe(true);
    });
  });

  describe("replayMissedEvents", () => {
    it("should replay events with ID greater than Last-Event-ID", async () => {
      const server = createSSEServer();

      // First connection — send 3 events
      const res1 = createMockResponse();
      const channel1 = createChannel([
        { type: "text_delta", data: { text: "a" } },
        { type: "text_delta", data: { text: "b" } },
        { type: "text_delta", data: { text: "c" } },
      ]);
      server.handleRequest({ headers: {} }, res1, channel1);
      await vi.advanceTimersByTimeAsync(50);

      // Extract all event IDs from the first connection's output
      const allIds: number[] = res1.written
        .filter((w: string) => w.startsWith("id:"))
        .map((w: string) => parseInt(w.replace("id:", "").trim(), 10))
        .filter((id: number) => !isNaN(id));

      expect(allIds.length).toBeGreaterThanOrEqual(3);

      // Reconnect with Last-Event-ID = second event ID
      const secondId = allIds[1]!;
      const res2 = createMockResponse();
      const channel2 = createChannel([]); // No new events
      server.handleRequest(
        { headers: { "last-event-id": String(secondId) } },
        res2,
        channel2
      );
      await vi.advanceTimersByTimeAsync(50);

      // Count replayed events (excluding any heartbeat frames)
      const replayedIds: number[] = res2.written
        .filter((w: string) => w.startsWith("id:"))
        .map((w: string) => parseInt(w.replace("id:", "").trim(), 10))
        .filter((id: number) => !isNaN(id));

      // Should have replayed events with ID > secondId
      const missedIds = replayedIds.filter((id: number) => id > secondId);
      expect(missedIds.length).toBeGreaterThanOrEqual(1);
    });

    it("should ignore invalid Last-Event-ID", () => {
      const server = createSSEServer();
      const res = createMockResponse();
      const channel = createChannel([]);

      expect(() =>
        server.handleRequest(
          { headers: { "last-event-id": "invalid-id" } },
          res,
          channel
        )
      ).not.toThrow();
    });
  });

  describe("cleanupExpiredEvents", () => {
    it("should remove events older than recovery window", async () => {
      const server = createSSEServer({ recoveryWindow: 1000 });

      // First connection — send "old" event
      const res1 = createMockResponse();
      const channel1 = createChannel([
        { type: "text_delta", data: { text: "old" } },
      ]);
      server.handleRequest({ headers: {} }, res1, channel1);
      await vi.advanceTimersByTimeAsync(50);

      // Advance time past recovery window
      vi.advanceTimersByTime(1500);

      // Second connection — send "new" event
      const res2 = createMockResponse();
      const channel2 = createChannel([
        { type: "text_delta", data: { text: "new" } },
      ]);
      server.handleRequest({ headers: {} }, res2, channel2);
      await vi.advanceTimersByTimeAsync(50);

      // Cleanup old events
      server.cleanupExpiredEvents();

      // Third connection — replay from ID 0, only "new" should appear
      const res3 = createMockResponse();
      const channel3 = createChannel([]);
      server.handleRequest(
        { headers: { "last-event-id": "0" } },
        res3,
        channel3
      );
      await vi.advanceTimersByTimeAsync(50);

      const allWritten = res3.written.join("");
      const hasOld = allWritten.includes('"old"');
      const hasNew = allWritten.includes('"new"');

      expect(hasOld).toBe(false);
      expect(hasNew).toBe(true);
    });
  });

  describe("client disconnect", () => {
    it("should stop heartbeat when client disconnects", async () => {
      const server = createSSEServer({ heartbeatInterval: 1000 });
      const res = createMockResponse();
      const channel = createChannel([]);

      server.handleRequest({ headers: {} }, res, channel);

      // Let one heartbeat fire, then disconnect
      vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(10);

      const countAfterFirstHeartbeat = res.written.length;
      expect(countAfterFirstHeartbeat).toBeGreaterThan(5); // headers + heartbeat

      // Disconnect
      res.end();

      // Advance a long time — no more heartbeats
      vi.advanceTimersByTime(10000);
      await vi.advanceTimersByTimeAsync(10);

      expect(res.written.length).toBe(countAfterFirstHeartbeat);
    });
  });
});
