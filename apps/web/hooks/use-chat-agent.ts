'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import {
  createSSEClient,
  eventsUrl,
  postMessage,
  SSEEventType,
  type ConnectionState,
  type TokenData,
  type ToolCallData,
  type ToolResultData,
  type ErrorData,
} from '@/lib/agent-config';
import { useChatStore, type ToolCall } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';

type SSEClient = ReturnType<typeof createSSEClient>;

interface Connection {
  sessionId: string;
  client: SSEClient;
  /** Resolves once the channel is open and ready to carry a turn. */
  ready: Promise<void>;
}

interface UseChatAgentReturn {
  sendMessage: (content: string) => Promise<void>;
  connectionState: ConnectionState;
}

/** How long to wait for the SSE channel before giving up on a send. */
const CONNECT_TIMEOUT_MS = 10_000;

const newId = () => Math.random().toString(36).substring(2, 11);

/**
 * Hook that drives the agent conversation.
 *
 * Transport is a long-lived SSE channel per chat session (`GET /events`) plus a
 * `POST /messages` trigger — the server streams the turn back over the channel,
 * so tokens, tool calls and tool results render as they happen.
 */
export function useChatAgent(): UseChatAgentReturn {
  const connectionRef = useRef<Connection | null>(null);
  /** Id of the assistant message currently being streamed into. */
  const streamingIdRef = useRef<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected');
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  const finishStreaming = useCallback((updates?: { content?: string }) => {
    const id = streamingIdRef.current;
    if (id) {
      useChatStore.getState().updateMessage(id, {
        ...updates,
        isStreaming: false,
      });
      streamingIdRef.current = null;
    }
    useChatStore.getState().setGenerating(false);
  }, []);

  /**
   * Open (or reuse) the SSE channel for a session. Returns a promise that
   * resolves when the channel is ready to carry a turn.
   */
  const ensureConnection = useCallback(
    (sessionId: string): Promise<void> => {
      const existing = connectionRef.current;
      if (existing?.sessionId === sessionId) return existing.ready;

      existing?.client.destroy();

      const client = createSSEClient(eventsUrl(sessionId));

      client.onStateChange(setConnectionState);

      client.on<TokenData>(SSEEventType.TOKEN, (data) => {
        const id = streamingIdRef.current;
        if (!id) return;
        // `content` is the server-side accumulation, so a dropped or replayed
        // frame cannot desync the rendered text the way appending deltas can.
        useChatStore.getState().updateMessage(id, { content: data.content });
      });

      client.on<ToolCallData>(SSEEventType.TOOL_CALL, (data) => {
        const id = streamingIdRef.current;
        if (!id) return;
        const message = useChatStore
          .getState()
          .messages.find((m) => m.id === id);
        const toolCall: ToolCall = {
          id: data.id,
          name: data.name,
          args: data.args ?? {},
        };
        useChatStore.getState().updateMessage(id, {
          toolCalls: [...(message?.toolCalls ?? []), toolCall],
        });
      });

      client.on<ToolResultData>(SSEEventType.TOOL_RESULT, (data) => {
        const id = streamingIdRef.current;
        if (!id) return;
        const message = useChatStore
          .getState()
          .messages.find((m) => m.id === id);
        if (!message?.toolCalls) return;
        useChatStore.getState().updateMessage(id, {
          toolCalls: message.toolCalls.map((call) =>
            call.id === data.id
              ? { ...call, result: data.result, isError: data.isError }
              : call,
          ),
        });
      });

      client.on<{ content?: string }>(SSEEventType.DONE, (data) => {
        // Trust the server's final accumulation if it sent one.
        finishStreaming(data?.content ? { content: data.content } : undefined);
      });

      client.on<ErrorData>(SSEEventType.ERROR, (data) => {
        const id = streamingIdRef.current;
        const current = id
          ? useChatStore.getState().messages.find((m) => m.id === id)?.content
          : '';
        const notice = `⚠️ ${data.message}`;
        finishStreaming({ content: current ? `${current}\n\n${notice}` : notice });
      });

      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error('连接 agent 服务超时，请确认 headless-server 已启动'));
        }, CONNECT_TIMEOUT_MS);

        const unsubscribe = client.onStateChange((state) => {
          if (state === 'connected') {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
      });
      // A rejected `ready` is surfaced through sendMessage; attaching a no-op
      // catch here keeps it from becoming an unhandled rejection when the
      // promise is only awaited later (or not at all).
      ready.catch(() => {});

      client.connect();
      connectionRef.current = { sessionId, client, ready };
      return ready;
    },
    [finishStreaming],
  );

  // Keep the channel bound to the active session.
  useEffect(() => {
    if (!currentSessionId) return;
    void ensureConnection(currentSessionId).catch(() => {
      // Surfaced on send; nothing to do while merely idling.
    });

    return () => {
      connectionRef.current?.client.destroy();
      connectionRef.current = null;
      setConnectionState('disconnected');
      // Tearing down the channel (session switch or unmount) can happen
      // mid-turn. `client.destroy()` above only disconnects — it never
      // emits DONE/ERROR — so without this, `isGenerating` would stay true
      // forever and (since chat-store is a global singleton) disable the
      // input box in every session, not just this one. Idempotent: a no-op
      // when the turn already finished normally via DONE/ERROR.
      useChatStore.getState().cancelStreaming();
      streamingIdRef.current = null;
    };
  }, [currentSessionId, ensureConnection]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (useChatStore.getState().isGenerating) return;

      const sessionStore = useSessionStore.getState();
      const sessionId = sessionStore.currentSessionId;
      if (!sessionId) {
        // The welcome screen creates the session once a project is chosen;
        // reaching here without one means the UI let a send through too early.
        return;
      }
      const session = sessionStore.sessions.find((s) => s.id === sessionId);

      const assistantId = newId();
      useChatStore.getState().addMessage({
        id: newId(),
        role: 'user',
        content,
        timestamp: Date.now(),
      });
      useChatStore.getState().addMessage({
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      });
      streamingIdRef.current = assistantId;
      useChatStore.getState().setGenerating(true);

      // Attach the new messages to the session synchronously. When this send
      // just created the session, the panel's session-change effect runs right
      // after and reloads messages from the store — without this write it would
      // read an empty session and wipe the turn we just started.
      useSessionStore
        .getState()
        .updateSessionMessages(sessionId, useChatStore.getState().messages);

      try {
        await ensureConnection(sessionId);
        await postMessage(sessionId, content, {
          projectId: session?.projectId ?? null,
          providerId: session?.providerId ?? null,
          modelId: session?.modelId ?? null,
          permissionMode: session?.permissionMode,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '发送失败，请稍后重试';
        finishStreaming({ content: `⚠️ ${message}` });
      }
    },
    [ensureConnection, finishStreaming],
  );

  return { sendMessage, connectionState };
}
