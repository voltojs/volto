import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { SortableRow } from '../SortableRow';

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

function Harness({ enabled }: { enabled: boolean }) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext sensors={sensors}>
      <SortableContext items={['a']}>
        <SortableRow id="a" enabled={enabled}>
          {(handle) => (
            <div>
              {enabled && (
                <button
                  type="button"
                  ref={handle.setActivatorNodeRef}
                  {...handle.attributes}
                  {...handle.listeners}
                  aria-label="拖动排序"
                />
              )}
              <span>row-content</span>
            </div>
          )}
        </SortableRow>
      </SortableContext>
    </DndContext>
  );
}

describe('SortableRow', () => {
  it('exposes a keyboard-draggable handle only when enabled', () => {
    const { rerender } = render(<Harness enabled />);
    const handle = screen.getByRole('button', { name: '拖动排序' });
    expect(handle).toBeInTheDocument();
    // dnd-kit marks its activators so assistive tech announces drag semantics.
    expect(handle).toHaveAttribute('aria-roledescription');

    rerender(<Harness enabled={false} />);
    expect(screen.queryByRole('button', { name: '拖动排序' })).not.toBeInTheDocument();
    expect(screen.getByText('row-content')).toBeInTheDocument();
  });
});