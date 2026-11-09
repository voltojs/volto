/**
 * Pure sidebar layout helpers: ordering, moving, pinning and the drag result.
 *
 * Everything here is a pure function of the stored document plus the current
 * data, so the sidebar's ordering rules are unit-testable without rendering.
 * Ordering never reads the clock: recency comes from the data's own
 * `updatedAt` / `createdAt`.
 */

import type { PinnedSortMode, ProjectSortMode, SidebarState } from './sidebar-state-api';

/** The minimum a project needs to be ordered. */
export interface ProjectLike {
  id: string;
  name: string;
  createdAt: number;
}

/** The minimum a session needs to be ordered / attributed to a workspace. */
export interface SessionLike {
  id: string;
  projectId: string | null;
  updatedAt: number;
}

/**
 * Stable tie-break used by every ordering below: name, then creation time,
 * then id — so two machines with the same data show the same order and tests
 * can assert one.
 */
function compareProjectTie(a: ProjectLike, b: ProjectLike, locale: string): number {
  const byName = a.name.localeCompare(b.name, locale, { numeric: true });
  if (byName !== 0) return byName;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Applies the stored manual order. The order is authoritative for sequence but
 * not for membership: projects it does not mention are appended by
 * `createdAt`, and ids it mentions that no longer exist are ignored.
 */
export function orderProjects<T extends ProjectLike>(
  projects: readonly T[],
  order: readonly string[],
): T[] {
  const remaining = new Map(projects.map((project) => [project.id, project]));
  const ordered: T[] = [];
  for (const id of order) {
    const project = remaining.get(id);
    if (project === undefined) continue;
    ordered.push(project);
    remaining.delete(id);
  }
  const appended = [...remaining.values()].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return [...ordered, ...appended];
}

/** Sorts workspaces by the section's current mode. */
export function sortProjects<T extends ProjectLike>(
  projects: readonly T[],
  mode: ProjectSortMode,
  ctx: {
    order: readonly string[];
    sessions: readonly SessionLike[];
    locale: string;
  },
): T[] {
  if (mode === 'manual') return orderProjects(projects, ctx.order);
  if (mode === 'name') {
    return [...projects].sort((a, b) => compareProjectTie(a, b, ctx.locale));
  }
  // "Recent" is the newest activity in the workspace, counting pinned sessions
  // too: pinning a conversation does not make its workspace look stale.
  const latest = new Map<string, number>();
  for (const session of ctx.sessions) {
    if (session.projectId === null) continue;
    const previous = latest.get(session.projectId);
    if (previous === undefined || session.updatedAt > previous) {
      latest.set(session.projectId, session.updatedAt);
    }
  }
  return [...projects].sort((a, b) => {
    const byActivity = (latest.get(b.id) ?? b.createdAt) - (latest.get(a.id) ?? a.createdAt);
    if (byActivity !== 0) return byActivity;
    return compareProjectTie(a, b, ctx.locale);
  });
}

/**
 * Orders the pinned section. `manual` follows the stored id order and drops
 * ids whose session no longer exists; `recent` re-sorts by activity.
 */
export function sortPinned<S extends { id: string; updatedAt: number }>(
  sessions: readonly S[],
  mode: PinnedSortMode,
  pinnedIds: readonly string[],
): S[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  if (mode === 'manual') {
    const ordered: S[] = [];
    for (const id of pinnedIds) {
      const session = byId.get(id);
      if (session === undefined) continue;
      ordered.push(session);
      byId.delete(id);
    }
    return ordered;
  }
  const pinned = new Set(pinnedIds);
  return sessions
    .filter((session) => pinned.has(session.id))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Moves one item; an out-of-range or no-op move returns the list unchanged. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...items];
  next.splice(to, 0, moved);
  return next;
}

/** Pins a session (idempotent) at the end of the manual order. */
export function pinSession(state: SidebarState, sessionId: string): SidebarState {
  if (state.pinnedSessionIds.includes(sessionId)) return state;
  return { ...state, pinnedSessionIds: [...state.pinnedSessionIds, sessionId] };
}

/** Unpins a session; a missing id is a no-op. */
export function unpinSession(state: SidebarState, sessionId: string): SidebarState {
  if (!state.pinnedSessionIds.includes(sessionId)) return state;
  return {
    ...state,
    pinnedSessionIds: state.pinnedSessionIds.filter((id) => id !== sessionId),
  };
}

/**
 * Adds or removes a project from the expand set. Always materialises an
 * explicit array — collapsing the last open project must be distinguishable
 * from "never set", which is what makes it survive a reload.
 *
 * `renderedIds` is the set the caller is actually showing, which is not the
 * stored one while the field is absent (that case renders the first workspace
 * expanded). Toggling against the stored value would silently collapse the
 * visible one the moment the user expands a second workspace.
 */
export function toggleProjectExpanded(
  state: SidebarState,
  projectId: string,
  renderedIds: readonly string[] = state.expandedProjectIds ?? [],
): SidebarState {
  const current = renderedIds;
  const next = current.includes(projectId)
    ? current.filter((id) => id !== projectId)
    : [...current, projectId];
  return { ...state, expandedProjectIds: next };
}

/**
 * Result of a finished same-section drag: the rendered order is the new stored
 * order, and that section flips to `manual` — otherwise the next render would
 * re-sort the row back to where it came from.
 */
export function applyDragEnd(
  state: SidebarState,
  section: 'pinned' | 'projects',
  renderedIds: readonly string[],
  from: number,
  to: number,
): SidebarState {
  const moved = moveItem(renderedIds, from, to);
  if (section === 'pinned') {
    return {
      ...state,
      pinnedSessionIds: [...moved],
      sortModes: { ...state.sortModes, pinned: 'manual' },
    };
  }
  return {
    ...state,
    projectOrder: [...moved],
    sortModes: { ...state.sortModes, projects: 'manual' },
  };
}