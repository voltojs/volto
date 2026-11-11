/**
 * RightPane tab state: tabs (ordered) + activeTabId + width.
 * PaneTab is a discriminated union — each tab carries its own data reference
 * (childSessionId / projectId / projectId+path). The pane is remembered per
 * session: switchSession snapshots the session being left and restores the
 * target's own snapshot (a never-seen session defaults to a collapsed empty
 * pane), so one conversation's subagent / plan panels never leak into
 * another. Snapshots persist to localStorage (device-local view state, like
 * width) with an LRU cap; files / git-graph are additionally pointed at the
 * new workspace via retargetProjectTabs on workspace switch. Only width and
 * the snapshot map persist; live tabs are otherwise memory-only.
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';

export type PaneTab =
  | {
      kind: 'subagent';
      id: string;
      childSessionId: string;
      view: 'chat' | 'trajectory';
      /**
       * Session that spawned this sub-agent. Continued-chat input binds its
       * project/model/permission config to this session, not whichever
       * session is current when the tab is used. Optional for legacy tabs
       * opened before the field existed — those fall back to currentSessionId.
       */
      parentSessionId?: string;
      /**
       * Dispatch-supplied task title, so the tab strip can label the pane
       * with what the user asked for instead of a session-id suffix — before
       * the child's own transcript has loaded. Absent for legacy tabs.
       */
      title?: string;
      /** `subagent_type` the dispatch named (the card's own label). */
      agentType?: string;
    }
  | { kind: 'files'; id: string; projectId: string }
  /**
   * File preview. `line`/`endLine` carry a line target from a message
   * reference (`src/foo.ts:42`): same file re-clicked with a new target
   * updates the payload instead of opening another tab.
   */
  | {
      kind: 'file-preview';
      id: string;
      projectId: string;
      path: string;
      line?: number;
      endLine?: number;
    }
  /**
   * A file's diff for one turn. The body is carried in the payload: it was
   * captured by the write tool and lives in the transcript, so the tab needs
   * no fetch and stays correct after a reload. `turn` separates the same
   * file's changes across turns; a later edit in the same turn overwrites
   * the payload in place.
   */
  | {
      kind: 'file-diff';
      id: string;
      projectId: string;
      path: string;
      turn: string;
      diff: string;
      additions: number;
      deletions: number;
      /** Edits of this file folded into the entry (1 = a single write). */
      edits: number;
      truncated?: boolean;
    }
  | { kind: 'git-graph'; id: string; projectId: string }
  | { kind: 'tasks'; id: string }
  /** 计划文档标签（plan 模式）。内容不进标签载荷——标签体按 sessionId 自拉。 */
  | { kind: 'plan'; id: string; sessionId: string };

export const PANE_WIDTH_MIN = 320;
export const PANE_WIDTH_MAX = 720;
export const PANE_WIDTH_DEFAULT = 420;

const WIDTH_KEY = 'volto.pane.width';

function clampWidth(n: number): number {
  return Math.min(PANE_WIDTH_MAX, Math.max(PANE_WIDTH_MIN, Math.round(n)));
}

function loadWidth(): number {
  if (typeof window === 'undefined') return PANE_WIDTH_DEFAULT;
  const raw = window.localStorage.getItem(WIDTH_KEY);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? clampWidth(n) : PANE_WIDTH_DEFAULT;
}

/** Per-session pane state, serializable as-is (tab payloads are plain JSON). */
export interface PaneSessionSnapshot {
  v: 1;
  tabs: PaneTab[];
  activeTabId: string | null;
  open: boolean;
  hidden: boolean;
  /** LRU stamp for storage eviction. */
  usedAt: number;
}

const SESSIONS_KEY = 'volto.pane.sessions';
const SNAPSHOT_LIMIT = 100;
/** Serialized byte cap so large diff payloads cannot exhaust the quota. */
const SNAPSHOT_BYTES = 2_000_000;

function isSnapshot(x: unknown): x is PaneSessionSnapshot {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Partial<PaneSessionSnapshot>;
  return (
    s.v === 1 &&
    Array.isArray(s.tabs) &&
    typeof s.open === 'boolean' &&
    typeof s.hidden === 'boolean'
  );
}

function loadSnapshots(): Record<string, PaneSessionSnapshot> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SESSIONS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, PaneSessionSnapshot> = {};
    for (const [id, snap] of Object.entries(parsed)) {
      if (isSnapshot(snap)) out[id] = snap;
    }
    return out;
  } catch {
    // Corrupt storage is treated as empty, never as a crash.
    return {};
  }
}

