'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { ConversationMessage } from '@volto/sdk/sse';
import {
  fetchServerSessions,
  fetchServerSessionDetail,
  SessionDetailUnavailableError,
  type ServerSessionSummary,
} from '@/lib/sessions-api';
import {
  useSessionStore,
  type PermissionMode,
  type Session,
} from '@/stores/session-store';

/**
 * In-flight detail fetches, keyed by session id. Concurrent callers share one
 * request; the entry is dropped when it settles so a failed fetch can be
 * retried.
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * The server sends `permissionMode` as a bare string; narrow it defensively
 * rather than casting, so a value outside the union can't flow into the
 * store (and from there into gateway requests) unchecked. Transcripts
 * persisted before the redesign carry the retired names, which are accepted
 * here on the read path only — they are never sent back. Mirrors the
 * gateway's twin (permission-modes.ts LEGACY_ALIASES): `plan` is NOT a
 * legacy name — it is a first-class preset, and mapping it to read-only
 * here downgraded the badge of every plan session reloaded from the server.
 */
const LEGACY_PERMISSION_MODES: Record<string, PermissionMode> = {
  'auto-accept': 'auto',
};

export function normalisePermissionMode(mode: string | null): PermissionMode {
  if (
    mode === 'read-only' ||
    mode === 'plan' ||
    mode === 'ask' ||
    mode === 'auto' ||
    mode === 'full'
  ) {
    return mode;
  }
  // Object.hasOwn, not a bare index: a plain object literal inherits
  // Object.prototype, so `LEGACY_PERMISSION_MODES['constructor']` is truthy
  // and would return the Object constructor instead of falling back to 'ask'.
  // The gateway's twin of this function shipped that bug (Task 3, fixed in
  // review) — do not reintroduce it here.
  if (mode !== null && Object.hasOwn(LEGACY_PERMISSION_MODES, mode)) {
    return LEGACY_PERMISSION_MODES[mode]!;
  }
  return 'ask';
}

/**
 * True when a stored feed still carries a queued entry. Such a snapshot was
 * taken while a steering message was undelivered; delivery, edits and
 * retractions that happen while the session is not attached reach this
 * client as no live events at all, so the `queued: true` copy can never
 * clear itself. The caller must replace it with the server's copy once.
 *
 * Inspects the stored snapshot only, never a merged feed: the detail
 * response's `queuedMessages` seed is not part of `Session.messages`, so
 * re-reading it here would keep this true and loop.
 */
export function needsQueueResync(
  messages: readonly ConversationMessage[],
): boolean {
  return messages.some((m) => (m as { queued?: boolean }).queued === true);
}

/**
 * Fetches one session's messages and context-usage seed, unless they are
 * already in memory. The response is applied even if the user has switched
 * away in the meantime — the data belongs to that session, not to the view.
 *
 * `opts.force` bypasses the `detailLoaded` early return only — used to
 * replace a stored snapshot the server has since moved past (see
 * `needsQueueResync`). The in-flight dedupe still applies: a forced call
 * that lands while a request is already running joins that request.
 *
 * A failure (network/HTTP error, or a 404 meaning the transcript is gone) is
 * recorded on the session as a retryable `detailError` rather than left as a
 * silent, permanent skeleton. Non-404 failures also reject the returned
 * promise so callers don't need to poll the store to notice.
 */
