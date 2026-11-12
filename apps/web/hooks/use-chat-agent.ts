'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  createGatewaySSEClient,
  createSSEClient,
  eventsUrl,
  interruptTurn,
  postMessage,
  type ConnectionState,
} from '@/lib/agent-config';
import { gatewayUrl } from '@/lib/gateway-base';
import { useChatStore } from '@/stores/chat-store';
import { deltaChildId, eventChildId } from '@/lib/subagent-routing';
import { tierNoticeFromEvent } from '@/lib/tier-notice';
import { titleFromSessionMeta } from '@/lib/session-title';
import { fetchSessionEventsTail } from '@/lib/sessions-api';
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

/** One action on a queued (not yet delivered) message — spec D14/D15. */
export type QueuedMessageAction =
  | { kind: 'edit'; content: string }
  | { kind: 'remove' };

/**
 * Outcome of `POST /messages/queue`, mapped off the status code alone:
 * `gone` is the 409 QUEUE_ITEM_GONE (delivered or already gone — the
 * server's "delivery wins" answer), `invalid` the 400 (empty content), and
 * `failed` everything else (500 persist failure, network), carrying the
 * gateway's own message when it sent one.
 */
export type QueueUpdateOutcome =
  | { status: 'ok' }
  | { status: 'gone' }
  | { status: 'invalid' }
  | { status: 'failed'; message: string };

/**
 * Edit or retract one queued message by its steering id.
 *
 * Cookie auth only, mirroring `postMessage` for `POST /messages`: the
 * gateway's global auth guard covers this route the same way (the
 * per-connection approval token is for `POST /approvals`' second gate, which
 * this route does not have). No local state is touched — the caller waits
 * for the `steering_edited` / `steering_removed` receipt to converge the
 * feed, so a stale bubble can never pretend the edit landed.
 */
