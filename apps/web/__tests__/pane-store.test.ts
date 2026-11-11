// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fileDiffTabId,
  filePreviewTabId,
  openFileDiffTab,
  openFilePreview,
  usePaneStore,
  PANE_WIDTH_MIN,
  PANE_WIDTH_MAX,
  PANE_WIDTH_DEFAULT,
  type PaneTab,
} from '@/stores/pane-store';

const subagentTab = (childId: string, parentSessionId?: string): PaneTab => ({
  kind: 'subagent', id: `subagent:${childId}`, childSessionId: childId, view: 'chat' as const,
  ...(parentSessionId !== undefined ? { parentSessionId } : {}),
});

beforeEach(() => {
  usePaneStore.setState({
    tabs: [],
    activeTabId: null,
    width: PANE_WIDTH_DEFAULT,
    open: false,
    hidden: false,
    snapshots: {},
    activeSessionKey: null,
  });
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

  it('keeps parentSessionId when a view-flip payload omits it', () => {
    usePaneStore.getState().openTab(subagentTab('a', 's1'));
    // TrajectoryDrawer opens with view only — it must not drop the binding.
    usePaneStore.getState().openTab({
      kind: 'subagent', id: 'subagent:a', childSessionId: 'a', view: 'trajectory',
    });
    expect(usePaneStore.getState().tabs.find((t) => t.id === 'subagent:a'))
      .toMatchObject({ view: 'trajectory', parentSessionId: 's1' });
  });

  it('lets a view-flip payload replace parentSessionId when it carries one', () => {
    usePaneStore.getState().openTab(subagentTab('a', 's1'));
    usePaneStore.getState().openTab({
      kind: 'subagent', id: 'subagent:a', childSessionId: 'a', view: 'trajectory', parentSessionId: 's2',
    });
    expect(usePaneStore.getState().tabs.find((t) => t.id === 'subagent:a'))
      .toMatchObject({ parentSessionId: 's2' });
  });
});

describe('git-graph tabs', () => {
  it('dedupes by id and activates on re-open', () => {
    usePaneStore.getState().openTab({ kind: 'git-graph', id: 'git-graph:p1', projectId: 'p1' });
    usePaneStore.getState().openTab({ kind: 'git-graph', id: 'git-graph:p1', projectId: 'p1' });
    expect(usePaneStore.getState().tabs).toHaveLength(1);
    expect(usePaneStore.getState().activeTabId).toBe('git-graph:p1');
  });

  it('closing the last tab clears tabs but keeps the pane unhidden', () => {
    usePaneStore.getState().openTab({ kind: 'git-graph', id: 'git-graph:p1', projectId: 'p1' });
    usePaneStore.getState().closeTab('git-graph:p1');
    expect(usePaneStore.getState().tabs).toHaveLength(0);
    expect(usePaneStore.getState().activeTabId).toBeNull();
    expect(usePaneStore.getState().hidden).toBe(false);
  });
});

