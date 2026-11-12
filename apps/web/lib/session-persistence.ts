/**
 * The active conversation is view state, not transcript state: the server
 * owns the session list, but a reload should reopen the session the user was
 * looking at. localStorage is enough (same-origin, per browser).
 */
const CURRENT_SESSION_KEY = 'volto.currentSessionId';

export function loadStoredSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(CURRENT_SESSION_KEY);
    return value !== null && value !== '' ? value : null;
  } catch {
    return null;
  }
}

export function persistSessionId(sessionId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (sessionId === null) window.localStorage.removeItem(CURRENT_SESSION_KEY);
    else window.localStorage.setItem(CURRENT_SESSION_KEY, sessionId);
  } catch {
    // Storage can be disabled (private mode / quota); restore is best-effort.
  }
}
