/**
 * Sidebar session rows: an overflowing title scrolls its full text through
 * on hover (marquee), the tooltip carries the full title plus the updated
 * time, and the hover actions are the pin toggle plus a "more" menu whose
 * rename entry opens a dialog (never an inline input).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionItem } from '../SessionItem';
import { TooltipProvider } from '@/components/ui/tooltip';

// jsdom has no layout engine: drive the two metrics the overflow measurement
// compares so "title overflows" and "title fits" are both reachable.
const TITLE_CLIENT_WIDTH = 120;
let titleScrollWidth = 300;
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get() {
    return titleScrollWidth;
  },
});
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return TITLE_CLIENT_WIDTH;
  },
});

// The hover actions are absolutely positioned over the row's right edge;
// their width must be added to the marquee travel so the tail clears them.
const ACTIONS_WIDTH = 64;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() {
    return ACTIONS_WIDTH;
  },
});

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const UPDATED_AT = Date.UTC(2026, 9, 23, 7, 20);
const LONG_TITLE = '一个非常长的会话标题用来测试溢出滚动播放与完整提示';

const updatedLabel = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short',
  timeStyle: 'short',
}).format(UPDATED_AT);

function renderRow(
  overrides: {
    title?: string;
    isGenerating?: boolean;
    isPinned?: boolean;
    dragHandle?: React.ReactNode;
    onTogglePin?: () => void;
    onRename?: (title: string) => void;
    onClick?: () => void;
  } = {},
) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const view = render(
    <TooltipProvider delay={0}>
      <SessionItem
        session={{ id: 's1', title: overrides.title ?? LONG_TITLE, updatedAt: UPDATED_AT }}
        isActive={false}
        isGenerating={overrides.isGenerating ?? false}
        isPinned={overrides.isPinned ?? false}
        dragHandle={overrides.dragHandle}
        onTogglePin={overrides.onTogglePin ?? (() => {})}
        onRename={overrides.onRename ?? (() => {})}
        onClick={overrides.onClick ?? (() => {})}
        onDelete={() => {}}
      />
    </TooltipProvider>,
  );
  return { user, container: view.container };
}

/**
 * The title's viewport: it clips whatever scrolls past, so it must not
 * itself be the truncating (translatable) box — see 'clips at the viewport'.
 */
