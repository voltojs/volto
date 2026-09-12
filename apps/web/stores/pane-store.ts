/**
 * RightPane 的标签状态：tabs（有序）+ activeTabId + width。
 * PaneTab 是判别联合——每个标签自带数据引用（childSessionId / projectId /
 * projectId+path），因此切会话不清空标签，跨会话内容各自成立。
 * tabs 纯内存（刷新即空，重新点开即可）；只有 width 持久化。
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';

export type PaneTab =
  | { kind: 'subagent'; id: string; childSessionId: string; view: 'chat' | 'trajectory' }
  | { kind: 'files'; id: string; projectId: string }
  | { kind: 'file-preview'; id: string; projectId: string; path: string };

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
  openTab: (tab: PaneTab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  setWidth: (n: number) => void;
}

export const usePaneStore: UseBoundStore<StoreApi<PaneState>> = create<PaneState>(
  (set) => ({
    tabs: [],
    activeTabId: null,
    width: loadWidth(),
    openTab: (tab) =>
      set((state) => {
        const existing = state.tabs.find((t) => t.id === tab.id);
        if (existing === undefined) {
          return { tabs: [...state.tabs, tab], activeTabId: tab.id };
        }
        // 子代理标签的 view 随载荷覆盖：卡片点击开 chat，「查看执行过程」
        // 开 trajectory——同一标签只换视图不新建。
        if (
          existing.kind === 'subagent' &&
          tab.kind === 'subagent' &&
          existing.view !== tab.view
        ) {
          return {
            tabs: state.tabs.map((t) => (t.id === tab.id ? tab : t)),
            activeTabId: tab.id,
          };
        }
        return { activeTabId: tab.id };
      }),
    closeTab: (id) =>
      set((state) => {
        const idx = state.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return state;
        const tabs = state.tabs.filter((t) => t.id !== id);
        if (state.activeTabId !== id) return { tabs };
        const next = tabs[Math.min(idx, tabs.length - 1)];
        return { tabs, activeTabId: next?.id ?? null };
      }),
    setActive: (id) => set({ activeTabId: id }),
    setWidth: (n) => {
      const width = clampWidth(n);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(WIDTH_KEY, String(width));
      }
      set({ width });
    },
  }),
);
