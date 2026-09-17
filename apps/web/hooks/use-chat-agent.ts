'use client';

import { useEffect, useRef, useCallback } from 'react';
import {
  createGatewaySSEClient,
  createSSEClient,
  eventsUrl,
  interruptTurn,
  postMessage,
  type ConnectionState,
} from '@/lib/agent-config';
import { useChatStore } from '@/stores/chat-store';
import { deltaChildId, eventChildId } from '@/lib/subagent-routing';
import { useSessionStore } from '@/stores/session-store';

type SSEClient = ReturnType<typeof createSSEClient>;

interface Connection {
  sessionId: string;
  client: SSEClient;
  /** Resolves once the channel is open and ready to carry a turn. */
  ready: Promise<void>;
}

interface UseChatAgentReturn {
  /**
   * `attachments` carries server-side attachment ids staged by
   * `POST /attachments`; they travel with the message body so the gateway
   * can resolve them into image blocks.
   */
  sendMessage: (content: string, attachments?: string[]) => Promise<void>;
  /** Cancels the turn currently streaming, if any. */
  stopGeneration: () => Promise<void>;
  connectionState: ConnectionState;
  /**
   * The current session's per-connection approval token, or null before the
   * channel has delivered one (or when there is no active connection). The
   * gateway's `POST /approvals` requires this — see lib/agent-config.ts's
   * `postApproval`.
   */
  getApprovalToken: () => string | null;
}

/** How long to wait for the SSE channel before giving up on a send. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Hook that drives the agent conversation.
 *
 * Transport is a long-lived SSE channel per chat session (`GET /events`) plus
 * a `POST /messages` trigger — the server streams the turn back over the
 * channel. Authoritative transcript events land on `onEvent`, streaming
 * increments on `onDelta`, and pre-stream `error` frames on `onError`; all
 * are forwarded into the chat store — main-conversation frames into the
 * shared buffers, tagged sub-agent frames into their per-childSessionId
 * buckets (lib/subagent-routing.ts).
 * Message assembly no longer happens here — the projection
 * (lib/projection.ts) derives the chat feed from the buffered events and
 * deltas, and the server echoes the user's own message back as a
 * `user_message` event, so nothing is optimistically added on send.
 */
