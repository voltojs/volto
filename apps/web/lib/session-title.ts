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
  const text = typeof first.content === 'string' ? first.content : '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
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
  /** The PATCH to the server. Rejects on any non-ok response. */
  rename: (id: string, title: string) => Promise<void>;
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

  try {
    await rename(sessionId, title);
  } catch {
    try {
      await rename(sessionId, title);
    } catch {
      // Give up silently for the rest of the browsing session.
    }
  }
}
