/**
 * use-stream.ts
 * Subscribes to agent events forwarded from the main process via IPC and
 * writes streaming increments, errors, and tool-call results back into
 * `chat-store`, which `ChatPanel` (a pure consumer of the store) renders.
 *
 * Event vocabulary (task-r6): the runner streams the persisted transcript
 * vocabulary — assistant_message / tool_call / tool_result / model_error /
 * user_message / turn_end ... — plus the raw streaming deltas. The pre-R6 raw
 * events (model_done / tool_use_complete) no longer exist on the wire.
 * Handled here:
 *   - text_delta        → append to the current streaming assistant message (create on demand)
 *   - assistant_message → finalize the current streaming assistant message (raw model_done's role)
 *   - tool_call         → record a tool call on the streaming assistant message (raw tool_use_complete's role)
 *   - tool_result       → backfill result/error/duration onto the matching tool call
 *   - error/model_error → setError + append a system message recording the error
 *   - everything else   → accumulated in `events` for the debug view only
 *
 * `events` is only for the debug view; the UI renders from `chat-store`.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type { AgentEvent } from "@/renderer/src/types/agent";
import {
  useChatStore,
  type Message,
  type ToolCall,
} from "@/renderer/src/stores/chat-store";
import { useDebugStore } from "@/renderer/src/stores/debug-store";

export type { AgentEvent };

/** Read a stable id out of an event's data, generating one if absent. */
function takeId(data: Record<string, unknown>, fallback: string): string {
  const id = data["id"] ?? data["toolCallId"] ?? data["toolUseId"] ?? data["callId"];
  if (typeof id === "string" && id.length > 0) return id;
  return fallback;
}

/** 生成一个轻量 ID（仅 UI 层，不影响内核确定性） */
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * useStream hook
 * Subscribes to agent events and dispatches them into chat-store.
 *
 * Callers are usually a root-level component (e.g. App); multiple mounts
 * would trigger multiple subscriptions, so the app subscribes exactly once.
 */