describe('retargetProjectTabs', () => {
  it('points files and git-graph at the new workspace and keeps subagent tabs', () => {
    usePaneStore.getState().openTab({ kind: 'files', id: 'files:p1', projectId: 'p1' });
    usePaneStore.getState().openTab({ kind: 'git-graph', id: 'git-graph:p1', projectId: 'p1' });
    usePaneStore.getState().openTab(subagentTab('child-1'));
    usePaneStore.getState().retargetProjectTabs('p2');
    expect(usePaneStore.getState().tabs).toEqual([
      { kind: 'files', id: 'files:p2', projectId: 'p2' },
      { kind: 'git-graph', id: 'git-graph:p2', projectId: 'p2' },
      subagentTab('child-1'),
    ]);
    expect(usePaneStore.getState().activeTabId).toBe('subagent:child-1');
  });

  it('closes file-preview tabs because their path belongs to the old workspace', () => {
    usePaneStore.getState().openTab({ kind: 'files', id: 'files:p1', projectId: 'p1' });
    usePaneStore.getState().openTab({
      kind: 'file-preview',
      id: 'preview:p1:src/a.ts',
      projectId: 'p1',
      path: 'src/a.ts',
    });
    usePaneStore.getState().setActive('preview:p1:src/a.ts');
    usePaneStore.getState().retargetProjectTabs('p2');
    expect(usePaneStore.getState().tabs).toEqual([
      { kind: 'files', id: 'files:p2', projectId: 'p2' },
    ]);
    // Active preview was dropped — fall back to the remaining tab.
    expect(usePaneStore.getState().activeTabId).toBe('files:p2');
  });

  it('is a no-op when the project is unchanged', () => {
    usePaneStore.getState().openTab({ kind: 'files', id: 'files:p1', projectId: 'p1' });
    const before = usePaneStore.getState().tabs;
    usePaneStore.getState().retargetProjectTabs('p1');
    expect(usePaneStore.getState().tabs).toBe(before);
  });

  it('dedupes when a tab for the target project already exists', () => {
    usePaneStore.getState().openTab({ kind: 'files', id: 'files:p1', projectId: 'p1' });
    usePaneStore.getState().openTab({ kind: 'files', id: 'files:p2', projectId: 'p2' });
    usePaneStore.getState().retargetProjectTabs('p2');
    expect(usePaneStore.getState().tabs).toEqual([
      { kind: 'files', id: 'files:p2', projectId: 'p2' },
    ]);
  });
});