function viewport(): HTMLElement {
  const el = document.querySelector('span.flex-1');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

/**
 * The text run inside the viewport — the element the ellipsis and the
 * marquee live on. Falls back to the viewport itself for the un-nested
 * shape, so the assertions below pin the behaviour, not the nesting.
 */
function titleRun(): HTMLElement {
  return (viewport().querySelector('span') ?? viewport()) as HTMLElement;
}

/** Base UI mounts the tooltip popup without a role; locate it by data-slot. */
function tooltipContent(): HTMLElement | null {
  return document.querySelector('[data-slot="tooltip-content"]');
}

afterEach(() => {
  titleScrollWidth = 300;
});

describe('SessionItem overflowing title', () => {
  it('stays still until the row is hovered', () => {
    renderRow();
    expect(titleRun().className).not.toContain('session-title-marquee');
  });

  it('clips at the viewport, keeping the ellipsis on the text run', () => {
    renderRow();
    // The old single-box shape put truncate (overflow-hidden + ellipsis) on
    // the very element the marquee translates: the box slid out of the
    // sidebar and still showed an ellipsis. The viewport must clip without
    // truncating; the run truncates without ever moving while at rest.
    expect(viewport().className).not.toContain('truncate');
    expect(titleRun().className).toContain('truncate');
  });

  it('scrolls the full text through while hovered', async () => {
    const { user } = renderRow();
    await user.hover(screen.getByText(LONG_TITLE));
    const run = titleRun();

    expect(run.className).toContain('session-title-marquee');
    // While scrolling the run shows every character — no ellipsis, no
    // overflow-hidden clipping it to the viewport width.
    expect(run.className).not.toContain('truncate');
    expect(run.className).toContain('whitespace-nowrap');
    expect(run.style.getPropertyValue('--marquee-shift')).toMatch(/^\d+px$/);
    expect(run.style.getPropertyValue('--marquee-duration')).toMatch(
      /^\d+(\.\d+)?s$/,
    );
  });

  it('rolls past the action buttons covering the row right edge', async () => {
    const { user } = renderRow();
    await user.hover(screen.getByText(LONG_TITLE));

    // Travel = overflow (300-120) + the buttons hiding the tail (64) + the
    // 4px edge padding; without the buttons the tail stops behind them.
    expect(titleRun().style.getPropertyValue('--marquee-shift')).toBe(
      `${300 - TITLE_CLIENT_WIDTH + ACTIONS_WIDTH + 4}px`,
    );
  });

  it('plays the scroll once to the end instead of reversing forever', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'app/globals.css'), 'utf8');
    const rule = css.match(/\.session-title-marquee\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/linear 1 both/);
    expect(rule).not.toContain('alternate');
  });

  it('stops scrolling when the pointer leaves the row', async () => {
    const { user } = renderRow();
    await user.hover(screen.getByText(LONG_TITLE));
    expect(titleRun().className).toContain('session-title-marquee');

    await user.unhover(titleRun());
    expect(titleRun().className).not.toContain('session-title-marquee');
  });

  it('never scrolls a title that already fits', async () => {
    titleScrollWidth = TITLE_CLIENT_WIDTH;
    const { user } = renderRow({ title: 'short' });

    await user.hover(screen.getByText('short'));

    expect(titleRun().className).not.toContain('session-title-marquee');
  });

  it('shows a tooltip with the full title and the updated time', async () => {
    const { user } = renderRow();

    await user.hover(screen.getByText(LONG_TITLE));

    // The popup mounts asynchronously after the hover lands.
    await waitFor(() => expect(tooltipContent()).not.toBeNull());
    const tooltip = tooltipContent()!;
    expect(within(tooltip).getByText(LONG_TITLE)).toBeInTheDocument();
    expect(within(tooltip).getByText(`更新于 ${updatedLabel}`)).toBeInTheDocument();
  });

  it('drops the message glyph but keeps the leading slot in place', () => {
    const { container } = renderRow();

    expect(container.querySelector('.lucide-message-square-text')).toBeNull();
    // The slot survives: a fixed-size box ahead of the title so rows never
    // re-flow when the spinner appears or disappears.
    const slot = container.querySelector('span[class*="h-3.5"]');
    expect(slot).not.toBeNull();
    expect(slot!.querySelector('svg')).toBeNull();
  });

  it('spins a ring in the slot while the session is streaming', () => {
    const { container } = renderRow({ isGenerating: true });

    const ring = container.querySelector('.lucide-loader-circle');
    expect(ring).not.toBeNull();
    expect(ring!.closest('span[class*="h-3.5"]')).not.toBeNull();
    expect(
      container
        .querySelector('span[class*="h-3.5"]')!
        .className.includes('items-center'),
    ).toBe(true);
  });
});

describe('SessionItem drag handle slot', () => {
  it('shares the leading slot with the streaming ring instead of taking its own width', () => {
    const { container } = renderRow({
      isGenerating: true,
      dragHandle: <button type="button" aria-label="拖动排序" />,
    });
    const slot = container.querySelector('span[class*="h-3.5"]');
    expect(slot).not.toBeNull();
    // One slot, two occupants: the ring and the handle are siblings inside it.
    expect(within(slot as HTMLElement).getByRole('button', { name: '拖动排序' })).toBeInTheDocument();
    expect(slot!.querySelector('.lucide-loader-circle')).not.toBeNull();
  });

  it('keeps its own width when no handle is offered', () => {
    const { container } = renderRow({ isGenerating: true });
    const slot = container.querySelector('span[class*="h-3.5"]');
    expect(slot!.querySelector('.lucide-loader-circle')).not.toBeNull();
    expect(within(slot as HTMLElement).queryByRole('button')).toBeNull();
  });
});

describe('SessionItem actions', () => {
  it('shows a pin button and a more menu instead of inline rename', async () => {
    const onTogglePin = vi.fn();
    const onClick = vi.fn();
    const { user } = renderRow({ onTogglePin, onClick });

    await user.hover(screen.getByText(LONG_TITLE));
    expect(screen.getByRole('button', { name: '置顶会话' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重命名' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '置顶会话' }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('marks a pinned row with aria-pressed and offers unpin', async () => {
    const { user } = renderRow({ isPinned: true });

    await user.hover(screen.getByText(LONG_TITLE));
    expect(screen.getByRole('button', { name: '取消置顶' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('opens the rename dialog from the more menu with the current title prefilled', async () => {
    const { user } = renderRow();

    await user.hover(screen.getByText(LONG_TITLE));
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }));

    const input = await screen.findByRole('textbox');
    expect(input).toHaveValue(LONG_TITLE);
    // Base UI focuses the dialog's first field after the portal mounts.
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('keeps delete disabled while generating', async () => {
    const { user } = renderRow({ isGenerating: true });

    await user.hover(screen.getByText(LONG_TITLE));
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    expect(
      await screen.findByRole('menuitem', { name: '会话正在生成中，无法删除' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });
});