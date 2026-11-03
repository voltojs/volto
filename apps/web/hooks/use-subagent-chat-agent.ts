'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  createGatewaySSEClient,
  eventsUrl,
  interruptTurn,
  postMessage,
} from '@/lib/agent-config';
import { useChatStore } from '@/stores/chat-store';
import { deltaChildId, eventChildId } from '@/lib/subagent-routing';

export interface SubagentTurnConfig {
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  reasoningEffort?: string;
  permissionMode?: string;
}

type SSEClient = ReturnType<typeof createGatewaySSEClient>;

interface Connection {
  sessionId: string;
  client: SSEClient;
  /** Resolves once the channel is open and ready to carry a turn. */
  ready: Promise<void>;
}

/** How long to wait for the child's SSE channel before giving up on a send. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Hook that drives continued turns on a finished sub-agent session.
 *
 * Transport mirrors useChatAgent: a dedicated SSE channel per child session
 * (`GET /events?sessionId=<child>`) plus a `POST /messages` trigger. Frames
 * are routed into the child's chat-store bucket — tagged frames by their
 * `childSessionId`, untagged ones by the channel's own session id.
 *
 * Generating state is per-child (`subagents[id].isGenerating`) and never
 * touches the global `isGenerating`, which only tracks the main chat turn.
 * It is set on send and released on the child's `turn_end`, on a pre-stream
 * `error` frame, on a failed `postMessage`, and on teardown of this hook's
 * connection while a turn was still generating — `markSubagentFinished`
 * does not clear it.
 */
export function useSubagentChatAgent(options: {
  childSessionId: string | null;
  config: SubagentTurnConfig;
}): {
  sendMessage: (content: string, overrides?: Partial<SubagentTurnConfig>) => Promise<void>;
  stopGeneration: () => Promise<void>;
  isGenerating: boolean;
} {
  const t = useTranslations('chat');
  const { childSessionId, config } = options;
  const connectionRef = useRef<Connection | null>(null);
  // Read the latest config inside callbacks without re-binding them on every
  // parent render (the picker writes config on every keystroke).
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const isGenerating = useChatStore((s) =>
    childSessionId
      ? s.subagents[childSessionId]?.isGenerating === true
      : false,
  );

  // Tear down the channel when the tracked child changes (or on unmount) —
  // one hook instance follows one child, and a stale channel would keep
  // routing frames for the previous one. `client.destroy()` only disconnects
  // and never emits a terminal frame, so without an explicit release the
  // child's `isGenerating` would stay true forever (server turn_end is never
  // received on a dead channel) and remount would refuse every send. Same
  // tradeoff as useChatAgent's cancelStreaming: accept the brief window where
  // the server turn is still finishing after the flag is cleared.
  useEffect(() => {
    return () => {
      const connection = connectionRef.current;
      connectionRef.current = null;
      connection?.client.destroy();
      if (connection === null) return;
      const chat = useChatStore.getState();
      if (chat.subagents[connection.sessionId]?.isGenerating === true) {
        chat.setSubagentGenerating(connection.sessionId, false);
      }
    };
  }, [childSessionId]);

  /**
   * Open (or reuse) the child's SSE channel. A different childSessionId
   * tears the previous one down — one hook instance tracks one child.
   */
  const ensureConnection = useCallback((sessionId: string): Promise<void> => {
    const existing = connectionRef.current;
    if (existing?.sessionId === sessionId) return existing.ready;

    existing?.client.destroy();

    const client = createGatewaySSEClient(eventsUrl(sessionId));

    // Tagged frames belong to whichever child they name (nested sub-agents
    // under this session); untagged ones are this channel's own traffic.
    client.onEvent((event) => {
      const chat = useChatStore.getState();
      const childId = eventChildId(event) ?? sessionId;
      chat.pushSubagentEvent(childId, event);
      // Only this channel's own turn_end releases its generating flag — a
      // nested sub-agent's turn_end on the same stream must not unstick the
      // parent while the parent turn is still running.
      if (event.type === 'turn_end' && childId === sessionId) {
        chat.setSubagentGenerating(sessionId, false);
      }
    });

    client.onDelta((delta) => {
      const chat = useChatStore.getState();
      const childId = deltaChildId(delta) ?? sessionId;
      chat.pushSubagentDelta(childId, delta);
    });

    // Pre-stream failures (config resolution, BUSY, ...) have no turn_end
    // behind them — only onError can both surface the message and unstick
    // the child's generating flag.
    client.onError((data) => {
      const chat = useChatStore.getState();
      const message =
        typeof data.message === 'string' && data.message.length > 0
          ? data.message
          : t('errors.subagentStream');
      chat.pushSubagentEvent(sessionId, {
        time: Date.now(),
        type: 'error',
        data: { message },
      });
      chat.setSubagentGenerating(sessionId, false);
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(t('errors.connectionTimeout')),
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
    // A rejected `ready` is surfaced through sendMessage; this no-op catch
    // keeps it from becoming an unhandled rejection when only awaited later.
    ready.catch(() => {});

    client.connect();
    connectionRef.current = { sessionId, client, ready };
    return ready;
  }, []);

  const sendMessage = useCallback(
    async (content: string, overrides?: Partial<SubagentTurnConfig>) => {
      if (!childSessionId) return;

      const chat = useChatStore.getState();
      // status 'running' = the original sub-agent turn is still in flight.
      if (chat.subagents[childSessionId]?.status === 'running') return;
      // A continued turn is already streaming on this child.
      if (chat.subagents[childSessionId]?.isGenerating) return;

      const cfg = configRef.current;
      if (!cfg.projectId || !cfg.providerId || !cfg.modelId) return;

      // Seed a closed bucket when none exists: ensureBucket's lazy default
      // is status 'running', which would then refuse every later send.
      if (!chat.subagents[childSessionId]) {
        useChatStore.setState({
          subagents: {
            ...chat.subagents,
            [childSessionId]: { events: [], deltas: [], status: 'done' },
          },
        });
      }

      useChatStore.getState().setSubagentGenerating(childSessionId, true);
      try {
        await ensureConnection(childSessionId);
        await postMessage(childSessionId, content, {
          projectId: cfg.projectId,
          providerId: cfg.providerId,
          modelId: overrides?.modelId ?? cfg.modelId,
          permissionMode: overrides?.permissionMode ?? cfg.permissionMode,
          reasoningEffort: overrides?.reasoningEffort ?? cfg.reasoningEffort,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t('errors.sendFailed');
        useChatStore.getState().pushSubagentEvent(childSessionId, {
          time: Date.now(),
          type: 'error',
          data: { message },
        });
        useChatStore.getState().setSubagentGenerating(childSessionId, false);
      }
    },
    [childSessionId, ensureConnection],
  );

  const stopGeneration = useCallback(async () => {
    if (!childSessionId) return;
    try {
      const interrupted = await interruptTurn(childSessionId);
      // On success the server still closes the cancelled turn with its own
      // `turn_end`, which is what releases the flag — releasing it here too
      // would let the next send race the aborted turn. On 409 nothing is
      // running, no turn_end is coming, and this is the only release.
      if (!interrupted) {
        useChatStore.getState().setSubagentGenerating(childSessionId, false);
      }
    } catch {
      // Stale interrupt or network blip: turn_end (or a later send attempt)
      // releases the UI.
    }
  }, [childSessionId]);

  return { sendMessage, stopGeneration, isGenerating };
}
