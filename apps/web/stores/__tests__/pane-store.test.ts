import { beforeEach, describe, expect, it } from 'vitest';
import { filePreviewTabId, openFilePreview, usePaneStore } from '../pane-store';

function resetPane(): void {
  usePaneStore.setState({
    tabs: [],
    activeTabId: null,
    open: false,
    hidden: true,
  });
}

describe('openFilePreview', () => {
  beforeEach(resetPane);

  it('opens a file-preview tab and reveals the collapsed pane', () => {
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
