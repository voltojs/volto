/**
 * Store-bound open action for parsed file refs. Kept out of
 * lib/file-reference.ts so that module stays pure — this one reads zustand
 * stores and commands the right pane.
 */

import { openFilePreview } from '@/stores/pane-store';
import { useSessionStore } from '@/stores/session-store';
import type { FileRef } from './file-reference';

/** Project that owns a session's content; null when the session is unknown. */
export function projectIdForSession(sessionId: string): string | null {
  const state = useSessionStore.getState();
  return state.sessions.find((s) => s.id === sessionId)?.projectId ?? null;
}

/** Project of the session on screen right now; null before a session exists. */
export function currentProjectId(): string | null {
  const state = useSessionStore.getState();
  return state.currentSessionId === null
    ? null
    : projectIdForSession(state.currentSessionId);
}

/**
 * Open a parsed ref in the right pane. `projectId === undefined` falls back
 * to the current session's project (correct for the main chat feed, whose
 * content always belongs to it); explicit `null` means the owner is unknown
 * and the click does nothing — a wrong project must never be guessed.
 */
export function openFileRef(ref: FileRef, projectId?: string | null): void {
  const pid = projectId === undefined ? currentProjectId() : projectId;
  if (pid === null) return;
  openFilePreview(pid, ref.path, { line: ref.line, endLine: ref.endLine });
}
