/**
 * Type-level and runtime tests for SSE message types.
 *
 * These tests verify:
 * 1. Runtime enum values match the protocol spec.
 * 2. All data interfaces are structurally correct.
 * 3. TypeScript type narrowing works as expected.
 * 4. Generic SSEMessage<T> typing is sound.
 */

import { describe, it, expect } from "vitest";
import {
  SSEEventType,
  type SSEMessage,
  type TokenData,
  type ToolCallData,
  type ToolResultData,
  type ApprovalRequestData,
  type ApprovalResponseData,
  type StateChangeData,
  type ErrorData,
  type ConnectionState,
} from "../sse/types.js";

// ---------------------------------------------------------------------------
// SSEEventType enum
// ---------------------------------------------------------------------------

describe("SSEEventType enum", () => {
  it("has correct string values for all event types", () => {
    expect(SSEEventType.TOKEN).toBe("token");
    expect(SSEEventType.TOOL_CALL).toBe("tool_call");
    expect(SSEEventType.TOOL_RESULT).toBe("tool_result");
    expect(SSEEventType.APPROVAL_REQ).toBe("approval_req");
    expect(SSEEventType.APPROVAL_RES).toBe("approval_res");
    expect(SSEEventType.STATE_CHANGE).toBe("state_change");
    expect(SSEEventType.ERROR).toBe("error");
    expect(SSEEventType.HEARTBEAT).toBe("heartbeat");
    expect(SSEEventType.DONE).toBe("done");
  });

  it("has exactly 9 event types", () => {
    const keys = Object.keys(SSEEventType) as Array<
      keyof typeof SSEEventType
    >;
    expect(keys).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// SSEMessage envelope
// ---------------------------------------------------------------------------

describe("SSEMessage", () => {
  it("allows typed messages with a specific data type", () => {
    const msg: SSEMessage<TokenData> = {
      id: "msg-1",
      event: SSEEventType.TOKEN,
      data: { content: "hello world", delta: "w" },
      timestamp: 1700000000000,
    };

    expect(msg.event).toBe(SSEEventType.TOKEN);
    expect(msg.data.delta).toBe("w");
    expect(msg.data.content).toBe("hello world");
    expect(msg.id).toBe("msg-1");
  });

  it("defaults data to unknown", () => {
    const msg: SSEMessage = {
      id: "msg-2",
      event: SSEEventType.DONE,
      data: {},
      timestamp: 0,
    };
    expect(msg.event).toBe(SSEEventType.DONE);
  });

  it("can carry any event type", () => {
    for (const eventType of Object.values(SSEEventType)) {
      const msg: SSEMessage = {
        id: `msg-${eventType}`,
        event: eventType,
        data: null,
        timestamp: 0,
      };
      expect(msg.event).toBe(eventType);
    }
  });
});

// ---------------------------------------------------------------------------
// TokenData
// ---------------------------------------------------------------------------

describe("TokenData", () => {
  it("has content and delta fields", () => {
    const data: TokenData = { content: "Hello, ", delta: "Hello, " };
    expect(data.content).toBe("Hello, ");
    expect(data.delta).toBe("Hello, ");
  });
});

// ---------------------------------------------------------------------------
// ToolCallData
// ---------------------------------------------------------------------------

describe("ToolCallData", () => {
  it("has id, name, and args fields", () => {
    const data: ToolCallData = {
      id: "call-1",
      name: "read_file",
      args: { path: "/tmp/test.txt" },
    };
    expect(data.id).toBe("call-1");
    expect(data.name).toBe("read_file");
    expect(data.args["path"]).toBe("/tmp/test.txt");
  });
});

// ---------------------------------------------------------------------------
// ToolResultData
// ---------------------------------------------------------------------------

describe("ToolResultData", () => {
  it("has id, result, and isError fields", () => {
    const success: ToolResultData = {
      id: "call-1",
      result: { content: "file content" },
      isError: false,
    };
    expect(success.isError).toBe(false);

    const error: ToolResultData = {
      id: "call-2",
      result: { error: "not found" },
      isError: true,
    };
    expect(error.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ApprovalRequestData
// ---------------------------------------------------------------------------

describe("ApprovalRequestData", () => {
  it("has id, call, risk, and prompt fields", () => {
    const data: ApprovalRequestData = {
      id: "approval-1",
      call: { id: "call-1", name: "shell", args: { command: "rm -rf /" } },
      risk: "high",
      prompt: "Execute a destructive shell command?",
    };
    expect(data.risk).toBe("high");
    expect(data.call.name).toBe("shell");
  });

  it("restricts risk to low | medium | high", () => {
    const risks: Array<ApprovalRequestData["risk"]> = [
      "low",
      "medium",
      "high",
    ];
    expect(risks).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// ApprovalResponseData
// ---------------------------------------------------------------------------

describe("ApprovalResponseData", () => {
  it("has id and decision fields", () => {
    const allow: ApprovalResponseData = {
      id: "approval-1",
      decision: "allow",
    };
    expect(allow.decision).toBe("allow");

    const deny: ApprovalResponseData = {
      id: "approval-2",
      decision: "deny",
    };
    expect(deny.decision).toBe("deny");
  });

  it("restricts decision to allow | deny", () => {
    const decisions: Array<ApprovalResponseData["decision"]> = [
      "allow",
      "deny",
    ];
    expect(decisions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// StateChangeData
// ---------------------------------------------------------------------------

describe("StateChangeData", () => {
  it("has state and previous fields", () => {
    const data: StateChangeData = { state: "running", previous: "idle" };
    expect(data.state).toBe("running");
    expect(data.previous).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// ErrorData
// ---------------------------------------------------------------------------

describe("ErrorData", () => {
  it("has code, message, and retryable fields", () => {
    const data: ErrorData = {
      code: "RATE_LIMIT",
      message: "Too many requests",
      retryable: true,
    };
    expect(data.code).toBe("RATE_LIMIT");
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
// Type composition — SSEMessage as a generic envelope
// ---------------------------------------------------------------------------

describe("type composition", () => {
  it("generic envelope preserves data type through assignment", () => {
    const tokenMsg: SSEMessage<TokenData> = {
      id: "t-1",
      event: SSEEventType.TOKEN,
      data: { content: "full", delta: "f" },
      timestamp: 0,
    };
    const toolCallMsg: SSEMessage<ToolCallData> = {
      id: "tc-1",
      event: SSEEventType.TOOL_CALL,
      data: { id: "call-1", name: "ls", args: {} },
      timestamp: 0,
    };

    // Data type is preserved — no casts needed
    expect(tokenMsg.data.delta).toBe("f");
    expect(toolCallMsg.data.name).toBe("ls");
    expect(toolCallMsg.data.args["foo"]).toBeUndefined();
  });

  it("SSEMessage<unknown> accepts any data payload", () => {
    const msg: SSEMessage = {
      id: "any-1",
      event: SSEEventType.STATE_CHANGE,
      data: { foo: "bar" },
      timestamp: 0,
    };
    expect(msg.data).toEqual({ foo: "bar" });
  });

  it("data type parameter enforces shape at assignment site", () => {
    // TokenData requires content and delta
    const token: SSEMessage<TokenData> = {
      id: "x",
      event: SSEEventType.TOKEN,
      data: { content: "c", delta: "d" },
      timestamp: 0,
    };
    expect(typeof token.data.content).toBe("string");
    expect(typeof token.data.delta).toBe("string");

    // ErrorData requires code, message, retryable
    const err: SSEMessage<ErrorData> = {
      id: "e",
      event: SSEEventType.ERROR,
      data: { code: "E1", message: "boom", retryable: false },
      timestamp: 0,
    };
    expect(err.data.retryable).toBe(false);
  });
});
