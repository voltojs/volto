/**
 * Session titles are written by the gateway: it derives one from the first
 * user message as the first turn starts and, when the user has configured a
 * title model, replaces it with a generated one after that turn. The client
 * only (a) reacts to the `session_meta` the gateway pushes, (b) renames by
 * hand, and (c) expands a title an older build clipped.
 */

import type { ConversationMessage, TranscriptEventInput } from '@voltojs/sdk/sse';

/**
 * Cap an older build applied to derived titles. Only `expandStoredTitle`
 * needs it now — to decide whether a stored title is a clipped stub.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * The title a live `session_meta` event carries, or null when the event is
 * something else (or carries no usable title).
 *
 * The gateway mirrors every title write onto the session's channel, so this is
 * how the header and the sidebar learn a session's name without a reload.
 */
export function titleFromSessionMeta(event: TranscriptEventInput): string | null {
  if (event.type !== 'session_meta') return null;
  const title = (event.data as { title?: unknown }).title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}

/**
 * Delay before a manual rename's single retry. The two realistic failure
 * causes — the session's transcript not persisted yet (its file is created by
 * a fire-and-forget append that isn't awaited), or a transient network blip —
 * both need a moment to clear; an immediate retry lands in the same
 * few-millisecond failure window. Exported so tests can drive it with fake
 * timers instead of a real wait.
 */
export const TITLE_RETRY_DELAY_MS = 1500;

/** Resolves after `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ManualRenameParams {
  sessionId: string;
  /** The new title the user typed. */
  title: string;
  /** The session's title before this rename, to roll back to on final failure. */
  previousTitle: string;
  /** Applies a title to local state immediately (optimistic). */
  setTitle: (id: string, title: string) => void;
  /** The PATCH to the server. Rejects on any non-ok response. */
  rename: (id: string, title: string) => Promise<void>;
  /** Surfaces a user-facing error message, or clears it (`null`) at the start. */
  setError: (message: string | null) => void;
}

/**
 * Runs a sidebar manual rename: applies the title locally right away, PATCHes
 * it to the server, waits `TITLE_RETRY_DELAY_MS` and retries exactly once on
 * failure, then rolls the local title back to what it was before this rename
 * and surfaces an inline error via `setError`. Never throws.
 *
 * No cancellation is needed: the server ranks title sources, so a generated
 * title that lands later cannot overwrite the one this rename sent.
 */
export async function runManualRename(
  params: ManualRenameParams,
  t: (key: string) => string = (key) => key,
): Promise<void> {
  const { sessionId, title, previousTitle, setTitle, rename, setError } =
    params;
  setTitle(sessionId, title);
  setError(null);

  try {
    await rename(sessionId, title);
    return;
  } catch {
    // Fall through to the single delayed retry below.
  }

  await delay(TITLE_RETRY_DELAY_MS);

  try {
    await rename(sessionId, title);
  } catch {
    setTitle(sessionId, previousTitle);
    setError(t('session.renameFailed'));
  }
}

/**
 * The title to display when the stored one was clipped by an older build.
 *
 * Old sessions kept the clipped string ("…" included) and the write-back never
 * revisits a non-empty title, so without this the header would keep showing a
 * 30-character stub forever. Expansion only happens when the stored title is
 * provably a prefix of the first user message — a hand-written title that
 * happens to end with "…" is left alone.
 */
export function expandStoredTitle(
  storedTitle: string,
  messages: ConversationMessage[],
): string {
  if (!storedTitle.endsWith('…')) return storedTitle;
  const first = messages.find((m) => m.role === 'user');
  if (first === undefined) return storedTitle;
  const collapsed = first.content.replace(/\s+/g, ' ').trim();
  const prefix = storedTitle.slice(0, -1);
  if (!collapsed.startsWith(prefix) || collapsed.length <= prefix.length) {
    return storedTitle;
  }
  const codepoints = Array.from(collapsed);
  return codepoints.length > MAX_TITLE_LENGTH
    ? `${codepoints.slice(0, MAX_TITLE_LENGTH).join('')}…`
    : collapsed;
}
