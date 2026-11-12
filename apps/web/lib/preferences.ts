/**
 * Defaults the next conversation starts with, persisted by the gateway in
 * `~/.volto/config.json` (`preferences` section).
 *
 * They live on the server rather than in `localStorage` because they describe
 * the workspace's setup (which model, which permission tier), not this
 * browser's view of it: a second browser or a restarted dev server must open
 * the next conversation the same way.
 */

import { gatewayUrl } from './gateway-base';

export interface Preferences {
  /** UI language, shared with the gateway's own rendered copy. */
  locale?: 'zh' | 'en';
  /** Color scheme; "system" follows the OS. */
  theme?: 'light' | 'dark' | 'system';
  /** Execution-detail level for the chat feed. */
  streamDensity?: 'detailed' | 'concise';
  /** Permission tier a new session starts in ("ask", "read-only", …). */
  defaultPermissionMode?: string;
  /** Last provider/model picked, pre-selected for a new session. */
  lastProviderId?: string;
  lastModelId?: string;
  /** Last reasoning-effort id chosen for that model. */
  lastReasoningEffort?: string;
  /**
   * Model used to name new sessions. Absent/empty = the gateway truncates the
   * first message instead of calling a model.
   */
  titleProviderId?: string;
  titleModelId?: string;
}

export const EMPTY_PREFERENCES: Preferences = {};

export async function fetchPreferences(): Promise<Preferences> {
  try {
    const response = await fetch(gatewayUrl('/preferences'), { credentials: 'include' });
    if (!response.ok) return EMPTY_PREFERENCES;
    return (await response.json()) as Preferences;
  } catch {
    // A gateway that is down or unreachable must not take the app with it:
    // the defaults are an optimisation, never a prerequisite.
    return EMPTY_PREFERENCES;
  }
}

/** Merges `patch` into the stored defaults; resolves to the merged result. */
export async function patchPreferences(patch: Preferences): Promise<Preferences> {
  const response = await fetch(gatewayUrl('/preferences'), {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) return EMPTY_PREFERENCES;
  return (await response.json()) as Preferences;
}
