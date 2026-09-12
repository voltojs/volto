/**
 * SSE Client unit tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSSEClient } from "../client.js";
import type { EventSourceLike, EventSourceFactory } from "../client.js";

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

/** Mutable mock that captures all created instances for test control. */
function createMockEventSource(): EventSourceLike & {
  /** Trigger the open callback. */
  emitOpen(): void;
  /** Trigger a named SSE frame. */
  emitEvent(type: string, data: unknown, lastEventId?: string): void;
  /** Trigger the error callback. */
  emitError(): void;
  /** Raw listener map for direct event injection in tests. */
  _listeners: Map<string, Array<(event: MessageEvent) => void>>;
} {
  const instance: EventSourceLike & {
    emitOpen(): void;
    emitEvent(type: string, data: unknown): void;
    emitError(): void;
    _listeners: Map<string, Array<(event: MessageEvent) => void>>;
    _open: (() => void) | null;
    _message: ((event: MessageEvent) => void) | null;
    _error: (() => void) | null;
    _closed: boolean;
  } = {
    readyState: 0,
    _listeners: new Map(),
    _open: null,
    _message: null,
    _error: null,
    _closed: false,

    get onopen() {
      return this._open;
    },
    set onopen(fn) {
      this._open = fn;
    },
    get onmessage() {
      return this._message;
    },
    set onmessage(fn) {
      this._message = fn;
    },
    get onerror() {
      return this._error;
    },
    set onerror(fn) {
      this._error = fn;
    },

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const list = this._listeners.get(type) ?? [];
      list.push(listener);
      this._listeners.set(type, list);
    },

    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      const list = this._listeners.get(type);
      if (list) {
        const idx = list.indexOf(listener);
        if (idx >= 0) list.splice(idx, 1);
      }
    },

    close() {
      this._closed = true;
      this.readyState = 2;
    },

    emitOpen() {
      this.readyState = 1;
      this._open?.();
    },

    emitEvent(type: string, data: unknown, lastEventId?: string) {
      const event = new MessageEvent(type, {
        data: JSON.stringify(data),
        lastEventId: lastEventId ?? "",
      });
      // Fire named listeners
      for (const listener of this._listeners.get(type) ?? []) {
        listener(event);
      }
      // Also fire onmessage (browser SSE behavior)
      if (type === "message") {
        this._message?.(event);
      }
    },

    emitError() {
      this._error?.();
    },
  };

  return instance;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** An authoritative transcript event payload. */
const USER_EVENT = {
  time: 100,
  type: "user_message",
  data: { content: "hi" },
  turn: 1,
};

/** A streaming increment payload. */
const TEXT_DELTA = { kind: "text", text: "hi" };

