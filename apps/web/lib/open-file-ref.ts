/**
 * Store-bound open action for parsed file refs. Kept out of
 * lib/file-reference.ts so that module stays pure — this one reads zustand
 * stores and commands the right pane.
 */

import { openFilePreview, revealInTree, revealSearch } from '@/stores/pane-store';
import { useSessionStore } from '@/stores/session-store';
import { searchFsFiles } from '@/lib/fs-api';
import { chooseRefMatch, type FileRef, type FsMatchLike } from './file-reference';

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
  // Directory refs belong in the file tree, not a broken file preview.
  if (ref.kind === 'dir') {
    revealInTree(pid, ref.path);
    return;
  }
  openFilePreview(pid, ref.path, { line: ref.line, endLine: ref.endLine });
}

/**
 * Fallback navigation for a ref whose exact target failed to open (missing
 * preview, unfindable tree row). Candidates come from the name search; only
 * a unique pick navigates, any tie defers to the tree search so the user
 * chooses, and nothing usable means the caller keeps its own failure UI.
 */
export type RefFallbackResult =
  | { kind: 'resolved'; target: FsMatchLike }
  | { kind: 'search' }
  | { kind: 'none' };

export async function resolveRefFallback(
  projectId: string,
  ref: FileRef,
): Promise<RefFallbackResult> {
  const base = ref.path.slice(ref.path.lastIndexOf('/') + 1);
  let matches: readonly FsMatchLike[];
  try {
    matches = (await searchFsFiles(projectId, base)).matches;
  } catch {
    return { kind: 'none' };
  }
  const choice = chooseRefMatch(ref, matches);
  if (choice.kind === 'ambiguous') {
    revealSearch(projectId, base);
    return { kind: 'search' };
  }
  if (choice.kind === 'none') return { kind: 'none' };
  const { target, withLine } = choice;
  if (target.type === 'dir') {
    revealInTree(projectId, target.path);
  } else {
    openFilePreview(
      projectId,
      target.path,
      withLine ? { line: ref.line, endLine: ref.endLine } : undefined,
    );
  }
  return { kind: 'resolved', target };
}
