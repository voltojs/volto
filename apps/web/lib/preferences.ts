/**
 * Defaults the next conversation starts with, persisted by the gateway under
 * `~/.volto/preferences.json`.
 *
 * They live on the server rather than in `localStorage` because they describe
 * the workspace's setup (which model, which permission tier), not this
 * browser's view of it: a second browser or a restarted dev server must open
 * the next conversation the same way.
 */

import { SERVER_URL } from './agent-config';

export interface Preferences {
  /** Permission tier a new session starts in ("ask", "read-only", …). */
  defaultPermissionMode?: string;
  /** Last provider/model picked, pre-selected for a new session. */
  lastProviderId?: string;
  lastModelId?: string;
  /** Last reasoning-effort id chosen for that model. */
  lastReasoningEffort?: string;
}

export const EMPTY_PREFERENCES: Preferences = {};

export async function fetchPreferences(): Promise<Preferences> {
  const response = await fetch(`${SERVER_URL}/preferences`, { credentials: 'include' });
  if (!response.ok) return EMPTY_PREFERENCES;
  return (await response.json()) as Preferences;
}

/** Merges `patch` into the stored defaults; resolves to the merged result. */
export async function patchPreferences(patch: Preferences): Promise<Preferences> {
  const response = await fetch(`${SERVER_URL}/preferences`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) return EMPTY_PREFERENCES;
  return (await response.json()) as Preferences;
}
