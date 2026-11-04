/**
 * RightPane 的标签状态：tabs（有序）+ activeTabId + width。
 * PaneTab 是判别联合——每个标签自带数据引用（childSessionId / projectId /
 * projectId+path）。子代理标签跨会话保留；files / git-graph 在工作区切换时
 * 经 retargetProjectTabs 指向新项目。tabs 纯内存（刷新即空，重新点开即可）；
 * 只有 width 持久化。
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
  /** 面板折叠：标签保留，仅隐藏渲染——Header 的切换按钮负责翻转。 */
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
          if (tab.kind === 'file-preview') {
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

/**
 * Open the singleton background-tasks tab. Session-scoped (not project-scoped):
 * the id is always `tasks`, so re-open dedupes and activates the same tab.
 */
export function openTasksTab(): void {
  usePaneStore.getState().openTab({ kind: 'tasks', id: 'tasks' });
}
