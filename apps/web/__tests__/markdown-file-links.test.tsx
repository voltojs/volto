import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { Markdown } from '@/components/chat/Markdown';
import { AnswerRow } from '@/components/chat/AnswerRow';
import { usePaneStore } from '@/stores/pane-store';
import type { RefAnnotation } from '@voltojs/sdk/file-refs';

const OPEN = '在右侧面板打开';

beforeEach(() => {
  usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: true });
});

describe('Markdown annotated references', () => {
  it('binds annotations to the matching inline-code span by offset', () => {
    const content = 'text `a.ts` and `b.ts`';
    const refs: RefAnnotation[] = [{ start: 17, end: 21, path: 'b.ts', source: 'session' }];
    render(<Markdown content={content} projectId="p1" refs={refs} />);
    expect(screen.queryByRole('button', { name: `${OPEN} a.ts` })).toBeNull();
    expect(screen.getByRole('button', { name: `${OPEN} b.ts` })).toBeDefined();
  });

  it('renders unannotated code plain', () => {
    render(<Markdown content={'text `a.ts` and `b.ts`'} projectId="p1" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens the annotated path with its line target', () => {
    const content = 'see `apps/web/lib/fs-api.ts:42`';
    const refs: RefAnnotation[] = [
      { start: 5, end: 30, path: 'apps/web/lib/fs-api.ts', line: 42, source: 'exact' },
    ];
    render(<Markdown content={content} projectId="p1" refs={refs} />);
    fireEvent.click(screen.getByRole('button', { name: `${OPEN} apps/web/lib/fs-api.ts` }));
    expect(usePaneStore.getState().tabs[0]).toMatchObject({
      path: 'apps/web/lib/fs-api.ts',
      line: 42,
    });
  });

  it('does not annotate fenced code', () => {
    const content = ['```ts', 'const s = `x.ts`;', '```'].join('\n');
    // Stale annotation pointing at the fenced span must not produce a chip.
    const refs: RefAnnotation[] = [{ start: 17, end: 21, path: 'x.ts', source: 'exact' }];
    render(<Markdown content={content} projectId="p1" refs={refs} />);
    // Scoped to the file chip's name: the code block's copy button is fine.
    expect(screen.queryByRole('button', { name: `${OPEN} x.ts` })).toBeNull();
  });

  it('keeps annotated refs inert when the owning project is unknown', () => {
    const refs: RefAnnotation[] = [{ start: 5, end: 9, path: 'a.ts', source: 'exact' }];
    render(<Markdown content={'see `a.ts`'} projectId={null} refs={refs} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Markdown links', () => {
  it('opens a project file link in the pane instead of a new tab', () => {
    render(<Markdown content={'[说明](src/foo.ts)'} projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: `${OPEN} src/foo.ts` }));
    expect(usePaneStore.getState().tabs[0]).toMatchObject({ path: 'src/foo.ts', projectId: 'p1' });
  });

  it('keeps external links as anchors', () => {
    render(<Markdown content={'[ex](https://example.com/a.ts)'} projectId="p1" />);
    const anchor = screen.getByRole('link');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('resolves link hrefs against the link base directory', () => {
    render(<Markdown content={'[x](./other.md)'} projectId="p1" linkBase="docs" />);
    fireEvent.click(screen.getByRole('button', { name: `${OPEN} docs/other.md` }));
    expect(usePaneStore.getState().tabs[0]).toMatchObject({ path: 'docs/other.md' });
  });

  it('does not linkify links that escape the project root', () => {
    render(<Markdown content={'[x](../../up.ts)'} projectId="p1" linkBase="docs" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a relative non-file link inert instead of a dead anchor', () => {
    render(<Markdown content={'[License](LICENSE)'} projectId="p1" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('Markdown non-file refs stay plain', () => {
  it('does not linkify directory refs', () => {
    render(<Markdown content={'见 `packages/tools/` 与 `providers/` 目录'} projectId="p1" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not linkify npm-scope package names', () => {
    render(<Markdown content={'`@voltojs/core` 是零依赖内核'} projectId="p1" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('AnswerRow blockRefs threading', () => {
  it('opens annotated refs under the project the content belongs to', () => {
    render(
      <AnswerRow
        blocks={[{ type: 'text', text: 'see `a.ts`' }]}
        fileProjectId="pOwned"
        blockRefs={[[{ start: 5, end: 9, path: 'src/a.ts', source: 'session' }]]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: `${OPEN} src/a.ts` }));
    expect(usePaneStore.getState().tabs[0]).toMatchObject({
      projectId: 'pOwned',
      path: 'src/a.ts',
    });
  });
});
