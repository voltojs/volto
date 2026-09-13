// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  usePaneStore,
  PANE_WIDTH_MIN,
  PANE_WIDTH_MAX,
  PANE_WIDTH_DEFAULT,
  type PaneTab,
} from '@/stores/pane-store';

const subagentTab = (childId: string): PaneTab => ({
  kind: 'subagent', id: `subagent:${childId}`, childSessionId: childId, view: 'chat' as const,
});

beforeEach(() => {
  usePaneStore.setState({ tabs: [], activeTabId: null, width: PANE_WIDTH_DEFAULT, hidden: false });
  window.localStorage.clear();
});

describe('openTab', () => {
  it('appends and activates a new tab', () => {
    usePaneStore.getState().openTab(subagentTab('a'));
    usePaneStore.getState().openTab(subagentTab('b'));
    expect(
      usePaneStore.getState().tabs.filter((t) => t.kind === 'subagent').map((t) => t.childSessionId),
    ).toEqual(['a', 'b']);
    expect(usePaneStore.getState().activeTabId).toBe('subagent:b');
  });

  it('dedupes by id and only activates', () => {
    usePaneStore.getState().openTab(subagentTab('a'));
    usePaneStore.getState().openTab(subagentTab('b'));
    usePaneStore.getState().openTab(subagentTab('a'));
    expect(usePaneStore.getState().tabs).toHaveLength(2);
    expect(usePaneStore.getState().activeTabId).toBe('subagent:a');
  });

  it('overwrites the subagent view and re-activates on re-open', () => {
    usePaneStore.getState().openTab({ kind: 'subagent', id: 'subagent:a', childSessionId: 'a', view: 'chat' });
    usePaneStore.getState().openTab(subagentTab('b')); // 激活别的标签
    usePaneStore.getState().openTab({ kind: 'subagent', id: 'subagent:a', childSessionId: 'a', view: 'trajectory' });
    expect(usePaneStore.getState().tabs).toHaveLength(2);
    expect(usePaneStore.getState().tabs.find((t) => t.id === 'subagent:a')).toMatchObject({ view: 'trajectory' });
    expect(usePaneStore.getState().activeTabId).toBe('subagent:a');
  });
});

describe('closeTab', () => {
  it('activates the right neighbor, falling back to the left', () => {
    usePaneStore.getState().openTab(subagentTab('a'));
    usePaneStore.getState().openTab(subagentTab('b'));
    usePaneStore.getState().openTab(subagentTab('c'));
    usePaneStore.getState().setActive('subagent:b');
    usePaneStore.getState().closeTab('subagent:b');
    expect(usePaneStore.getState().activeTabId).toBe('subagent:c');
    usePaneStore.getState().closeTab('subagent:c');
    expect(usePaneStore.getState().activeTabId).toBe('subagent:a');
  });

  it('clears activeTabId when the last tab closes', () => {
    usePaneStore.getState().openTab(subagentTab('a'));
    usePaneStore.getState().closeTab('subagent:a');
    expect(usePaneStore.getState().tabs).toHaveLength(0);
    expect(usePaneStore.getState().activeTabId).toBeNull();
  });

  it('ignores an unknown id', () => {
    usePaneStore.getState().closeTab('nope');
    expect(usePaneStore.getState().tabs).toHaveLength(0);
  });
});

describe('hidden', () => {
  it('hides the pane without dropping tabs; setHidden(false) restores', () => {
    usePaneStore.getState().openTab(subagentTab('a'));
    usePaneStore.getState().setHidden(true);
    expect(usePaneStore.getState().hidden).toBe(true);
    expect(usePaneStore.getState().tabs).toHaveLength(1);
    usePaneStore.getState().setHidden(false);
    expect(usePaneStore.getState().hidden).toBe(false);
  });

  it('openTab unhides a hidden pane', () => {
    usePaneStore.getState().openTab(subagentTab('a'));
    usePaneStore.getState().setHidden(true);
    usePaneStore.getState().openTab(subagentTab('a'));
    expect(usePaneStore.getState().hidden).toBe(false);
  });
});

describe('width', () => {
  it('clamps setWidth into [320, 720] and persists', () => {
    usePaneStore.getState().setWidth(50);
    expect(usePaneStore.getState().width).toBe(PANE_WIDTH_MIN);
    usePaneStore.getState().setWidth(9999);
    expect(usePaneStore.getState().width).toBe(PANE_WIDTH_MAX);
    expect(window.localStorage.getItem('volto.pane.width')).toBe(String(PANE_WIDTH_MAX));
  });

  it('loads a persisted width on store creation', async () => {
    window.localStorage.setItem('volto.pane.width', '560');
    vi.resetModules();
    const mod = await import('@/stores/pane-store');
    expect(mod.usePaneStore.getState().width).toBe(560);
  });
});
