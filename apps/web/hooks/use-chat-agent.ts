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
  /**
   * How much of the turn's cumulative text (the `content` a TOKEN/DONE event
   * carries) belongs to already-closed text blocks — everything up to and
   * including the segment that ended at the last tool call. Reset to 0 each
   * time a new streaming message starts. Without this, every TOKEN event
   * would overwrite the message's single `content` field and every tool
   * call would land in a flat side array, losing which text came before or
   * after which tool call.
   */
  const frozenTextLengthRef = useRef(0);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected');
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  /**
   * Applies the turn's cumulative text: keeps `content` as the full text for
   * copy-to-clipboard, and writes only the portion since the last tool call
   * into the trailing (currently open) text block.
   */
  const applyAccumulatedText = useCallback((id: string, fullContent: string) => {
    const newText = fullContent.slice(frozenTextLengthRef.current);
    useChatStore.getState().updateMessage(id, { content: fullContent });
    useChatStore.getState().setLastTextBlock(id, newText);
  }, []);

  const finishStreaming = useCallback(() => {
    const id = streamingIdRef.current;
    if (id) {
      useChatStore.getState().updateMessage(id, { isStreaming: false });
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
        applyAccumulatedText(id, data.content);
      });

      client.on<ToolCallData>(SSEEventType.TOOL_CALL, (data) => {
        const id = streamingIdRef.current;
        if (!id) return;
        // Close off whatever text block was open — this tool call happened
        // after it, so later text must start a new block rather than
        // continuing to append onto text that came before the call.
        const message = useChatStore
          .getState()
          .messages.find((m) => m.id === id);
        const lastBlock = message?.blocks?.[message.blocks.length - 1];
        if (lastBlock?.type === 'text') {
          frozenTextLengthRef.current += lastBlock.text.length;
        }
        const toolCall: ToolCall = {
          id: data.id,
          name: data.name,
          args: data.args ?? {},
        };
        useChatStore.getState().pushToolCallBlock(id, toolCall);
      });

      client.on<ToolResultData>(SSEEventType.TOOL_RESULT, (data) => {
        const id = streamingIdRef.current;
        if (!id) return;
        useChatStore.getState().updateToolCallBlock(id, data.id, {
          result: data.result,
          isError: data.isError,
        });
      });

      client.on<{ content?: string }>(SSEEventType.DONE, (data) => {
        // Trust the server's final accumulation if it sent one.
        const id = streamingIdRef.current;
        if (id && data?.content) applyAccumulatedText(id, data.content);
        finishStreaming();
      });

      client.on<ErrorData>(SSEEventType.ERROR, (data) => {
        const id = streamingIdRef.current;
        const notice = `⚠️ ${data.message}`;
        if (id) {
          const current =
            useChatStore.getState().messages.find((m) => m.id === id)
              ?.content ?? '';
          applyAccumulatedText(id, current ? `${current}\n\n${notice}` : notice);
        }
        finishStreaming();
      });

      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(
            new Error('连接 agent 服务超时，请确认 headless-server 已启动'),
          );
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
    [finishStreaming, applyAccumulatedText],
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
      if (!session?.projectId || !session.providerId || !session.modelId) {
        // A session persisted before project-binding shipped can have these
        // fields as null (see migrate() in session-store.ts). Dispatching
        // anyway would let the gateway silently fall back to its own
        // process cwd and env-configured model instead of erroring — the
        // exact fallback resolveConfig on the server now rejects. Guard
        // here too (the conversation-branch InputBar only disables on
        // isGenerating) so the user gets an explanation instead of the
        // agent silently running against the wrong directory/model.
        useChatStore.getState().addMessage({
          id: newId(),
          role: 'assistant',
          content:
            '⚠️ 此会话缺少绑定的项目或模型，无法发送消息。请新建会话并完成选择。',
          timestamp: Date.now(),
        });
        return;
      }

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
      frozenTextLengthRef.current = 0;
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
        applyAccumulatedText(assistantId, `⚠️ ${message}`);
        finishStreaming();
      }
    },
    [ensureConnection, finishStreaming, applyAccumulatedText],
  );

  return { sendMessage, connectionState };
}
