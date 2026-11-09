/**
 * The sidebar's layout document as the gateway stores it: which sessions are
 * pinned (and in what order), the workspace order, the two sections' sort
 * modes, and their collapse flags.
 *
 * It lives on the server rather than in `localStorage` so a second browser or
 * a restarted gateway opens the same sidebar. Client-side normalisation is
 * deliberately tolerant where the gateway's is strict: a malformed field
 * degrades to its default instead of failing the sidebar.
 */

import { SERVER_URL } from './agent-config';

export type PinnedSortMode = 'manual' | 'recent';
export type ProjectSortMode = 'manual' | 'name' | 'recent';

export interface SidebarState {
  /** Members are pinned; the order is the pinned section's manual order. */
  pinnedSessionIds: string[];
  /** Manual workspace order; membership comes from `GET /projects`. */
  projectOrder: string[];
  sortModes: { pinned: PinnedSortMode; projects: ProjectSortMode };
  /**
   * Multi-expand set. `undefined` means "never set" (expand the first
   * workspace); `[]` means the user collapsed them all. The difference has to
   * survive a reload, so it is never filled in with a default here.
   */
  expandedProjectIds?: string[];
  pinnedCollapsed: boolean;
  projectsCollapsed: boolean;
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = {
  pinnedSessionIds: [],
  projectOrder: [],
  sortModes: { pinned: 'manual', projects: 'manual' },
  pinnedCollapsed: false,
  projectsCollapsed: false,
};

const PINNED_SORT_MODES: readonly PinnedSortMode[] = ['manual', 'recent'];
const PROJECT_SORT_MODES: readonly ProjectSortMode[] = ['manual', 'name', 'recent'];

/** Deduped id list, or `undefined` when the value cannot be one. */
function readIdArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function readMode<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerces a wire document into a usable one. Unknown ids stay (the render
 * layer filters them), malformed fields take their default, and
 * `expandedProjectIds` keeps `undefined` apart from `[]`.
 */
export function normalizeSidebarState(value: unknown): SidebarState {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const sortModes =
    typeof record['sortModes'] === 'object' &&
    record['sortModes'] !== null &&
    !Array.isArray(record['sortModes'])
      ? (record['sortModes'] as Record<string, unknown>)
      : {};

  const state: SidebarState = {
    pinnedSessionIds: readIdArray(record['pinnedSessionIds']) ?? [],
    projectOrder: readIdArray(record['projectOrder']) ?? [],
    sortModes: {
      pinned: readMode(sortModes['pinned'], PINNED_SORT_MODES, 'manual'),
      projects: readMode(sortModes['projects'], PROJECT_SORT_MODES, 'manual'),
    },
    pinnedCollapsed: readBoolean(record['pinnedCollapsed'], false),
    projectsCollapsed: readBoolean(record['projectsCollapsed'], false),
  };

  if (record['expandedProjectIds'] !== undefined) {
    state.expandedProjectIds = readIdArray(record['expandedProjectIds']) ?? [];
  }
  return state;
}

/** Reads the stored layout; any failure yields the default layout. */
export async function fetchSidebarState(): Promise<SidebarState> {
  try {
    const response = await fetch(`${SERVER_URL}/sidebar-state`, {
      credentials: 'include',
    });
    if (!response.ok) return DEFAULT_SIDEBAR_STATE;
    const body = (await response.json()) as { sidebar?: unknown };
    return normalizeSidebarState(body.sidebar);
  } catch {
    // A gateway that is down must not take the sidebar with it: the default
    // layout is a usable answer, and the existing connection banner already
    // reports the outage.
    return DEFAULT_SIDEBAR_STATE;
  }
}

/** Replaces the stored layout; resolves to whether the write landed. */
export async function putSidebarState(state: SidebarState): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_URL}/sidebar-state`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sidebar: state }),
    });
    return response.ok;
  } catch {
    // The caller keeps its optimistic state; a failed save is not worth
    // surfacing (see sidebar-state-store).
    return false;
  }
}