/** Drop project-scoped tabs whose workspace no longer exists. */
function sanitizeTabs(
  tabs: PaneTab[],
  validProjectIds: readonly string[] | null,
): PaneTab[] {
  if (validProjectIds === null) return tabs;
  const ok = new Set(validProjectIds);
  return tabs.filter(
    (t) =>
      t.kind === 'subagent' ||
      t.kind === 'plan' ||
      t.kind === 'tasks' ||
      ok.has(t.projectId),
  );
}

function fallbackActive(tabs: PaneTab[], preferred: string | null): string | null {
  return preferred !== null && tabs.some((t) => t.id === preferred)
    ? preferred
    : (tabs[tabs.length - 1]?.id ?? null);
}

function snapshotOf(s: {
  tabs: PaneTab[];
  activeTabId: string | null;
  open: boolean;
  hidden: boolean;
}): PaneSessionSnapshot {
  return {
    v: 1,
    tabs: s.tabs,
    activeTabId: s.activeTabId,
    open: s.open,
    hidden: s.hidden,
    usedAt: Date.now(),
  };
}

function evict(
  map: Record<string, PaneSessionSnapshot>,
): Record<string, PaneSessionSnapshot> {
  let entries = Object.entries(map);
  if (entries.length > SNAPSHOT_LIMIT) {
    entries.sort((a, b) => b[1].usedAt - a[1].usedAt);
    entries = entries.slice(0, SNAPSHOT_LIMIT);
  }
  let json = JSON.stringify(Object.fromEntries(entries));
  while (json.length > SNAPSHOT_BYTES && entries.length > 1) {
    entries.sort((a, b) => b[1].usedAt - a[1].usedAt);
    entries = entries.slice(0, entries.length - 1);
    json = JSON.stringify(Object.fromEntries(entries));
  }
  return Object.fromEntries(entries);
}

function writeSnapshots(map: Record<string, PaneSessionSnapshot>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(evict(map)));
  } catch {
    // Quota exhaustion must not break the pane; the in-memory map survives.
  }
}

interface PaneState {
  tabs: PaneTab[];
  activeTabId: string | null;
  width: number;
  /**
   * Whether the pane shell has been opened. Distinct from `hidden`: collapse
   * flips `hidden` and keeps tabs; closing every last tab leaves `open` true
   * so the empty overview stays mounted instead of unmounting the pane.
   */
  open: boolean;
  /** Pane collapsed: tabs kept, view unmounted — the toggles flip it. */
  hidden: boolean;
  /**
   * Latest "reveal this directory in the file tree" request. FileTreeTab
   * consumes it and expands/scrolls to the dir; `nonce` re-arms the same dir.
   */
  openTab: (tab: PaneTab) => void;
  /** Open the pane shell with zero tabs (empty-state overview). */
  openPane: () => void;
  closeTab: (id: string) => void;
  /**
   * Point project-scoped tabs at a new workspace. `files` / `git-graph` keep
   * their kind and become `${kind}:${projectId}`; `file-preview` paths are
   * project-relative so those tabs close. Subagent, tasks, and plan tabs are
   * session-scoped and stay. Idempotent when the project is unchanged.
   */
  retargetProjectTabs: (projectId: string) => void;
  /** Per-session pane snapshots, mirrored from localStorage. */
  snapshots: Record<string, PaneSessionSnapshot>;
  /** Session whose live pane state is write-through persisted. */
  activeSessionKey: string | null;
  /**
   * Mount bind: adopt the persisted snapshot for `id` when one exists
   * (refresh resilience); otherwise only arm write-through for `id` without
   * touching live state. `null` (welcome) disarms persistence.
   */
  bindSession: (
    id: string | null,
    validProjectIds?: readonly string[] | null,
  ) => void;
  /**
   * Session switch: snapshot the session being left, then restore the
   * target's own snapshot — or default to a collapsed empty pane for a
   * session never seen, so one conversation's panels never leak into
   * another. Project-scoped tabs whose workspace no longer exists are
   * dropped when `validProjectIds` is provided.
   */
  switchSession: (
    from: string | null,
    to: string | null,
    validProjectIds?: readonly string[] | null,
  ) => void;
  /** Drop a deleted session's snapshot (memory + storage). */
  forgetSession: (id: string) => void;
  setActive: (id: string) => void;
  setWidth: (n: number) => void;
  setHidden: (hidden: boolean) => void;
}

