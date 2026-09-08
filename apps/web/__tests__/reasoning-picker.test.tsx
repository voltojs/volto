import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReasoningPicker } from '@/components/chat/ReasoningPicker';

// jsdom does not implement the pointer-capture / scroll APIs Base UI's
// Select uses internally; stub them so the popup can open in tests.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

describe('ReasoningPicker', () => {
  it('renders nothing when the model declares no reasoning efforts', () => {
    const { container } = render(
      <ReasoningPicker efforts={[]} value={undefined} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the server-supplied effort names, not a hardcoded label', async () => {
    render(
      <ReasoningPicker
        efforts={[
          { id: 'low', name: '低强度思考' },
          { id: 'high', name: '深度思考' },
        ]}
        value="low"
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole('combobox')[0]!);
    expect(await screen.findByText('深度思考')).toBeInTheDocument();
    expect(screen.getAllByText('低强度思考').length).toBeGreaterThan(0);
  });

  it('invokes onChange with the raw effort id, not its display name', async () => {
    // jsdom has no real layout, so userEvent's default pointer-events hit
    // testing (which relies on `elementFromPoint`) can't be trusted here.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    render(
      <ReasoningPicker
        efforts={[
          { id: 'low', name: '低强度思考' },
          { id: 'high', name: '深度思考' },
        ]}
        value="low"
        onChange={onChange}
      />,
    );
    await user.click(screen.getAllByRole('combobox')[0]!);
    await user.click(await screen.findByText('深度思考'));
    expect(onChange).toHaveBeenCalledWith('high');
  });
});
