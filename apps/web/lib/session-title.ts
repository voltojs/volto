/**
 * Session title derived from the first user message. The server owns titles;
 * this only produces the initial value the client writes back once, and never
 * overwrites a title the user set by hand.
 */

import type { ConversationMessage } from '@volto/sdk/sse';

/**
 * A title is the first user message collapsed to one line. Early builds clipped
 * it at 30 code points, which made the header unreadable ("review 从 29cd234…");
 * the cap is now generous enough to keep a real title whole while still
 * refusing to turn a pasted essay into a header.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * Derives a title from the first user message, collapsing whitespace
 * (including newlines) to single spaces and capping the length.
 *
 * Returns null when there is no user message yet, or its content is blank
 * once collapsed — callers use that to mean "nothing to write back yet".
 *
 * Truncation counts Unicode codepoints (via `Array.from`) rather than UTF-16
 * code units, so a title never gets cut through the middle of a surrogate
 * pair (e.g. some emoji); plain CJK characters are single code units either
 * way, so this doesn't change behaviour for the common case.
 */
export function deriveSessionTitle(
  messages: ConversationMessage[],
): string | null {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return null;
  // `ConversationMessage.content` is a plain string (packages/core's
  // view-projection always flattens text blocks into it), so there is no
  // non-string case to guard against here.
  const collapsed = first.content.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;

  const codepoints = Array.from(collapsed);
  return codepoints.length > MAX_TITLE_LENGTH
    ? `${codepoints.slice(0, MAX_TITLE_LENGTH).join('')}…`
    : collapsed;
}

export interface TitleWriteBackParams {
  sessionId: string;
  /** The session's current title, straight from the store. */
  currentTitle: string;
  messages: ConversationMessage[];
  /**
   * Session ids this browsing session has already started (or finished) a
   * write-back for. Mutated in place: the id is added the moment a non-null
   * title is derived, before the network call, so this doubles as the "at
   * most once per session, ever" gate — a failed PATCH does not remove it.
   */
  titledIds: Set<string>;
  /** Applies the derived title to local state immediately (optimistic). */
  setTitle: (id: string, title: string) => void;
  /** The PATCH to the server. Rejects on any non-ok response, or when aborted. */
  rename: (id: string, title: string, signal?: AbortSignal) => Promise<void>;
}

/**
 * Delay before the single retry, for both the derived write-back and the
 * manual rename. The two realistic failure causes — the session's transcript
 * not persisted yet (its file is created by a fire-and-forget append that
 * isn't awaited, so a 404 is genuinely possible right after the first
 * message), or a transient network blip — both need a moment to clear; an
 * immediate retry lands in the same few-millisecond failure window. Exported
 * so tests can drive it with fake timers instead of a real wait.
 */
export const TITLE_RETRY_DELAY_MS = 1500;

/**
 * Resolves after `ms`, or rejects immediately (or as soon as `signal` fires)
 * without ever starting/leaking a timer past that point. `signal` is
 * optional: the manual rename's retry has nothing to abort it.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Tracks the `AbortController` for a session's in-flight derived title
 * write-back (see `runTitleWriteBack`), keyed by session id.
 *
 * This exists to close a race: the derived write-back and a manual rename
 * (`ProjectList`'s `onFinishEdit`) are two independent write-back paths with
 * no server-side request ordering. If the derived PATCH(T1) is still in
 * flight when the user manually renames to T2, the two requests can arrive
 * out of order and the server's last-wins fold can end up storing T1,
 * silently discarding the user's manual title. Cancelling the derived
 * request the moment a manual rename starts closes the only window where
 * that ordering can occur — it cannot un-send a request the server already
 * received, but it prevents T1 from still being in flight when T2 is sent,
 * which is the precondition for the bad ordering.
 */
const inFlightWriteBacks = new Map<string, AbortController>();