export const usePaneStore: UseBoundStore<StoreApi<PaneState>> = create<PaneState>(
  (set) => ({
    tabs: [],
    activeTabId: null,
    width: loadWidth(),
    open: false,
    hidden: false,
    snapshots: loadSnapshots(),
    activeSessionKey: null,
    openTab: (tab) =>
      set((state) => {
        const existing = state.tabs.find((t) => t.id === tab.id);
        if (existing === undefined) {
          return {
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
            hidden: false,
            open: true,
          };
        }
        if (
          existing.kind === 'file-preview' &&
          tab.kind === 'file-preview'
        ) {
          // A click without a line target only activates the existing tab —
          // it must not yank a tab that is already parked on a line target.
          const hasTarget = tab.line !== undefined || tab.endLine !== undefined;
          const targetChanged =
            hasTarget &&
            (existing.line !== tab.line || existing.endLine !== tab.endLine);
          if (!targetChanged) {
            return { activeTabId: tab.id, hidden: false, open: true };
          }
          const merged: PaneTab = { ...tab, id: existing.id };
          return {
            tabs: state.tabs.map((t) => (t.id === tab.id ? merged : t)),
            activeTabId: tab.id,
            hidden: false,
            open: true,
          };
        }
        // A file-diff tab is keyed per turn+path: re-opening it after another
        // edit in the same turn must refresh the body, not keep the stale one.
        if (existing.kind === 'file-diff' && tab.kind === 'file-diff') {
          if (existing.diff === tab.diff) {
            return { activeTabId: tab.id, hidden: false, open: true };
          }
          return {
            tabs: state.tabs.map((t) => (t.id === tab.id ? tab : t)),
            activeTabId: tab.id,
            hidden: false,
            open: true,
          };
        }
        // Subagent tabs overwrite the payload on view flip (card click opens
        // chat, "view trajectory" opens trajectory) — same tab, new view.
        // Callers that only carry a view (TrajectoryDrawer) must not wipe the
        // parent binding stamped when the tab was first opened.
        if (
          existing.kind === 'subagent' &&
          tab.kind === 'subagent' &&
          existing.view !== tab.view
        ) {
          const merged: PaneTab = {
            ...tab,
            parentSessionId: tab.parentSessionId ?? existing.parentSessionId,
          };
          return {
            tabs: state.tabs.map((t) => (t.id === tab.id ? merged : t)),
            activeTabId: tab.id,
            hidden: false,
            open: true,
          };
        }
        return { activeTabId: tab.id, hidden: false, open: true };
      }),
    openPane: () => set({ open: true, hidden: false }),
    closeTab: (id) =>
      set((state) => {
        const idx = state.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return state;
        const tabs = state.tabs.filter((t) => t.id !== id);
        if (state.activeTabId !== id) return { tabs };
        const next = tabs[Math.min(idx, tabs.length - 1)];
        return { tabs, activeTabId: next?.id ?? null };
      }),
    retargetProjectTabs: (projectId) =>
      set((state) => {
        let changed = false;
        const seen = new Set<string>();
        const tabs: PaneTab[] = [];
        for (const tab of state.tabs) {
          if (
            tab.kind === 'subagent' ||
            tab.kind === 'tasks' ||
            tab.kind === 'plan'
          ) {
            if (!seen.has(tab.id)) {
              seen.add(tab.id);
              tabs.push(tab);
            }
            continue;
          }
          if (tab.kind === 'file-preview' || tab.kind === 'file-diff') {
            // Path is relative to the old workspace — drop rather than guess.
            changed = true;
            continue;
          }
          if (tab.projectId === projectId) {
            if (!seen.has(tab.id)) {
              seen.add(tab.id);
              tabs.push(tab);
            }
            continue;
          }
          changed = true;
          const next: PaneTab = { ...tab, id: `${tab.kind}:${projectId}`, projectId };
          if (!seen.has(next.id)) {
            seen.add(next.id);
            tabs.push(next);
          }
        }
        if (!changed) return state;
        const activeTabId =
          state.activeTabId !== null && seen.has(state.activeTabId)
            ? state.activeTabId
            : (tabs[tabs.length - 1]?.id ?? null);
        return { tabs, activeTabId };
      }),
    bindSession: (id, validProjectIds = null) =>
      set((state) => {
        if (id === null) return { activeSessionKey: null };
        const snap = state.snapshots[id];
        if (snap === undefined) return { activeSessionKey: id };
        const tabs = sanitizeTabs(snap.tabs, validProjectIds);
        return {
          activeSessionKey: id,
          tabs,
          activeTabId: fallbackActive(tabs, snap.activeTabId),
          open: snap.open,
          hidden: snap.hidden,
        };
      }),
    switchSession: (from, to, validProjectIds = null) => {
      set((state) => {
        const snapshots =
          from === null
            ? state.snapshots
            : { ...state.snapshots, [from]: snapshotOf(state) };
        if (to === null) {
          return {
            snapshots,
            activeSessionKey: null,
            tabs: [],
            activeTabId: null,
            open: false,
            hidden: true,
          };
        }
        const snap = snapshots[to];
        if (snap === undefined) {
          return {
            snapshots,
            activeSessionKey: to,
            tabs: [],
            activeTabId: null,
            open: false,
            hidden: true,
          };
        }
        const tabs = sanitizeTabs(snap.tabs, validProjectIds);
        return {
          snapshots,
          activeSessionKey: to,
          tabs,
          activeTabId: fallbackActive(tabs, snap.activeTabId),
          open: snap.open,
          hidden: snap.hidden,
        };
      });
      persistNow();
    },
    forgetSession: (id) => {
      set((state) => {
        if (!(id in state.snapshots)) return state;
        const snapshots = { ...state.snapshots };
        delete snapshots[id];
        return { snapshots };
      });
      persistNow();
    },
    setActive: (id) => set({ activeTabId: id }),
    setWidth: (n) => {
      const width = clampWidth(n);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(WIDTH_KEY, String(width));
      }
      set({ width });
    },
    setHidden: (hidden) => set({ hidden }),
  }),
);