/** A transport-level error frame payload. */
const ERROR_DATA = {
  code: "STREAM_ERROR",
  message: "Missing projectId",
  retryable: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSEClient", () => {
  let instances: ReturnType<typeof createMockEventSource>[];

  beforeEach(() => {
    instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createClient(url = "http://localhost:3000/sse", opts?: Parameters<typeof createSSEClient>[1]) {
    const client = createSSEClient(url, opts);
    const factory: EventSourceFactory = () => {
      const mock = createMockEventSource();
      instances.push(mock);
      return mock;
    };
    client.setEventSourceFactory(factory);
    return client;
  }

  describe("connect / disconnect", () => {
    it("should transition through connecting -> connected on open", () => {
      const client = createClient();
      const states: string[] = [];
      client.onStateChange((s: string) => states.push(s));

      client.connect();
      expect(client.getState()).toBe("connecting");

      instances[0]!.emitOpen();
      expect(client.getState()).toBe("connected");
      expect(states).toEqual(["connecting", "connected"]);

      client.disconnect();
      expect(client.getState()).toBe("disconnected");
    });

    it("should not connect if already connected", () => {
      const client = createClient();
      client.connect();
      instances[0]!.emitOpen();

      client.connect(); // second call should be a no-op
      expect(instances.length).toBe(1);

      client.disconnect();
    });

    it("should reset reconnect attempts on successful open", () => {
      const client = createClient("http://localhost:3000/sse", {
        reconnectDelay: 100,
        maxReconnectAttempts: 3,
      });

      client.connect();
      instances[0]!.emitOpen();
      expect(client.getState()).toBe("connected");

      // Trigger error -> reconnect cycle
      instances[0]!.emitError();
      expect(client.getState()).toBe("disconnected");

      vi.advanceTimersByTime(100);
      expect(instances.length).toBe(2);

      // Open the reconnected instance — resets counter
      instances[1]!.emitOpen();
      expect(client.getState()).toBe("connected");

      client.disconnect();
    });

    it("should reset lastEventId on disconnect", () => {
      const client = createClient();
      client.connect();
      instances[0]!.emitOpen();
      instances[0]!.emitEvent("event", USER_EVENT, "3");

      // The client tracks lastEventId internally; disconnect should clear it
      client.disconnect();
      expect(client.getLastEventId()).toBe("");
    });
  });

  describe("event and delta subscriptions", () => {
    it("should deliver authoritative event frames to onEvent subscribers", () => {
      const client = createClient();
      const handler = vi.fn();

      client.onEvent(handler);
      client.connect();
      instances[0]!.emitOpen();

      instances[0]!.emitEvent("event", USER_EVENT);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(USER_EVENT);

      client.disconnect();
    });

    it("should deliver streaming deltas to onDelta subscribers", () => {
      const client = createClient();
      const handler = vi.fn();

      client.onDelta(handler);
      client.connect();
      instances[0]!.emitOpen();

      instances[0]!.emitEvent("delta", TEXT_DELTA);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(TEXT_DELTA);

      client.disconnect();
    });

    it("should deliver tagged deltas with routing metadata to onDelta subscribers", () => {
      const client = createClient();
      const handler = vi.fn();

      client.onDelta(handler);
      client.connect();
      instances[0]!.emitOpen();

      const TAGGED_DELTA = { kind: "text", text: "hi", agentDepth: 1, childSessionId: "s-sub-0" };
      instances[0]!.emitEvent("delta", TAGGED_DELTA);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(TAGGED_DELTA);
      expect(handler.mock.calls[0]![0]).toMatchObject({
        agentDepth: 1,
        childSessionId: "s-sub-0",
      });

      client.disconnect();
    });

    it("should support multiple subscribers for the same frame kind", () => {
      const client = createClient();
      const h1 = vi.fn();
      const h2 = vi.fn();

      client.onEvent(h1);
      client.onEvent(h2);
      client.connect();
      instances[0]!.emitOpen();

      instances[0]!.emitEvent("event", USER_EVENT);

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);

      client.disconnect();
    });

    it("should unsubscribe correctly", () => {
      const client = createClient();
      const eventHandler = vi.fn();
      const deltaHandler = vi.fn();

      const unsubEvent = client.onEvent(eventHandler);
      const unsubDelta = client.onDelta(deltaHandler);
      client.connect();
      instances[0]!.emitOpen();

      instances[0]!.emitEvent("event", USER_EVENT);
      instances[0]!.emitEvent("delta", TEXT_DELTA);
      expect(eventHandler).toHaveBeenCalledTimes(1);
      expect(deltaHandler).toHaveBeenCalledTimes(1);

      unsubEvent();
      unsubDelta();
      instances[0]!.emitEvent("event", USER_EVENT);
      instances[0]!.emitEvent("delta", TEXT_DELTA);
      expect(eventHandler).toHaveBeenCalledTimes(1); // no additional call
      expect(deltaHandler).toHaveBeenCalledTimes(1); // no additional call

      client.disconnect();
    });

    it("should ignore frames with unparseable JSON data", () => {
      const client = createClient();
      const handler = vi.fn();

      client.onEvent(handler);
      client.connect();
      instances[0]!.emitOpen();

      // Create a MessageEvent with raw non-JSON data directly
      const badEvent = new MessageEvent("event", { data: "not-valid-json" });
      for (const listener of instances[0]!._listeners.get("event") ?? []) {
        listener(badEvent);
      }

      expect(handler).not.toHaveBeenCalled();

      client.disconnect();
    });
  });

  describe("connection token", () => {
    it("is null before the CONNECTED frame arrives", () => {
      const client = createClient();
      client.connect();
      instances[0]!.emitOpen();

      expect(client.getConnectionToken()).toBeNull();

      client.disconnect();
    });

    it("captures the token from the CONNECTED frame", () => {
      const client = createClient();
      client.connect();
      instances[0]!.emitOpen();

      instances[0]!.emitEvent("connected", { token: "tok-abc" });

      expect(client.getConnectionToken()).toBe("tok-abc");

      client.disconnect();
    });

    it("clears the token on disconnect", () => {
      const client = createClient();
      client.connect();
      instances[0]!.emitOpen();
      instances[0]!.emitEvent("connected", { token: "tok-abc" });

      client.disconnect();

      expect(client.getConnectionToken()).toBeNull();
    });

    it("clears the token on a connection error, before any reconnect delivers a new one", () => {
      const client = createClient("http://localhost:3000/sse", {
        reconnectDelay: 100,
        maxReconnectAttempts: 3,
      });
      client.connect();
      instances[0]!.emitOpen();
      instances[0]!.emitEvent("connected", { token: "tok-abc" });
      expect(client.getConnectionToken()).toBe("tok-abc");

      instances[0]!.emitError();
      expect(client.getConnectionToken()).toBeNull();

      client.disconnect();
    });
  });

  describe("error subscriptions", () => {
    it("should deliver error frames to onError subscribers but not onEvent/onDelta", () => {
      const client = createClient();
      const errorHandler = vi.fn();
      const eventHandler = vi.fn();
      const deltaHandler = vi.fn();

      client.onError(errorHandler);
      client.onEvent(eventHandler);
      client.onDelta(deltaHandler);
      client.connect();
      instances[0]!.emitOpen();

      instances[0]!.emitEvent("error", ERROR_DATA);

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler).toHaveBeenCalledWith(ERROR_DATA);
      expect(errorHandler.mock.calls[0]![0]).toMatchObject({
        code: "STREAM_ERROR",
        message: "Missing projectId",
        retryable: false,
      });
      // Error frames never leak into the payload channels.
      expect(eventHandler).not.toHaveBeenCalled();
      expect(deltaHandler).not.toHaveBeenCalled();

      client.disconnect();
    });

    it("should unsubscribe onError handlers correctly", () => {
      const client = createClient();
      const errorHandler = vi.fn();

      const unsub = client.onError(errorHandler);
      client.connect();
      instances[0]!.emitOpen();

      instances[0]!.emitEvent("error", ERROR_DATA);
      expect(errorHandler).toHaveBeenCalledTimes(1);

      unsub();
      instances[0]!.emitEvent("error", ERROR_DATA);
      expect(errorHandler).toHaveBeenCalledTimes(1); // no additional call

      client.disconnect();
    });
  });

  describe("auto-reconnect", () => {
    it("should reconnect with exponential back-off", () => {
      const client = createClient("http://localhost:3000/sse", {
        reconnectDelay: 100,
        maxReconnectDelay: 5000,
        maxReconnectAttempts: 5,
      });

      client.connect();
      instances[0]!.emitOpen();

      // First error -> reconnect after 100ms
      instances[0]!.emitError();
      expect(client.getState()).toBe("disconnected");
      expect(instances.length).toBe(1);

      vi.advanceTimersByTime(100);
      expect(instances.length).toBe(2);

      // Second error -> reconnect after 200ms (exponential)
      instances[1]!.emitError();
      vi.advanceTimersByTime(200);
      expect(instances.length).toBe(3);

      // Third error -> reconnect after 400ms
      instances[2]!.emitError();
      vi.advanceTimersByTime(400);
      expect(instances.length).toBe(4);

      client.disconnect();
    });

    it("should cap reconnect delay at maxReconnectDelay", () => {
      const client = createClient("http://localhost:3000/sse", {
        reconnectDelay: 1000,
        maxReconnectDelay: 3000,
        maxReconnectAttempts: 10,
      });

      client.connect();
      instances[0]!.emitOpen();

      // After enough retries, delay should cap at 3000
      // attempt 0 -> 1000, attempt 1 -> 2000, attempt 2 -> 3000 (capped)
      for (let i = 0; i < 3; i++) {
        instances[i]!.emitError();
        vi.advanceTimersByTime(3000); // always enough
      }

      // Should have attempted 4 connections total (initial + 3 retries)
      expect(instances.length).toBe(4);

      client.disconnect();
    });

    it("should stop reconnecting after maxReconnectAttempts", () => {
      // maxReconnectAttempts=2 means up to 2 reconnection attempts after initial connect
      const client = createClient("http://localhost:3000/sse", {
        reconnectDelay: 10,
        maxReconnectAttempts: 2,
      });

      client.connect();
      instances[0]!.emitOpen();

      // First retry (reconnectAttempts 0 -> 1)
      instances[0]!.emitError();
      vi.advanceTimersByTime(10);
      expect(instances.length).toBe(2);

      // Second retry (reconnectAttempts 1 -> 2)
      instances[1]!.emitError();
      vi.advanceTimersByTime(20);
      expect(instances.length).toBe(3);

      // Third failure — should NOT retry (reconnectAttempts=2 >= maxReconnectAttempts=2)
      instances[2]!.emitError();
      vi.advanceTimersByTime(100);
      expect(instances.length).toBe(3);

      client.disconnect();
    });

    it("should not reconnect when autoReconnect is false", () => {
      const client = createClient("http://localhost:3000/sse", {
        autoReconnect: false,
      });

      client.connect();
      instances[0]!.emitOpen();

      instances[0]!.emitError();
      vi.advanceTimersByTime(10000);
      expect(instances.length).toBe(1);
      expect(client.getState()).toBe("disconnected");

      client.disconnect();
    });
  });

  describe("state change notifications", () => {
    it("should notify state listeners on state transitions", () => {
      const client = createClient();
      const changes: string[] = [];
      client.onStateChange((s: string) => changes.push(s));

      client.connect();
      expect(changes).toEqual(["connecting"]);

      instances[0]!.emitOpen();
      expect(changes).toEqual(["connecting", "connected"]);

      client.disconnect();
      expect(changes).toEqual(["connecting", "connected", "disconnected"]);
    });

    it("should unsubscribe state listeners", () => {
      const client = createClient();
      const changes: string[] = [];
      const unsub = client.onStateChange((s: string) => changes.push(s));

      client.connect();
      expect(changes).toEqual(["connecting"]);

      unsub();

      instances[0]!.emitOpen();
      client.disconnect();

      // No additional state changes after unsubscribe
      expect(changes).toEqual(["connecting"]);
    });
  });

  describe("destroy", () => {
    it("should disconnect and clear all listeners", () => {
      const client = createClient();
      const eventHandler = vi.fn();
      const deltaHandler = vi.fn();
      const stateHandler = vi.fn();

      client.onEvent(eventHandler);
      client.onDelta(deltaHandler);
      client.onStateChange(stateHandler);

      client.connect();
      instances[0]!.emitOpen();

      client.destroy();

      // After destroy, emitting frames should not call handlers
      instances[0]!.emitEvent("event", USER_EVENT);
      instances[0]!.emitEvent("delta", TEXT_DELTA);
      expect(eventHandler).not.toHaveBeenCalled();
      expect(deltaHandler).not.toHaveBeenCalled();
      expect(client.getState()).toBe("disconnected");
    });
  });

  describe("Last-Event-ID", () => {
    it("should track the last event ID from received frames", () => {
      const client = createClient();
      client.connect();
      instances[0]!.emitOpen();

      instances[0]!.emitEvent("event", USER_EVENT, "42");

      // lastEventId is tracked internally and appended as query param on reconnect
      expect(client.getLastEventId()).toBe("42");

      client.disconnect();
    });

    it("should append lastEventId as query param on reconnect", () => {
      const factoryUrls: string[] = [];
      const client = createSSEClient("http://localhost:3000/sse", {
        reconnectDelay: 100,
        maxReconnectAttempts: 3,
      });
      client.setEventSourceFactory((u: string) => {
        factoryUrls.push(u);
        const mock = createMockEventSource();
        instances.push(mock);
        return mock;
      });

      client.connect();
      expect(factoryUrls[0]).toBe("http://localhost:3000/sse");

      instances[0]!.emitOpen();

      // Simulate receiving a frame with id "5"
      instances[0]!.emitEvent("event", USER_EVENT, "5");

      // Disconnect and wait for reconnect
      instances[0]!.emitError();
      vi.advanceTimersByTime(100);

      expect(instances.length).toBe(2);
      // Verify the reconnect URL contains the lastEventId
      expect(factoryUrls[1]).toContain("last-event-id=5");

      client.disconnect();
    });
  });
});