export async function updateQueue(
  id: string,
  action: QueuedMessageAction,
): Promise<QueueUpdateOutcome> {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!sessionId) {
    return { status: 'failed', message: 'No active session' };
  }
  try {
    const response = await fetch(gatewayUrl('/messages/queue'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, id, action }),
    });
    if (response.ok) return { status: 'ok' };
    if (response.status === 409) return { status: 'gone' };
    if (response.status === 400) return { status: 'invalid' };
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return {
      status: 'failed',
      message: detail?.error ?? `Request failed with HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Queue update failed',
    };
  }
}

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
/**
 * Rebuild a turn that was already running when this connection opened.
 *
 * The gateway's `?tail=1` answers the events after the last `turn_end` plus
 * its live `running` flag. Seeding them restores three things a reload would
 * otherwise lose: the generating state (the composer shows Stop), the
 * assistant `tool_use` batch that a later `tool_result` resolves, and any
 * `steering_queued` entry that should sit in the queue dock.
 *
 * `running` alone is not trusted for the flag: if a `turn_end` already
 * arrived on this connection, the open-turn test below keeps the composer
 * idle instead of pinning it to generating.
 */
async function syncRunningTurn(sessionId: string): Promise<void> {
  const tail = await fetchSessionEventsTail(sessionId).catch(() => null);
  if (tail === null) return;
  const chat = useChatStore.getState();
  if (chat.currentSessionId !== sessionId) return;
  useSessionStore.getState().setSessionRunning(sessionId, tail.running);
  // A settled session needs nothing: its history already comes from the
  // detail endpoint, and seeding a crashed turn's leftover events would only
  // add rows the projection has to dedupe again.
  if (!tail.running) return;
  if (tail.events.length > 0) chat.seedEvents(tail.events);
  const events = useChatStore.getState().events;
  let lastStart = -1;
  let lastEnd = -1;
  events.forEach((event, index) => {
    if (event.type === 'turn_start') lastStart = index;
    else if (event.type === 'turn_end') lastEnd = index;
  });
  if (lastStart > lastEnd) chat.setGenerating(true);
}

export function useChatAgent(): UseChatAgentReturn {
  const t = useTranslations('chat');
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
        // The gateway owns titles: it writes `session_meta` and mirrors the
        // same record onto this channel, so the header and the sidebar follow
        // a rename (derived, model-written, or a second client's) without a
        // reload.
        const title = titleFromSessionMeta(event);
        if (title !== null) {
          useSessionStore.getState().updateSessionTitle(sessionId, title);
        }
        // Tier-fallback frames (routing tiers D5) ride the main feed
        // un-tagged. The raw event stays in the durable buffer above; the
        // user-facing degradation note additionally becomes a trailing
        // session notice that the projection appends after the feed.
        const tierNotice = tierNoticeFromEvent(event, t);
        if (tierNotice) chat.pushNotice(tierNotice);
        if (event.type === 'subagent_started') {
          // The boundary the child runs under rides the started bracket; the
          // sub-agent pane reads it from the bucket (spec 2026-11-11 D7).
          const started = event.data as {
            childSessionId?: string;
            permission?: { sandbox: string; approval: string; preset?: string };
          };
          // The main feed saw the bracket before any of the child's own
          // events, so the bucket may not exist yet — markSubagentStarted
          // creates it.
          if (typeof started.childSessionId === 'string') {
            chat.markSubagentStarted(started.childSessionId, started.permission);
          }
        }
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
        if (event.type === 'turn_end') {
          chat.setGenerating(false);
          useSessionStore.getState().setSessionRunning(sessionId, false);
        } else if (event.type === 'turn_start') {
          chat.setGenerating(true);
          useSessionStore.getState().setSessionRunning(sessionId, true);
        }
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
        useSessionStore.getState().setSessionRunning(sessionId, false);
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
      // A rejected `ready` is surfaced through sendMessage; attaching a no-op
      // catch here keeps it from becoming an unhandled rejection when the
      // promise is only awaited later (or not at all).
      ready.catch(() => {});

      client.connect();
      // A fresh EventSource gets no replay, so a page that reloads mid-turn
      // would otherwise start with an empty buffer: the composer would show
      // idle (no Stop) and a later `tool_result` would have no batch to land
      // in. Rebuild the running turn from the gateway's persisted tail before
      // this connection is considered ready.
      const readyWithTail = ready.then(() => syncRunningTurn(sessionId));
      readyWithTail.catch(() => {});
      connectionRef.current = { sessionId, client, ready: readyWithTail };
      return readyWithTail;
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
      // forever and (since chat-store is a global singleton) pin every
      // session's UI to the generating state, not just this one. Idempotent:
      // a no-op when the turn already finished normally via turn_end.
      useChatStore.getState().cancelStreaming();
    };
  }, [currentSessionId, ensureConnection]);

  const sendMessage = useCallback(
    async (content: string, attachments?: string[]) => {
      // No isGenerating guard: a send during a turn is a steer — the gateway
      // answers 202 and the queued entry folds back through steering_queued.
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
              t('errors.missingBinding'),
          },
        });
        return;
      }

      // A send while a turn streams is a steer: that turn already owns the
      // flag, so this send must not release it on failure — only turn_end
      // (or an interrupt) may. The first-message path owns the flag itself
      // and rolls it back on failure as before.
      const alreadyGenerating = useChatStore.getState().isGenerating;
      useChatStore.getState().setGenerating(true);
      useSessionStore.getState().setSessionRunning(sessionId, true);
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
          error instanceof Error ? error.message : t('errors.sendFailed');
        useChatStore.getState().pushEvent({
          time: Date.now(),
          type: 'error',
          data: { message },
        });
        if (!alreadyGenerating) {
          useChatStore.getState().setGenerating(false);
          useSessionStore.getState().setSessionRunning(sessionId, false);
        }
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
      if (!interrupted) {
        useChatStore.getState().cancelStreaming();
        useSessionStore.getState().setSessionRunning(sessionId, false);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t('errors.interruptFailed');
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
