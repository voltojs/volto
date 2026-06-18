/**
 * use-stream.ts
 * 提供流式事件订阅和处理的 React hook
 */

import { useState, useEffect, useCallback, useRef } from "react";

/** Agent 事件类型 */
export interface AgentEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

/** 消息类型 */
export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

/** 工具调用类型 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  duration?: number;
}

/**
 * useStream hook
 * 订阅 agent 的流式事件
 */
export function useStream() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  /** 添加事件 */
  const addEvent = useCallback((event: AgentEvent) => {
    setEvents((prev) => [...prev, event]);

    // 根据事件类型处理消息
    if (event.type === "message") {
      const message = event.data as unknown as Message;
      setMessages((prev) => [...prev, message]);
    } else if (event.type === "tool_call") {
      const toolCall = event.data as unknown as ToolCall;
      setMessages((prev) => {
        const lastMessage = prev[prev.length - 1];
        if (lastMessage && lastMessage.role === "assistant") {
          return [
            ...prev.slice(0, -1),
            {
              ...lastMessage,
              toolCalls: [...(lastMessage.toolCalls ?? []), toolCall],
            },
          ];
        }
        return prev;
      });
    } else if (event.type === "tool_result") {
      const { toolCallId, result, error } = event.data as {
        toolCallId: string;
        result?: unknown;
        error?: string;
      };
      setMessages((prev) => {
        return prev.map((msg) => {
          if (msg.toolCalls) {
            return {
              ...msg,
              toolCalls: msg.toolCalls.map((tc) =>
                tc.id === toolCallId ? { ...tc, result, error } : tc,
              ),
            };
          }
          return msg;
        });
      });
    }
  }, []);

  /** 清除事件 */
  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  /** 清除消息 */
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  /** 订阅事件 */
  useEffect(() => {
    const api = window.electronAPI.agent;
    const unsubscribe = api.onEvent((event: unknown) => {
      const agentEvent = event as AgentEvent;
      addEvent(agentEvent);
    });
    unsubscribeRef.current = unsubscribe;

    return () => {
      unsubscribe();
      unsubscribeRef.current = null;
    };
  }, [addEvent]);

  /** 开始流式输出 */
  const startStreaming = useCallback(() => {
    setIsStreaming(true);
    clearEvents();
  }, [clearEvents]);

  /** 停止流式输出 */
  const stopStreaming = useCallback(() => {
    setIsStreaming(false);
  }, []);

  return {
    events,
    messages,
    isStreaming,
    addEvent,
    clearEvents,
    clearMessages,
    startStreaming,
    stopStreaming,
  };
}
