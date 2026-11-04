// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRefFallback } from '../open-file-ref';
import { searchFsFiles } from '@/lib/fs-api';
import { usePaneStore } from '@/stores/pane-store';

vi.mock('@/lib/fs-api', () => ({ searchFsFiles: vi.fn() }));
const searchMock = vi.mocked(searchFsFiles);

beforeEach(() => {
  searchMock.mockReset();
  usePaneStore.setState({
    tabs: [],
    activeTabId: null,
    open: false,
    hidden: true,
    treeReveal: null,
    treeSearch: null,
  });
});

describe('resolveRefFallback', () => {
  it('opens the unique suffix match in the preview, keeping the line target', async () => {
    searchMock.mockResolvedValue({
      matches: [{ path: 'packages/core/src/step.ts', type: 'file' }],
    });
    const result = await resolveRefFallback('p1', { path: 'core/src/step.ts', line: 42 });
    expect(result).toEqual({
      kind: 'resolved',
      target: { path: 'packages/core/src/step.ts', type: 'file' },
    });
    expect(usePaneStore.getState().tabs).toEqual([
      {
        kind: 'file-preview',
        id: 'preview:p1:packages/core/src/step.ts',
        projectId: 'p1',
        path: 'packages/core/src/step.ts',
        line: 42,
      },
    ]);
  });

  it('reveals a unique directory match in the tree', async () => {
    searchMock.mockResolvedValue({
      matches: [{ path: 'packages/providers', type: 'dir' }],
    });
    const result = await resolveRefFallback('p1', { path: 'providers', kind: 'dir' });
    expect(result.kind).toBe('resolved');
    expect(usePaneStore.getState().treeReveal).toMatchObject({
      projectId: 'p1',
      dir: 'packages/providers',
    });
  });

  it('arms the tree search when several candidates tie', async () => {
    searchMock.mockResolvedValue({
      matches: [
        { path: 'a/providers', type: 'dir' },
        { path: 'b/providers', type: 'dir' },
      ],
    });
    const result = await resolveRefFallback('p1', { path: 'providers', kind: 'dir' });
    expect(result).toEqual({ kind: 'search' });
    expect(usePaneStore.getState().treeSearch).toMatchObject({
      projectId: 'p1',
      query: 'providers',
    });
  });

  it('reports none when the search fails or finds nothing usable', async () => {
    searchMock.mockRejectedValueOnce(new Error('boom'));
    expect(await resolveRefFallback('p1', { path: 'x.ts' })).toEqual({ kind: 'none' });
    searchMock.mockResolvedValueOnce({ matches: [] });
    expect(await resolveRefFallback('p1', { path: 'x.ts' })).toEqual({ kind: 'none' });
  });

  it('never resolves a ref to the exact path that just failed', async () => {
    searchMock.mockResolvedValue({ matches: [{ path: 'x.ts', type: 'file' }] });
    expect(await resolveRefFallback('p1', { path: 'x.ts' })).toEqual({ kind: 'none' });
  });
});