export function useChatAgent(): UseChatAgentReturn {
  const connectionRef = useRef<Connection | null>(null);
  // 连接状态入全局 store：Sidebar 底部的状态指示与 ChatPanel 共读一份。
  const connectionState = useChatStore((s) => s.connectionState);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  /**
   * Open (or reuse) the SSE channel for a session. Returns a promise that
   * resolves when the channel is ready to carry a turn.
   */
  const ensureConnection = useCallback(
    (sessionId: string): Promise<void> => {
      const existing = connectionRef.current;
      if (existing?.sessionId === sessionId) return existing.ready;

      existing?.client.destroy();

      // Cookie auth: the EventSource must carry credentials, same as fetch.
      const client = createGatewaySSEClient(eventsUrl(sessionId));

      client.onStateChange((state) => useChatStore.getState().setConnectionState(state));

      // Sub-agent frames (agentDepth > 0) are routed into their per-child
      // buckets and never touch the main buffers — a tagged flood therefore
      // cannot pollute or freeze the conversation feed. Depth-0 traffic,
      // including the subagent_started/subagent_finished brackets, stays on
      // the main feed; the finish bracket additionally closes the child's
      // bucket. Untagged depth>0 frames (refreshed ring buffer, old server)
      // still leave the main feed — they land in the UNTAGGED_BUCKET.
      client.onEvent((event) => {
        const chat = useChatStore.getState();
        const childId = eventChildId(event);
        if (childId) {
          chat.pushSubagentEvent(childId, event);
          return;
        }
        chat.pushEvent(event);
        if (event.type === 'subagent_finished') {
          const data = event.data as {
            childSessionId?: string;
            isError?: boolean;
            durationMs?: number;
          };
          if (typeof data.childSessionId === 'string') {
            chat.markSubagentFinished(
              data.childSessionId,
              data.isError === true,
              data.durationMs,
            );
          }
        }
        if (event.type === 'turn_end') chat.setGenerating(false);
      });

      client.onDelta((delta) => {
        const chat = useChatStore.getState();
        const childId = deltaChildId(delta);
        if (childId) chat.pushSubagentDelta(childId, delta);
        else chat.pushDelta(delta);
      });

      // Protocol `error` frames (pre-stream failures: config resolution,
      // BUSY, ...) have no turn_end behind them, so only the onError channel
      // can both surface the failure and release the input box. Reuses the
      // round-level error-notice rendering that composeChatEntries already
      // provides for local error events — no extra UI needed.
      client.onError((data) => {
        useChatStore.getState().pushEvent({
          time: Date.now(),
          type: 'error',
          data: { message: data.message },
        });
        useChatStore.getState().setGenerating(false);
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
    [],
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
      useChatStore.getState().setConnectionState('disconnected');
      // Tearing down the channel (session switch or unmount) can happen
      // mid-turn. `client.destroy()` above only disconnects — it never emits
      // a terminal frame — so without this, `isGenerating` would stay true
      // forever and (since chat-store is a global singleton) disable the
      // input box in every session, not just this one. Idempotent: a no-op
      // when the turn already finished normally via turn_end.
      useChatStore.getState().cancelStreaming();
    };
  }, [currentSessionId, ensureConnection]);

  const sendMessage = useCallback(
    async (content: string, attachments?: string[]) => {
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
        // A session's project/provider/model binding can be null (e.g. the
        // project or model it referenced was later removed). Dispatching
        // anyway would let the gateway silently fall back to its own
        // process cwd and env-configured model instead of erroring — the
        // exact fallback resolveConfig on the server now rejects. Surface a
        // local error event instead of sending.
        useChatStore.getState().pushEvent({
          time: Date.now(),
          type: 'error',
          data: {
            message:
              '⚠️ 此会话缺少绑定的项目或模型，无法发送消息。请新建会话并完成选择。',
          },
        });
        return;
      }

      useChatStore.getState().setGenerating(true);
      // No optimistic copy of the user message: the server echoes it back as
      // a user_message event on the channel.

      try {
        await ensureConnection(sessionId);
        await postMessage(
          sessionId,
          content,
          {
            projectId: session?.projectId ?? null,
            providerId: session?.providerId ?? null,
            modelId: session?.modelId ?? null,
            permissionMode: session?.permissionMode,
            // The session is the single source of truth for the tier: the
            // picker writes it there, and omitting it here silently ran every
            // turn at the provider's own default no matter what the user chose.
            reasoningEffort: session?.reasoningEffort,
          },
          attachments,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '发送失败，请稍后重试';
        useChatStore.getState().pushEvent({
          time: Date.now(),
          type: 'error',
          data: { message },
        });
        useChatStore.getState().setGenerating(false);
      }
    },
    [ensureConnection],
  );

  const stopGeneration = useCallback(async () => {
    const sessionId = useSessionStore.getState().currentSessionId;
    if (!sessionId || !useChatStore.getState().isGenerating) return;

    try {
      const interrupted = await interruptTurn(sessionId);
      // On success `isGenerating` is deliberately left alone: the server
      // still closes the cancelled turn with a `turn_end`, and that event is
      // what releases the input — releasing it here as well would let the
      // user send the next message while the aborted turn is still unwinding.
      // When the server had nothing running, though, no `turn_end` is ever
      // coming, so this is the only place that can unstick the UI.
      if (!interrupted) useChatStore.getState().cancelStreaming();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '中断失败，请稍后重试';
      useChatStore.getState().pushEvent({
        time: Date.now(),
        type: 'error',
        data: { message },
      });
    }
  }, []);

  const getApprovalToken = useCallback((): string | null => {
    return connectionRef.current?.client.getConnectionToken() ?? null;
  }, []);

  return { sendMessage, stopGeneration, connectionState, getApprovalToken };
}
