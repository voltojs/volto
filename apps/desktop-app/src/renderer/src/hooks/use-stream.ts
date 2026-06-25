/**
 * use-stream.ts
 * 订阅主进程通过 IPC 转发的 agent 事件，把流式增量、错误、工具调用结果
 * 写回 `chat-store`，让 `ChatPanel` 这种纯消费 store 的组件能渲染出来。
 *
 * 处理的事件类型（来源：packages/core/src/reducer.ts）：
 *   - text_delta          → 追加到当前 assistant 流消息（不存在则新建）
 *   - model_done          → 标记当前流消息结束，清 streaming 标志
 *   - error               → setError + 追加一条 system 消息记录错误
 *   - tool_use_complete   → 在当前 assistant 流消息上记一个 toolCall（args 暂留空）
 *   - tool_result (来自 displayMetadata.pendingEvents) → 把 result/error 回填到对应 toolCall
 *   - reasoning_delta / cancelled / steering_queued / budget_exceeded / model_retry → 仅累计到 events 用于调试
 *
 * `events` 流仅用于 debug 视图；UI 渲染只读 `chat-store`。
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

/** 从事件 data 中取一个稳定 id，没有就生成一个 */
function takeId(data: Record<string, unknown>, fallback: string): string {
  const id = data["id"] ?? data["toolCallId"] ?? data["toolUseId"];
  if (typeof id === "string" && id.length > 0) return id;
  return fallback;
}

/** 生成一个轻量 ID（仅 UI 层，不影响内核确定性） */
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * useStream hook
 * 订阅 agent 事件并 dispatch 到 chat-store。
 *
 * 调用者通常是一个 root-level 组件（如 App）；多个挂载点会触发多份订阅，
 * 因此整个应用只允许调用一次。
 */
export function useStream() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  /**
   * 当前正在累计的 assistant 流消息 id。
   * 用 ref 而不是 store 状态，是为了在事件回调里同步读到最新值；
   * 由 `model_done` 事件清空。
   */
  const streamingMessageIdRef = useRef<string | null>(null);

  /** 把事件按类型分发到 chat-store；同时镜像到 debug-store 供调试视图使用 */
  const handleEvent = useCallback((event: AgentEvent) => {
    setEvents((prev) => [...prev, event]);
    // debug-store 是瞬态镜像，先 push 再 dispatch 到业务 store，确保即使后续逻辑
    // 抛错（虽然这里不会），事件本身一定能进入调试时间轴
    useDebugStore.getState().pushEvent(event);

    const store = useChatStore.getState();
    const sessionId = store.currentSessionId;
    if (!sessionId) return; // 没有当前会话，丢弃（不应发生：UI 在第一条消息时已 createSession）

    switch (event.type) {
      case "text_delta": {
        const delta = typeof event.data["text"] === "string" ? (event.data["text"] as string) : "";
        if (!delta) return;
        let msgId = streamingMessageIdRef.current;
        if (!msgId) {
          // 新开一条 assistant streaming 消息
          msgId = genId("asst");
          streamingMessageIdRef.current = msgId;
          const msg: Message = {
            id: msgId,
            role: "assistant",
            content: delta,
            timestamp: event.timestamp,
            isStreaming: true,
          };
          store.addMessage(sessionId, msg);
        } else {
          // 追加到既有 streaming 消息
          const current = store.sessions.get(sessionId)?.messages.find((m) => m.id === msgId);
          const nextContent = (current?.content ?? "") + delta;
          store.updateMessage(sessionId, msgId, { content: nextContent });
        }
        return;
      }

      case "model_done": {
        const msgId = streamingMessageIdRef.current;
        if (msgId) {
          store.updateMessage(sessionId, msgId, { isStreaming: false });
        }
        streamingMessageIdRef.current = null;
        return;
      }

      case "tool_use_complete": {
        const name = typeof event.data["name"] === "string" ? (event.data["name"] as string) : "unknown";
        const args = (event.data["args"] ?? {}) as Record<string, unknown>;
        const toolCallId = takeId(event.data, genId("tool"));

        let msgId = streamingMessageIdRef.current;
        // 若 assistant 流消息尚未创建（例如模型直接 emit tool_use 而无 text），先建一条占位
        if (!msgId) {
          msgId = genId("asst");
          streamingMessageIdRef.current = msgId;
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
        const toolCallId = takeId(event.data, "");
        if (!toolCallId) return;
        const result = event.data["result"];
        const errorVal = event.data["error"];
        const durationMs = event.data["durationMs"];
        // 在所有消息里找带该 toolCallId 的 toolCall 并回填
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
                  result,
                  error: typeof errorVal === "string" ? errorVal : undefined,
                  duration: typeof durationMs === "number" ? durationMs : t.duration,
                }
              : t,
          );
          store.updateMessage(sessionId, m.id, { toolCalls: nextToolCalls });
          return;
        }
        return;
      }

      case "error": {
        const errVal = event.data["error"];
        const message =
          typeof errVal === "string"
            ? errVal
            : errVal instanceof Error
              ? errVal.message
              : JSON.stringify(errVal);
        store.setError(message);
        store.addMessage(sessionId, {
          id: genId("err"),
          role: "system",
          content: `错误: ${message}`,
          timestamp: event.timestamp,
        });
        // 出错后关闭可能挂着的 streaming 标志
        const msgId = streamingMessageIdRef.current;
        if (msgId) store.updateMessage(sessionId, msgId, { isStreaming: false });
        streamingMessageIdRef.current = null;
        return;
      }

      // 其它事件仅累计到 events 流，不影响 UI 渲染
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

  /** 订阅 IPC 事件，整个 app 生命周期保持一份订阅 */
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

  /** 清除调试事件 */
  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, clearEvents };
}
