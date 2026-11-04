import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { Markdown } from '@/components/chat/Markdown';
import { AnswerRow } from '@/components/chat/AnswerRow';
import { usePaneStore } from '@/stores/pane-store';

const OPEN = '在右侧面板打开';

beforeEach(() => {
  usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: true });
});

describe('Markdown file references', () => {
  it('opens an inline-code project path in the right pane', () => {
    render(<Markdown content={'改了 `src/foo.ts` 这个文件'} projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: `${OPEN} src/foo.ts` }));
    expect(usePaneStore.getState().tabs).toEqual([
      {
        kind: 'file-preview',
        id: 'preview:p1:src/foo.ts',
        projectId: 'p1',
        path: 'src/foo.ts',
      },
    ]);
  });

  it('passes the line target of a path:line ref', () => {
    render(<Markdown content={'看 `src/foo.ts:42`'} projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: `${OPEN} src/foo.ts` }));
    expect(usePaneStore.getState().tabs[0]).toMatchObject({ path: 'src/foo.ts', line: 42 });
  });

  it('does not linkify ordinary inline code', () => {
    render(<Markdown content={'`e.g.` 和 `npm run build`'} projectId="p1" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

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

  it('renders no clickable refs when the owning project is unknown', () => {
    render(<Markdown content={'`src/foo.ts` [x](src/bar.ts)'} projectId={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('AnswerRow file link binding', () => {
  it('opens refs under the project the content belongs to', () => {
    render(
      <AnswerRow
        blocks={[{ type: 'text', text: '`src/foo.ts`' }]}
        fileProjectId="pOwned"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: `${OPEN} src/foo.ts` }));
    expect(usePaneStore.getState().tabs[0]).toMatchObject({ projectId: 'pOwned' });
  });
});

describe('Markdown non-file refs stay plain', () => {
  it('does not linkify directory refs', () => {
    render(<Markdown content={'见 `packages/tools/` 与 `providers/` 目录'} projectId="p1" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not linkify npm-scope package names', () => {
    render(<Markdown content={'`@volto/core` 是零依赖内核'} projectId="p1" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a relative non-file link inert instead of a dead anchor', () => {
    render(<Markdown content={'[License](LICENSE)'} projectId="p1" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