export async function ensureSessionDetail(
  id: string,
  t: (key: string, params?: Record<string, string | number>) => string = (key) => key,
  opts: { force?: boolean } = {},
): Promise<void> {
  const known = useSessionStore.getState().sessions.find((s) => s.id === id);
  if (known?.detailLoaded && !opts.force) return;

  const existing = inFlight.get(id);
  if (existing) return existing;

  const request = (async () => {
    let detail;
    try {
      detail = await fetchServerSessionDetail(id);
    } catch (error) {
      // A legacy-format transcript (410) gets its own copy and no generic
      // "HTTP 410" prefix — ChatPanel also uses `detailErrorKind` to suppress
      // the retry button for this case, since retrying can never succeed.
      if (error instanceof SessionDetailUnavailableError && error.kind === 'legacy') {
        useSessionStore
          .getState()
          .setSessionDetailError(id, t('errors.legacySession'), 'legacy');
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      useSessionStore
        .getState()
        .setSessionDetailError(id, t('errors.sessionLoadFailed', { message }), 'network');
      throw error;
    }
    if (!detail) {
      // The transcript is gone server-side (deleted out of band, or a stale
      // link) — a permanently silent skeleton would be worse than an
      // explicit, retryable error notice.
      useSessionStore
        .getState()
        .setSessionDetailError(id, t('errors.sessionMissing'));
      return;
    }
    useSessionStore.getState().applySessionDetail(id, {
      messages: detail.messages,
      contextUsage: detail.contextUsage,
      todos: detail.todos ?? null,
      queuedMessages: detail.queuedMessages,
      projectId: detail.projectId,
      providerId: detail.providerId,
      modelId: detail.modelId,
      permissionMode: normalisePermissionMode(detail.permissionMode),
    });
  })().finally(() => {
    inFlight.delete(id);
  });

  inFlight.set(id, request);
  return request;
}

/**
 * Local sessions to keep once the server's summary list replaces the store's
 * list: anything the server doesn't know about yet. Presence in `summaries`
 * is the only test — a session that already has messages locally (written by
 * `use-conversation`'s session-switch flush, which moves the outgoing
 * session's live feed into the store — there is no debounce anymore) before
 * a list request that started before the session existed comes back is
 * still "unpersisted" from the server's point of view, not something to
 * drop. `detailLoaded` excludes sessions that
 * came from a *previous* server summary and are simply waiting on their
 * detail fetch — those aren't locally-originated and should follow the
 * server's list, not survive independently of it.
 */
export function selectUnpersistedSessions(
  local: Session[],
  summaries: ServerSessionSummary[],
): Session[] {
  const serverIds = new Set(summaries.map((s) => s.id));
  return local.filter((s) => s.detailLoaded && !serverIds.has(s.id));
}

/**
 * Replace the store's list with the server's summaries, preserving local
 * sessions the server does not know about yet. Used by the mount hook and by
 * post-mutation refreshes (fork).
 */
export function applyServerSummaries(summaries: ServerSessionSummary[]): void {
  const local = useSessionStore.getState().sessions;
  const unpersisted = selectUnpersistedSessions(local, summaries);
  useSessionStore.getState().setSessions([
    ...unpersisted,
    ...summaries.map((summary) => ({
      id: summary.id,
      title: summary.title,
      messages: [],
      messageCount: summary.messageCount,
      queuedMessages: [],
      detailLoaded: false,
      detailError: null,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      projectId: summary.projectId,
      providerId: summary.providerId,
      modelId: summary.modelId,
      permissionMode: normalisePermissionMode(summary.permissionMode),
      contextUsage: null,
    })),
  ]);
}

// Monotonic token for list refreshes: a slower EARLIER request must never
// overwrite the result of a newer one (the mount fetch racing a fork refresh
// would otherwise wipe the just-forked branch out of the sidebar).
let listRefreshToken = 0;

/**
 * Fetch the server list and apply it, unless a newer refresh has landed in
 * the meantime. Throws when the server is unreachable (callers decide how
 * loudly to report that).
 */
export async function refreshServerSessions(): Promise<void> {
  const token = ++listRefreshToken;
  const summaries = await fetchServerSessions();
  if (token !== listRefreshToken) return; // superseded by a newer refresh
  applyServerSummaries(summaries);
}

/**
 * On mount, loads the session list the headless-server has durably recorded.
 * The server is the sole source of truth: client state is memory-only, so
 * this replaces the list rather than merging into it.
 */
export function useServerSessions(): void {
  const t = useTranslations('chat');
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let summaries;
      try {
        summaries = await fetchServerSessions();
      } catch {
        // Server unreachable (not started yet, or offline) — the regular
        // connection-state UI already surfaces this.
        return;
      }
      if (cancelled) return;

      applyServerSummaries(summaries);
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
