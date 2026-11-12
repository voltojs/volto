/**
 * Sidebar layout state — pinned sessions, workspace order, sort modes and the
 * collapse flags the Web client renders from.
 *
 * It lives in the gateway (not in the browser) so a second browser or a
 * restarted gateway opens the same sidebar. It deliberately does NOT live in
 * a session's transcript: pinning is a view concern, and a forked or exported
 * conversation inheriting "pinned" would be wrong.
 *
 * Stored in `~/.volto/config.json` under the runtime-only `sidebar` section.
 * A corrupt document degrades to the default layout instead of failing the
 * request — a layout preference is never worth a broken sidebar.
 */

import { getConfigDir } from "./paths.js";
import { ConfigCorruptError } from "./io.js";
import { getConfigStore } from "./store.js";

export const PINNED_SORT_MODES = ["manual", "recent"] as const;
export const PROJECT_SORT_MODES = ["manual", "name", "recent"] as const;

export type PinnedSortMode = (typeof PINNED_SORT_MODES)[number];
export type ProjectSortMode = (typeof PROJECT_SORT_MODES)[number];

export interface SidebarState {
  /** Members are pinned; the order is the pinned section's manual order. */
  pinnedSessionIds: string[];
  /** Manual workspace order. Members come from `GET /projects`, not from here. */
  projectOrder: string[];
  sortModes: { pinned: PinnedSortMode; projects: ProjectSortMode };
  /**
   * Multi-expand set. Absent (`undefined`) means "never set" and the client
   * expands the first workspace; `[]` means the user collapsed them all —
   * the two must stay distinguishable across a reload.
   */
  expandedProjectIds?: string[];
  pinnedCollapsed: boolean;
  projectsCollapsed: boolean;
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = {
  pinnedSessionIds: [],
  projectOrder: [],
  sortModes: { pinned: "manual", projects: "manual" },
  pinnedCollapsed: false,
  projectsCollapsed: false,
};

export class InvalidSidebarStateError extends Error {}

const MAX_ARRAY_LENGTH = 500;
const MAX_ID_LENGTH = 200;

function readIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new InvalidSidebarStateError(`${field} must be an array of strings`);
  }
  // Checked before deduplication so an oversized body is rejected rather than
  // silently shrunk.
  if (value.length > MAX_ARRAY_LENGTH) {
    throw new InvalidSidebarStateError(
      `${field} must contain at most ${MAX_ARRAY_LENGTH} items`,
    );
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new InvalidSidebarStateError(`${field} must contain non-empty strings`);
    }
    if (item.length > MAX_ID_LENGTH) {
      throw new InvalidSidebarStateError(
        `${field} entries must be at most ${MAX_ID_LENGTH} characters`,
      );
    }
    if (seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function readSortMode<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new InvalidSidebarStateError(
    `${field} must be one of ${allowed.map((mode) => `"${mode}"`).join(", ")}`,
  );
}

function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new InvalidSidebarStateError(`${field} must be a boolean`);
  }
  return value;
}

/**
 * Validates a stored or submitted document and fills in defaults. Unknown
 * session / project ids are kept on purpose: the render layer filters them,
 * which is what makes a deleted workspace self-heal without cleanup writes.
 */
export function normalizeSidebarState(value: unknown): SidebarState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidSidebarStateError("sidebar state must be an object");
  }
  const record = value as Record<string, unknown>;
  const sortModes = record["sortModes"];
  if (
    sortModes !== undefined &&
    (typeof sortModes !== "object" || sortModes === null || Array.isArray(sortModes))
  ) {
    throw new InvalidSidebarStateError("sortModes must be an object");
  }
  const modes = (sortModes ?? {}) as Record<string, unknown>;

  const state: SidebarState = {
    pinnedSessionIds:
      record["pinnedSessionIds"] === undefined
        ? []
        : readIdArray(record["pinnedSessionIds"], "pinnedSessionIds"),
    projectOrder:
      record["projectOrder"] === undefined
        ? []
        : readIdArray(record["projectOrder"], "projectOrder"),
    sortModes: {
      pinned: readSortMode(modes["pinned"], "sortModes.pinned", PINNED_SORT_MODES, "manual"),
      projects: readSortMode(
        modes["projects"],
        "sortModes.projects",
        PROJECT_SORT_MODES,
        "manual",
      ),
    },
    pinnedCollapsed: readBoolean(record["pinnedCollapsed"], "pinnedCollapsed", false),
    projectsCollapsed: readBoolean(record["projectsCollapsed"], "projectsCollapsed", false),
  };

  // The one field whose absence is meaningful: "never set" and "user collapsed
  // everything" must not collapse into the same value.
  if (record["expandedProjectIds"] !== undefined) {
    state.expandedProjectIds = readIdArray(
      record["expandedProjectIds"],
      "expandedProjectIds",
    );
  }
  return state;
}

export interface SidebarStateStore {
  read(): Promise<SidebarState>;
  write(value: unknown): Promise<SidebarState>;
}

export function createSidebarStateStore(dir: string = getConfigDir()): SidebarStateStore {
  const store = getConfigStore(dir);

  return {
    async read() {
      let raw: unknown;
      try {
        raw = (await store.read())["sidebar"];
      } catch (err: unknown) {
        // An unreadable document is not a reason to fail the sidebar: the
        // default layout is a usable answer.
        if (err instanceof ConfigCorruptError) {
          console.warn(`sidebar state unreadable; using defaults (${err.message})`);
          return DEFAULT_SIDEBAR_STATE;
        }
        throw err;
      }
      if (raw === undefined) return DEFAULT_SIDEBAR_STATE;
      try {
        return normalizeSidebarState(raw);
      } catch (err: unknown) {
        console.warn(
          `sidebar state invalid; using defaults (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        return DEFAULT_SIDEBAR_STATE;
      }
    },

    async write(value: unknown) {
      const next = normalizeSidebarState(value);
      await store.update("sidebar", () => next);
      return next;
    },
  };
}