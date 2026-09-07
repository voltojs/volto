/**
 * Session title derived from the first user message. The server owns titles;
 * this only produces the initial value the client writes back once, and never
 * overwrites a title the user set by hand.
 */

import type { ConversationMessage } from '@volto/sdk/sse';

const MAX_TITLE_LENGTH = 30;

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
 * PATCHes it to the server with a single silent retry on failure — per spec,
 * titles are not on the critical path, so a second failure is swallowed
 * rather than surfaced or retried further.
 *
 * Extracted from the `useConversation` effect so this gating and retry
 * behaviour can be unit-tested without rendering the hook.
 *
 * The write-back registers an `AbortController` in `inFlightWriteBacks` for
 * the duration of its PATCH(es), so a concurrent manual rename can cancel it
 * via `cancelPendingTitleWriteBack` — see that function's doc comment for
 * why this is needed. An aborted request is not treated as a failure: it is
 * never surfaced to the user and never triggers the retry, since the manual
 * rename that caused the abort is itself the write that should reach the
 * server.
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
  } catch {
    if (controller.signal.aborted) {
      // Cancelled by a manual rename racing this write-back: the user's own
      // title is the one being sent to the server now, so no retry and no
      // error surfaced. `cancelPendingTitleWriteBack` already removed this
      // controller from the map.
      return;
    }
    try {
      await rename(sessionId, title, controller.signal);
    } catch {
      // Give up silently for the rest of the browsing session.
    } finally {
      clearInFlight();
    }
  }
}