describe('open', () => {
  it('openTab marks the pane open', () => {
    usePaneStore.getState().openTab(subagentTab('a'));
    expect(usePaneStore.getState().open).toBe(true);
  });

  it('openPane opens with zero tabs and keeps the pane unhidden', () => {
    usePaneStore.getState().openPane();
    expect(usePaneStore.getState().open).toBe(true);
    expect(usePaneStore.getState().hidden).toBe(false);
    expect(usePaneStore.getState().tabs).toHaveLength(0);
  });

  it('closing the last tab keeps the pane open', () => {
    usePaneStore.getState().openTab(subagentTab('a'));
    usePaneStore.getState().closeTab('subagent:a');
    expect(usePaneStore.getState().open).toBe(true);
    expect(usePaneStore.getState().hidden).toBe(false);
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

describe('tasks tab', () => {
  it('dedupes by id tasks and activates on re-open', () => {
    usePaneStore.getState().openTab({ kind: 'tasks', id: 'tasks' });
    usePaneStore.getState().openTab({ kind: 'tasks', id: 'tasks' });
    expect(usePaneStore.getState().tabs).toHaveLength(1);
    expect(usePaneStore.getState().activeTabId).toBe('tasks');
  });

  it('is kept by retargetProjectTabs', () => {
    usePaneStore.getState().openTab({ kind: 'tasks', id: 'tasks' });
    usePaneStore.getState().openTab({ kind: 'files', id: 'files:p1', projectId: 'p1' });
    usePaneStore.getState().retargetProjectTabs('p2');
    expect(usePaneStore.getState().tabs).toEqual([
      { kind: 'tasks', id: 'tasks' },
      { kind: 'files', id: 'files:p2', projectId: 'p2' },
    ]);
  });
});

describe('switchSession / bindSession (per-session memory)', () => {
  it('snapshots the left session and restores it on return', () => {
    usePaneStore.getState().openTab({ kind: 'files', id: 'files:p1', projectId: 'p1' });
    usePaneStore.getState().openTab(subagentTab('a', 's1'));
    usePaneStore.getState().openTab({ kind: 'plan', id: 's1', sessionId: 's1' });
    usePaneStore.getState().switchSession('s1', 's2');

    // Never-seen target: collapsed empty pane, previous tabs not leaked.
    let s = usePaneStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
    expect(s.hidden).toBe(true);
    expect(s.activeSessionKey).toBe('s2');

    // Give s2 its own tab, then return to s1.
    usePaneStore.getState().openTab({ kind: 'tasks', id: 'tasks' });
    usePaneStore.getState().switchSession('s2', 's1');
    s = usePaneStore.getState();
    expect(s.tabs).toEqual([
      { kind: 'files', id: 'files:p1', projectId: 'p1' },
      subagentTab('a', 's1'),
      { kind: 'plan', id: 's1', sessionId: 's1' },
    ]);
    expect(s.activeTabId).toBe('s1');
    expect(s.hidden).toBe(false);
    expect(s.open).toBe(true);

    // s2 kept its own state, independent of s1.
    usePaneStore.getState().switchSession('s1', 's2');
    expect(usePaneStore.getState().tabs).toEqual([{ kind: 'tasks', id: 'tasks' }]);
  });

  it('switching to null collapses and clears; the left session is still remembered', () => {
    usePaneStore.getState().openTab(subagentTab('a', 's1'));
    usePaneStore.getState().switchSession('s1', null);
    let s = usePaneStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.hidden).toBe(true);
    expect(s.activeSessionKey).toBeNull();
    usePaneStore.getState().switchSession(null, 's1');
    s = usePaneStore.getState();
    expect(s.tabs).toEqual([subagentTab('a', 's1')]);
  });

  it('bindSession restores a snapshot but leaves live state untouched without one', () => {
    usePaneStore.getState().openTab(subagentTab('a', 's1'));
    usePaneStore.getState().switchSession('s1', 's2');
    // Mount into s1 again: snapshot restored.
    usePaneStore.getState().bindSession('s1');
    expect(usePaneStore.getState().tabs).toEqual([subagentTab('a', 's1')]);
    // Mount into an unknown session: live state preserved, key armed.
    usePaneStore.setState({ tabs: [{ kind: 'tasks', id: 'tasks' }], open: true, hidden: false });
    usePaneStore.getState().bindSession('s9');
    const s = usePaneStore.getState();
    expect(s.tabs).toEqual([{ kind: 'tasks', id: 'tasks' }]);
    expect(s.open).toBe(true);
    expect(s.activeSessionKey).toBe('s9');
  });

  it('drops workspace tabs whose project no longer exists on restore', () => {
    usePaneStore.getState().openTab({ kind: 'files', id: 'files:p1', projectId: 'p1' });
    usePaneStore.getState().openTab(subagentTab('a', 's1'));
    usePaneStore.getState().switchSession('s1', 's2');
    usePaneStore.getState().switchSession('s2', 's1', ['p2']);
    const s = usePaneStore.getState();
    expect(s.tabs).toEqual([subagentTab('a', 's1')]);
  });

  it('forgetSession prunes memory and storage', () => {
    usePaneStore.getState().openTab(subagentTab('a', 's1'));
    usePaneStore.getState().switchSession('s1', 's2');
    expect(usePaneStore.getState().snapshots['s1']).toBeDefined();
    usePaneStore.getState().forgetSession('s1');
    expect(usePaneStore.getState().snapshots['s1']).toBeUndefined();
    const stored = JSON.parse(window.localStorage.getItem('volto.pane.sessions') ?? '{}');
    expect(stored['s1']).toBeUndefined();
  });

  it('persists snapshots to localStorage and reloads them on module init', async () => {
    usePaneStore.getState().openTab(subagentTab('a', 's1'));
    usePaneStore.getState().switchSession('s1', 's2');
    const raw = window.localStorage.getItem('volto.pane.sessions');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)['s1'].tabs).toEqual([subagentTab('a', 's1')]);
    vi.resetModules();
    const mod = await import('@/stores/pane-store');
    expect(mod.usePaneStore.getState().snapshots['s1']?.tabs).toEqual([subagentTab('a', 's1')]);
  });

  it('evicts least-recently-used snapshots beyond the cap', () => {
    // Guarantee strictly increasing usedAt so LRU ordering is deterministic
    // even when 150 switches land within one real millisecond.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
    usePaneStore.getState().openTab({ kind: 'tasks', id: 'tasks' });
    for (let i = 0; i < 150; i++) {
      usePaneStore.getState().switchSession(i === 0 ? null : `s${i - 1}`, `s${i}`);
    }
    const stored = JSON.parse(window.localStorage.getItem('volto.pane.sessions') ?? '{}');
    expect(Object.keys(stored).length).toBeLessThanOrEqual(100);
    // The oldest session was evicted; the newest survives.
    expect(stored['s0']).toBeUndefined();
    expect(stored['s149']).toBeDefined();
    nowSpy.mockRestore();
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

describe('openFilePreview', () => {
  it('opens a file-preview tab and reveals the collapsed pane', () => {
    usePaneStore.setState({ hidden: true, open: false });
    openFilePreview('p1', 'src/foo.ts');
    const s = usePaneStore.getState();
    expect(s.open).toBe(true);
    expect(s.hidden).toBe(false);
    expect(s.tabs).toEqual([
      {
        kind: 'file-preview',
        id: filePreviewTabId('p1', 'src/foo.ts'),
        projectId: 'p1',
        path: 'src/foo.ts',
      },
    ]);
    expect(s.activeTabId).toBe(filePreviewTabId('p1', 'src/foo.ts'));
  });

  it('dedupes by project+path and updates the line target on re-click', () => {
    openFilePreview('p1', 'src/foo.ts', { line: 5 });
    openFilePreview('p1', 'src/foo.ts', { line: 9, endLine: 12 });
    const s = usePaneStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ line: 9, endLine: 12 });
    expect(s.activeTabId).toBe(filePreviewTabId('p1', 'src/foo.ts'));
  });

  it('keeps the existing line target when the file is re-opened without one', () => {
    openFilePreview('p1', 'src/foo.ts', { line: 5 });
    openFilePreview('p1', 'src/foo.ts');
    const s = usePaneStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ line: 5 });
  });

  it('opens separate tabs for different files and activates the newest', () => {
    openFilePreview('p1', 'a.ts');
    openFilePreview('p1', 'b.ts');
    const s = usePaneStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe(filePreviewTabId('p1', 'b.ts'));
  });

  it('treats the same path in different projects as different tabs', () => {
    openFilePreview('p1', 'a.ts');
    openFilePreview('p2', 'a.ts');
    const s = usePaneStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe(filePreviewTabId('p2', 'a.ts'));
  });
});

describe('openFileDiffTab', () => {
  const diff = (body: string) => ({
    projectId: 'p1',
    path: 'src/a.ts',
    turn: '2',
    diff: body,
    additions: 1,
    deletions: 1,
    edits: 1,
  });

  it('opens one tab per project+turn+path and activates it', () => {
    openFileDiffTab(diff('@@ -1,1 +1,1 @@\n-a\n+b'));
    const s = usePaneStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ kind: 'file-diff', path: 'src/a.ts', turn: '2' });
    expect(s.activeTabId).toBe(fileDiffTabId('p1', '2', 'src/a.ts'));
  });

  it('keeps the same file separate across turns', () => {
    openFileDiffTab(diff('@@ -1,1 +1,1 @@\n-a\n+b'));
    openFileDiffTab({ ...diff('@@ -1,1 +1,1 @@\n-c\n+d'), turn: '3' });
    const s = usePaneStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe(fileDiffTabId('p1', '3', 'src/a.ts'));
  });

  it('refreshes the body when the same turn edits the file again', () => {
    openFileDiffTab(diff('@@ -1,1 +1,1 @@\n-a\n+b'));
    openFileDiffTab({ ...diff('@@ -2,1 +2,1 @@\n-c\n+d'), additions: 4, edits: 2 });
    const s = usePaneStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ additions: 4, edits: 2 });
    expect(s.tabs[0]).toMatchObject({ diff: '@@ -2,1 +2,1 @@\n-c\n+d' });
  });

  it('drops diff tabs when the workspace switches (paths are project-relative)', () => {
    openFileDiffTab(diff('@@ -1,1 +1,1 @@\n-a\n+b'));
    usePaneStore.getState().retargetProjectTabs('p2');
    expect(usePaneStore.getState().tabs).toHaveLength(0);
  });
});
