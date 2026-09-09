/**
 * Type-level and runtime tests for SSE v2 message types.
 *
 * These tests verify:
 * 1. Runtime enum values match the protocol spec.
 * 2. The frame envelope and remaining data interfaces are structurally correct.
 * 3. Generic SSEMessage<T> typing is sound.
 */

import { describe, it, expect } from "vitest";
import {
  SSEFrameType,
  type SSEMessage,
  type ErrorData,
  type ConnectionState,
  type ConnectedData,
} from "../sse/types.js";

// ---------------------------------------------------------------------------
// SSEFrameType enum
// ---------------------------------------------------------------------------

describe("SSEFrameType enum", () => {
  it("has correct string values for all frame types", () => {
    expect(SSEFrameType.EVENT).toBe("event");
    expect(SSEFrameType.DELTA).toBe("delta");
    expect(SSEFrameType.HEARTBEAT).toBe("heartbeat");
    expect(SSEFrameType.ERROR).toBe("error");
    expect(SSEFrameType.CONNECTED).toBe("connected");
  });

  it("has exactly 5 frame types", () => {
    // CONNECTED added for the once-per-connection approval token (see
    // sessions.ts's `attach` and this file's ConnectedData test below).
    const keys = Object.keys(SSEFrameType) as Array<
      keyof typeof SSEFrameType
    >;
    expect(keys).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// SSEMessage envelope
// ---------------------------------------------------------------------------

describe("SSEMessage", () => {
  it("allows typed messages with a specific data type", () => {
    const msg: SSEMessage<ErrorData> = {
      id: "msg-1",
      event: SSEFrameType.ERROR,
      data: { code: "STREAM_ERROR", message: "boom", retryable: false },
      timestamp: 1700000000000,
    };

    expect(msg.event).toBe(SSEFrameType.ERROR);
    expect(msg.data.code).toBe("STREAM_ERROR");
    expect(msg.data.message).toBe("boom");
    expect(msg.id).toBe("msg-1");
  });

  it("defaults data to unknown", () => {
    const msg: SSEMessage = {
      id: "msg-2",
      event: SSEFrameType.EVENT,
      data: { type: "turn_end" },
      timestamp: 0,
    };
    expect(msg.event).toBe(SSEFrameType.EVENT);
  });

  it("can carry any frame type", () => {
    for (const frameType of Object.values(SSEFrameType)) {
      const msg: SSEMessage = {
        id: `msg-${frameType}`,
        event: frameType,
        data: null,
        timestamp: 0,
      };
      expect(msg.event).toBe(frameType);
    }
  });
});

// ---------------------------------------------------------------------------
// ErrorData
// ---------------------------------------------------------------------------

describe("ErrorData", () => {
  it("has code, message, and retryable fields", () => {
    const data: ErrorData = {
      code: "STREAM_ERROR",
      message: "connection lost",
      retryable: true,
    };
    expect(data.code).toBe("STREAM_ERROR");
    expect(data.message).toBe("connection lost");
    expect(data.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ConnectionState
// ---------------------------------------------------------------------------

describe("ConnectionState", () => {
  it("accepts valid state values", () => {
    const states: ConnectionState[] = ["connecting", "connected", "disconnected"];
    expect(states).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// ConnectedData
// ---------------------------------------------------------------------------

describe("ConnectedData", () => {
  it("carries just the per-connection token", () => {
    const data: ConnectedData = { token: "tok-abc" };
    expect(data.token).toBe("tok-abc");
  });
});

// ---------------------------------------------------------------------------
// Type composition — SSEMessage as a generic envelope
// ---------------------------------------------------------------------------

describe("type composition", () => {
  it("generic envelope preserves data type through assignment", () => {
    const errorMsg: SSEMessage<ErrorData> = {
      id: "e-1",
      event: SSEFrameType.ERROR,
      data: { code: "E1", message: "boom", retryable: false },
      timestamp: 0,
    };
    const eventMsg: SSEMessage<{ type: string; turn: number }> = {
      id: "ev-1",
      event: SSEFrameType.EVENT,
      data: { type: "turn_end", turn: 1 },
      timestamp: 0,
    };

    // Data type is preserved — no casts needed
    expect(errorMsg.data.retryable).toBe(false);
    expect(eventMsg.data.turn).toBe(1);
  });

  it("SSEMessage<unknown> accepts any data payload", () => {
    const msg: SSEMessage = {
      id: "any-1",
      event: SSEFrameType.EVENT,
      data: { foo: "bar" },
      timestamp: 0,
    };
    expect(msg.data).toEqual({ foo: "bar" });
  });

  it("data type parameter enforces shape at assignment site", () => {
    // ErrorData requires code, message, retryable
    const err: SSEMessage<ErrorData> = {
      id: "e",
      event: SSEFrameType.ERROR,
      data: { code: "E1", message: "boom", retryable: false },
      timestamp: 0,
    };
    expect(err.data.retryable).toBe(false);
  });
});
