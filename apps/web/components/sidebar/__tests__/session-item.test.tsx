/**
 * Sidebar session rows: an overflowing title scrolls its full text through
 * on hover (marquee), and a tooltip carries the full title plus the
 * session's updated time. The marquee must not move titles that fit.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
  overrides: { title?: string; isEditing?: boolean; isGenerating?: boolean } = {},
) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const view = render(
    <TooltipProvider delay={0}>
      <SessionItem
        session={{ id: 's1', title: overrides.title ?? LONG_TITLE, updatedAt: UPDATED_AT }}
        isActive={false}
        isEditing={overrides.isEditing ?? false}
        editingTitle=""
        isGenerating={overrides.isGenerating ?? false}
        onEditTitleChange={() => {}}
        onStartEdit={() => {}}
        onFinishEdit={() => {}}
        onClick={() => {}}
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

  it('keeps the tooltip out of the way while the title is being edited', async () => {
    const { user } = renderRow({ isEditing: true });

    await user.hover(screen.getByRole('textbox'));

    expect(tooltipContent()).toBeNull();
  });
});