/**
 * Cancels a session's in-flight derived title write-back, if any, and
 * suppresses its pending retry. Call this immediately before issuing a
 * manual rename's own PATCH, so the two requests can never race.
 *
 * A no-op if there is no derived write-back in flight for this session.
 */
export function cancelPendingTitleWriteBack(sessionId: string): void {
  const controller = inFlightWriteBacks.get(sessionId);
  if (!controller) return;
  controller.abort();
  inFlightWriteBacks.delete(sessionId);
}

/**
 * Runs the once-per-session title derivation and write-back.
 *
 * A no-op when the session already has a title (user-set or previously
 * written back), when a write-back for this session has already been
 * started, or when there's no non-blank first user message yet to derive one
 * from. Otherwise derives the title, applies it locally right away, and
 * PATCHes it to the server, waits `TITLE_RETRY_DELAY_MS` and retries exactly
 * once on failure, then — per spec, titles are not on the critical path —
 * rolls the optimistic local title back to `''` (the pre-write-back value;
 * `currentTitle` is guaranteed empty for this path, see the guard above) so
 * the sidebar never keeps showing a title the server never received.
 *
 * Extracted from the `useConversation` effect so this gating and retry
 * behaviour can be unit-tested without rendering the hook.
 *
 * The write-back registers an `AbortController` in `inFlightWriteBacks` for
 * the duration of its PATCH(es) and the retry delay, so a concurrent manual
 * rename can cancel it via `cancelPendingTitleWriteBack` — see that
 * function's doc comment for why this is needed. An aborted request (or an
 * abort landing during the retry delay) is not treated as a failure: it is
 * never surfaced to the user, never rolls back the title, and never retries,
 * since the manual rename that caused the abort is itself the write that
 * should reach the server and is about to set its own title locally.
 */
export async function runTitleWriteBack(
  params: TitleWriteBackParams,
): Promise<void> {
  const { sessionId, currentTitle, messages, titledIds, setTitle, rename } =
    params;
  if (currentTitle.length > 0) return;
  if (titledIds.has(sessionId)) return;
  const title = deriveSessionTitle(messages);
  if (title === null) return;

  titledIds.add(sessionId);
  setTitle(sessionId, title);

  const controller = new AbortController();
  inFlightWriteBacks.set(sessionId, controller);
  const clearInFlight = () => {
    if (inFlightWriteBacks.get(sessionId) === controller) {
      inFlightWriteBacks.delete(sessionId);
    }
  };

  try {
    await rename(sessionId, title, controller.signal);
    clearInFlight();
    return;
  } catch {
    if (controller.signal.aborted) {
      // Cancelled by a manual rename racing this write-back: the user's own
      // title is the one being sent to the server now, so no retry, no
      // rollback, and no error surfaced. `cancelPendingTitleWriteBack`
      // already removed this controller from the map.
      return;
    }
  }

  try {
    await delay(TITLE_RETRY_DELAY_MS, controller.signal);
  } catch {
    // Aborted during the delay — same "manual rename took over" case above.
    clearInFlight();
    return;
  }

  try {
    await rename(sessionId, title, controller.signal);
  } catch {
    if (!controller.signal.aborted) {
      // Give up for the rest of the browsing session (titledIds already has
      // this id), but don't leave the UI showing a title the server never
      // got — roll back to the pre-write-back value.
      setTitle(sessionId, '');
    }
  } finally {
    clearInFlight();
  }
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
 * failure, then — matching the derived write-back's spec'd behaviour — rolls
 * the local title back to what it was before this rename and surfaces an
 * inline error via `setError`. Never throws.
 *
 * Callers must call `cancelPendingTitleWriteBack(sessionId)` before invoking
 * this, so a slow derived-title PATCH can never land after (and silently
 * overwrite) the title the user just set — see that function's doc comment.
 */
export async function runManualRename(
  params: ManualRenameParams,
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
    setError('重命名失败，已恢复为原标题');
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
