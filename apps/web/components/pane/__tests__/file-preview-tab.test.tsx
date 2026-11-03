import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePreviewTab } from '../FilePreviewTab';
import { fetchFsFile, type FsFilePayload } from '@/lib/fs-api';
import type { PaneTab } from '@/stores/pane-store';

vi.mock('@/lib/fs-api', () => ({
  fetchFsFile: vi.fn(),
}));

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

function textPayload(content: string): FsFilePayload {
  return { kind: 'text', content, truncated: false, size: content.length };
}

function makeTab(overrides: Partial<Extract<PaneTab, { kind: 'file-preview' }>> = {}): PaneTab {
  return {
    kind: 'file-preview',
    id: 'preview:p1:a.ts',
    projectId: 'p1',
    path: 'a.ts',
    ...overrides,
  };
}

const scrollIntoView = vi.fn();

/** hljs splits text across spans, so wait on the row anchors instead of text. */
async function waitForRows(n: number): Promise<void> {
  await waitFor(() => expect(document.querySelectorAll('[data-line]')).toHaveLength(n));
}

beforeEach(() => {
  vi.mocked(fetchFsFile).mockReset();
  scrollIntoView.mockReset();
  // jsdom has no layout; record the scroll target instead of performing it.
  Element.prototype.scrollIntoView = scrollIntoView;
});

describe('FilePreviewTab line targeting', () => {
  it('renders one anchored row per line of the file', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab()} />);
    await waitForRows(10);
    for (let n = 1; n <= 10; n += 1) {
      expect(document.querySelector(`[data-line="${n}"]`)).not.toBeNull();
    }
  });

  it('highlights only the targeted line', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab({ line: 3 })} />);
    await waitForRows(10);
    const highlighted = [...document.querySelectorAll('[data-line]')].filter((el) =>
      el.className.includes('bg-primary/10'),
    );
    expect(highlighted.map((el) => el.getAttribute('data-line'))).toEqual(['3']);
  });

  it('highlights the whole range of a range target', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab({ line: 3, endLine: 5 })} />);
    await waitForRows(10);
    const highlighted = [...document.querySelectorAll('[data-line]')].filter((el) =>
      el.className.includes('bg-primary/10'),
    );
    expect(highlighted.map((el) => el.getAttribute('data-line'))).toEqual(['3', '4', '5']);
  });

  it('scrolls the target line into view once the file is loaded', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab({ line: 3 })} />);
    await waitForRows(10);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const target = scrollIntoView.mock.contexts[0] as Element;
    expect(target.getAttribute('data-line')).toBe('3');
  });

  it('does not scroll when the tab carries no line target', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab()} />);
    await waitForRows(10);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('moves the highlight when the line target changes without a remount', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    const { rerender } = render(<FilePreviewTab tab={makeTab({ line: 3 })} />);
    await waitForRows(10);
    rerender(<FilePreviewTab tab={makeTab({ line: 7 })} />);
    await waitFor(() => {
      const highlighted = [...document.querySelectorAll('[data-line]')].filter((el) =>
        el.className.includes('bg-primary/10'),
      );
      expect(highlighted.map((el) => el.getAttribute('data-line'))).toEqual(['7']);
    });
  });
});