export function useStream() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  /** Per-session "currently streaming assistant message" id, so concurrent sessions do not clobber each other. */
  const streamingMessageIdsRef = useRef<Map<string, string>>(new Map());

  /** Dispatch one event by type into chat-store; mirror it into debug-store. */
  const handleEvent = useCallback((event: AgentEvent) => {
    setEvents((prev) => [...prev, event]);
    // debug-store is a transient mirror — push before dispatching so the
    // event always lands on the debug timeline even if a dispatch throws.
    useDebugStore.getState().pushEvent(event);

    const sessionId = typeof event.data["sessionId"] === "string" ? (event.data["sessionId"] as string) : null;
    if (!sessionId) return; // events without session context are dropped

    const store = useChatStore.getState();
    if (!store.sessions.has(sessionId)) return; // session deleted — drop

    switch (event.type) {
      case "text_delta": {
        const delta = typeof event.data["text"] === "string" ? (event.data["text"] as string) : "";
        if (!delta) return;
        let msgId = streamingMessageIdsRef.current.get(sessionId);
        if (!msgId) {
          // Open a new streaming assistant message
          msgId = genId("asst");
          streamingMessageIdsRef.current.set(sessionId, msgId);
          const msg: Message = {
            id: msgId,
            role: "assistant",
            content: delta,
            timestamp: event.timestamp,
            isStreaming: true,
          };
          store.addMessage(sessionId, msg);
        } else {
          // Append to the existing streaming message
          const current = store.sessions.get(sessionId)?.messages.find((m) => m.id === msgId);
          const nextContent = (current?.content ?? "") + delta;
          store.updateMessage(sessionId, msgId, { content: nextContent });
        }
        return;
      }

      case "assistant_message": {
        // Each model call's authoritative result — the runner streams the
        // recorded transcript event (task-r6 replaced raw model_done here).
        // Finalize the streaming message built from text_delta.
        const msgId = streamingMessageIdsRef.current.get(sessionId);
        if (msgId) {
          store.updateMessage(sessionId, msgId, { isStreaming: false });
        }
        streamingMessageIdsRef.current.delete(sessionId);
        return;
      }

      case "tool_call": {
        // A fully-assembled tool call recorded by the runner (task-r6
        // replaced raw tool_use_complete here).
        const name = typeof event.data["name"] === "string" ? (event.data["name"] as string) : "unknown";
        const args = (event.data["input"] ?? {}) as Record<string, unknown>;
        const toolCallId = takeId(event.data, genId("tool"));

        let msgId = streamingMessageIdsRef.current.get(sessionId);
        // If no assistant message is streaming yet (e.g. the model emitted a
        // tool call without any text), create a placeholder to hold the call.
        if (!msgId) {
          msgId = genId("asst");
          streamingMessageIdsRef.current.set(sessionId, msgId);
          store.addMessage(sessionId, {
            id: msgId,
            role: "assistant",
            content: "",
            timestamp: event.timestamp,
            isStreaming: true,
          });
        }
        const session = store.sessions.get(sessionId);
        const msg = session?.messages.find((m) => m.id === msgId);
        const newToolCall: ToolCall = { id: toolCallId, name, args };
        const nextToolCalls = [...(msg?.toolCalls ?? []), newToolCall];
        store.updateMessage(sessionId, msgId, { toolCalls: nextToolCalls });
        return;
      }

      case "tool_result": {
        // Transcript-shape result (task-r6): {callId, name?, content,
        // isError, durationMs?, ...} streamed from the runner's own record.
        const toolCallId = takeId(event.data, "");
        if (!toolCallId) return;
        const content = typeof event.data["content"] === "string" ? (event.data["content"] as string) : "";
        const errorVal = event.data["error"];
        const isError = event.data["isError"] === true;
        const durationMs = event.data["durationMs"];
        // Backfill the tool call with this id on whichever message carries it
        const session = store.sessions.get(sessionId);
        if (!session) return;
        for (const m of session.messages) {
          if (!m.toolCalls) continue;
          const tc = m.toolCalls.find((t) => t.id === toolCallId);
          if (!tc) continue;
          const nextToolCalls = m.toolCalls.map((t) =>
            t.id === toolCallId
              ? {
                  ...t,
                  result: content,
                  error: isError ? content : typeof errorVal === "string" ? errorVal : undefined,
                  duration: typeof durationMs === "number" ? durationMs : t.duration,
                }
              : t,
          );
          store.updateMessage(sessionId, m.id, { toolCalls: nextToolCalls });
          return;
        }
        return;
      }

      case "error":
      case "model_error": {
        const errVal = event.data["error"];
        const message =
          typeof errVal === "string"
            ? errVal
            : errVal instanceof Error
              ? errVal.message
              : JSON.stringify(errVal);
        store.setError(message);
        // One model failure is reported twice on the wire (task-r6): the
        // transcript model_error the runner records AND the generic raw
        // `error` echo the reducer emits when it consumes the model_error
        // input. The two carry the same text and arrive back-to-back; headless
        // v2 drops the raw echo at frame(), but the desktop sinks events
        // directly, so collapse the duplicate here instead of rendering two
        // system rows. A genuinely distinct error (a later, differently-worded
        // failure, or a manager-level error with its own text) still renders.
        const session = store.sessions.get(sessionId);
        const last = session?.messages[session.messages.length - 1];
        const rowText = `错误: ${message}`;
        if (!(last?.role === "system" && last.content === rowText)) {
          store.addMessage(sessionId, {
            id: genId("err"),
            role: "system",
            content: rowText,
            timestamp: event.timestamp,
          });
        }
        // Close any streaming flag left dangling by the failure
        const msgId = streamingMessageIdsRef.current.get(sessionId);
        if (msgId) store.updateMessage(sessionId, msgId, { isStreaming: false });
        streamingMessageIdsRef.current.delete(sessionId);
        return;
      }

      // Any other event only feeds the debug event stream — it never touches
      // the rendered chat.
      case "user_message":
      case "reasoning_delta":
      case "cancelled":
      case "steering_queued":
      case "budget_exceeded":
      case "model_retry":
      default:
        return;
    }
  }, []);

  /** Subscribe to IPC events once for the app's whole lifetime. */
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.agent) return;
    const api = window.electronAPI.agent;
    const unsubscribe = api.onEvent((event: AgentEvent) => {
      handleEvent(event);
    });
    unsubscribeRef.current = unsubscribe;

    return () => {
      unsubscribe();
      unsubscribeRef.current = null;
    };
  }, [handleEvent]);

  /** Clear the debug events. */
  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, clearEvents };
}