// Write-through persistence: mirror the live pane into the active session's
// snapshot and debounce the storage write. Switch/forget persist synchronously
// so a reload immediately after a switch never loses the left session's state.
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (typeof window === 'undefined') return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeSnapshots(usePaneStore.getState().snapshots);
  }, 250);
}

function persistNow(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  writeSnapshots(usePaneStore.getState().snapshots);
}

usePaneStore.subscribe((state, prev) => {
  const key = state.activeSessionKey;
  if (key === null) return;
  const liveChanged =
    state.tabs !== prev.tabs ||
    state.activeTabId !== prev.activeTabId ||
    state.open !== prev.open ||
    state.hidden !== prev.hidden;
  if (!liveChanged && key === prev.activeSessionKey) return;
  // The mirror setState re-enters this subscriber with liveChanged=false and
  // an unchanged key, so it terminates after one extra pass.
  usePaneStore.setState({
    snapshots: { ...state.snapshots, [key]: snapshotOf(state) },
  });
  schedulePersist();
});

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', persistNow);
}

/** Stable tab id for a file preview — one tab per project+path. */
export function filePreviewTabId(projectId: string, path: string): string {
  return `preview:${projectId}:${path}`;
}

/**
 * Open (or activate) the file-preview tab for a project file. Used by every
 * message surface (markdown refs, tool cards) and by the file tree, so the
 * dedupe id convention lives in one place. `ref` targets a line range.
 */
export function openFilePreview(
  projectId: string,
  path: string,
  ref?: { line?: number; endLine?: number },
): void {
  usePaneStore.getState().openTab({
    kind: 'file-preview',
    id: filePreviewTabId(projectId, path),
    projectId,
    path,
    ...(ref?.line !== undefined ? { line: ref.line } : {}),
    ...(ref?.endLine !== undefined ? { endLine: ref.endLine } : {}),
  });
}

/** Stable tab id for a file's diff in one turn — one tab per project+turn+path. */
export function fileDiffTabId(projectId: string, turn: string, path: string): string {
  return `diff:${projectId}:${turn}:${path}`;
}

/**
 * Open (or refresh) the diff tab for one file's changes in one turn. Used by
 * the turn-end change card; the body travels with the payload because it was
 * captured at edit time and is already in the transcript.
 */
export function openFileDiffTab(input: {
  projectId: string;
  path: string;
  turn: string;
  diff: string;
  additions: number;
  deletions: number;
  edits: number;
  truncated?: boolean;
}): void {
  usePaneStore.getState().openTab({
    kind: 'file-diff',
    id: fileDiffTabId(input.projectId, input.turn, input.path),
    projectId: input.projectId,
    path: input.path,
    turn: input.turn,
    diff: input.diff,
    additions: input.additions,
    deletions: input.deletions,
    edits: input.edits,
    ...(input.truncated === true ? { truncated: true } : {}),
  });
}

/**
 * Open the singleton background-tasks tab. Session-scoped (not project-scoped):
 * the id is always `tasks`, so re-open dedupes and activates the same tab.
 */
export function openTasksTab(): void {
  usePaneStore.getState().openTab({ kind: 'tasks', id: 'tasks' });
}
