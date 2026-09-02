/**
 * Chat store tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore, type Message } from "../stores/chat-store.js";

function resetStore(): void {
  useChatStore.setState({
    messages: [],
    isGenerating: false,
    currentSessionId: null,
  });
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    role: "user",
    content: "Hello",
    timestamp: 1000,
    ...overrides,
  };
}

describe("useChatStore", () => {
  beforeEach(() => {
    resetStore();
  });

  // -----------------------------------------------------------------------
  // addMessage
  // -----------------------------------------------------------------------

  describe("addMessage", () => {
    it("should append a message to the list", () => {
      const msg = makeMessage();
      useChatStore.getState().addMessage(msg);

      const { messages } = useChatStore.getState();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(msg);
    });

    it("should append multiple messages in order", () => {
      const first = makeMessage({ id: "msg-1", content: "first" });
      const second = makeMessage({ id: "msg-2", content: "second" });

      useChatStore.getState().addMessage(first);
      useChatStore.getState().addMessage(second);

      const { messages } = useChatStore.getState();
      expect(messages).toHaveLength(2);
      expect(messages[0]?.id).toBe("msg-1");
      expect(messages[1]?.id).toBe("msg-2");
    });
  });

  // -----------------------------------------------------------------------
  // updateMessage
  // -----------------------------------------------------------------------

  describe("updateMessage", () => {
    it("should update a message by id", () => {
      useChatStore.getState().addMessage(makeMessage({ id: "msg-1", content: "old" }));

      useChatStore.getState().updateMessage("msg-1", { content: "new" });

      const { messages } = useChatStore.getState();
      expect(messages[0]?.content).toBe("new");
    });

    it("should not affect other messages", () => {
      useChatStore.getState().addMessage(makeMessage({ id: "msg-1", content: "a" }));
      useChatStore.getState().addMessage(makeMessage({ id: "msg-2", content: "b" }));

      useChatStore.getState().updateMessage("msg-1", { content: "updated" });

      const { messages } = useChatStore.getState();
      expect(messages[0]?.content).toBe("updated");
      expect(messages[1]?.content).toBe("b");
    });

    it("should be a no-op when id does not match", () => {
      useChatStore.getState().addMessage(makeMessage({ id: "msg-1" }));

      useChatStore.getState().updateMessage("nonexistent", { content: "x" });

      const { messages } = useChatStore.getState();
      expect(messages[0]?.content).toBe("Hello");
    });
  });

  // -----------------------------------------------------------------------
  // appendToMessage
  // -----------------------------------------------------------------------

  describe("appendToMessage", () => {
    it("should append delta text to matching message", () => {
      useChatStore.getState().addMessage(makeMessage({ id: "msg-1", content: "Hello" }));

      useChatStore.getState().appendToMessage("msg-1", " world");

      const { messages } = useChatStore.getState();
      expect(messages[0]?.content).toBe("Hello world");
    });

    it("should handle multiple appends", () => {
      useChatStore.getState().addMessage(makeMessage({ id: "msg-1", content: "" }));

      useChatStore.getState().appendToMessage("msg-1", "A");
      useChatStore.getState().appendToMessage("msg-1", "B");
      useChatStore.getState().appendToMessage("msg-1", "C");

      const { messages } = useChatStore.getState();
      expect(messages[0]?.content).toBe("ABC");
    });

    it("should be a no-op when id does not match", () => {
      useChatStore.getState().addMessage(makeMessage({ id: "msg-1", content: "original" }));

      useChatStore.getState().appendToMessage("nonexistent", " extra");

      const { messages } = useChatStore.getState();
      expect(messages[0]?.content).toBe("original");
    });
  });

  // -----------------------------------------------------------------------
  // clearMessages
  // -----------------------------------------------------------------------

  describe("clearMessages", () => {
    it("should empty the messages array", () => {
      useChatStore.getState().addMessage(makeMessage({ id: "msg-1" }));
      useChatStore.getState().addMessage(makeMessage({ id: "msg-2" }));

      useChatStore.getState().clearMessages();

      expect(useChatStore.getState().messages).toHaveLength(0);
    });

    it("should be safe to call on empty list", () => {
      expect(() => useChatStore.getState().clearMessages()).not.toThrow();
      expect(useChatStore.getState().messages).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // setGenerating / setSessionId
  // -----------------------------------------------------------------------

  describe("setGenerating", () => {
    it("should toggle isGenerating to true", () => {
      useChatStore.getState().setGenerating(true);
      expect(useChatStore.getState().isGenerating).toBe(true);
    });

    it("should toggle isGenerating back to false", () => {
      useChatStore.getState().setGenerating(true);
      useChatStore.getState().setGenerating(false);
      expect(useChatStore.getState().isGenerating).toBe(false);
    });
  });

  describe("setSessionId", () => {
    it("should set a session id", () => {
      useChatStore.getState().setSessionId("sess-abc");
      expect(useChatStore.getState().currentSessionId).toBe("sess-abc");
    });

    it("should clear session id with null", () => {
      useChatStore.getState().setSessionId("sess-abc");
      useChatStore.getState().setSessionId(null);
      expect(useChatStore.getState().currentSessionId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // cancelStreaming (F1) — tearing down the SSE channel mid-turn (e.g.
  // switching sessions while tokens are still arriving) must not leave
  // isGenerating stuck true forever, which would disable every session's
  // input box since this store is a global singleton.
  // ---------------------------------------------------------------------

  describe("cancelStreaming", () => {
    it("clears isGenerating", () => {
      useChatStore.getState().setGenerating(true);
      useChatStore.getState().cancelStreaming();
      expect(useChatStore.getState().isGenerating).toBe(false);
    });

    it("clears isStreaming on the in-flight assistant message", () => {
      useChatStore.getState().addMessage(
        makeMessage({ id: "msg-1", role: "assistant", content: "partial", isStreaming: true }),
      );
      useChatStore.getState().setGenerating(true);

      useChatStore.getState().cancelStreaming();

      const { messages, isGenerating } = useChatStore.getState();
      expect(isGenerating).toBe(false);
      expect(messages[0]?.isStreaming).toBe(false);
      // Content already received is preserved rather than discarded.
      expect(messages[0]?.content).toBe("partial");
    });

    it("leaves other messages untouched", () => {
      useChatStore.getState().addMessage(makeMessage({ id: "msg-1", content: "done", isStreaming: false }));
      useChatStore.getState().addMessage(
        makeMessage({ id: "msg-2", role: "assistant", content: "partial", isStreaming: true }),
      );

      useChatStore.getState().cancelStreaming();

      const { messages } = useChatStore.getState();
      expect(messages[0]).toEqual(makeMessage({ id: "msg-1", content: "done", isStreaming: false }));
      expect(messages[1]?.isStreaming).toBe(false);
    });

    it("is a no-op when no turn is in flight (idempotent, e.g. after a normal DONE already cleared state)", () => {
      useChatStore.getState().addMessage(makeMessage({ id: "msg-1", content: "final", isStreaming: false }));
      useChatStore.getState().setGenerating(false);

      expect(() => useChatStore.getState().cancelStreaming()).not.toThrow();

      const { messages, isGenerating } = useChatStore.getState();
      expect(isGenerating).toBe(false);
      expect(messages[0]?.content).toBe("final");
    });
  });
});
