import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Terminal } from 'lucide-react';
import { TraceRow } from '../TraceRow';

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

describe('TraceRow', () => {
  it('caps the open body so a huge output cannot stretch the feed', () => {
    const { container } = render(
      <TraceRow icon={Terminal} label="bash" detail="ls" open onOpenChange={() => {}} scrollable>
        <pre>{'line\n'.repeat(5000)}</pre>
      </TraceRow>,
    );
    const body = container.querySelector('[data-slot="collapsible-content"] > div');
    expect(body?.className).toContain('max-h-[300px]');
    expect(body?.className).toContain('overflow-y-auto');
  });

  it('does not scroll a container of rows by default', () => {
    const { container } = render(
      <TraceRow icon={Terminal} label="已执行 3 步" open onOpenChange={() => {}}>
        <span>row</span>
      </TraceRow>,
    );
    const body = container.querySelector('[data-slot="collapsible-content"] > div');
    expect(body?.className).not.toContain('overflow-y-auto');
  });

  it('is a disclosure when it has a body and an action when it has none', () => {
    const { container, rerender } = render(
      <TraceRow icon={Terminal} label="bash" open onOpenChange={() => {}}>
        <span>body</span>
      </TraceRow>,
    );
    expect(container.querySelector('[data-testid="trace-row"]')).toBeNull();
    expect(screen.getByRole('button')).toBeDefined();

    const onActivate = vi.fn();
    rerender(<TraceRow icon={Terminal} label="task" onActivate={onActivate} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onActivate).toHaveBeenCalledOnce();
  });
});
