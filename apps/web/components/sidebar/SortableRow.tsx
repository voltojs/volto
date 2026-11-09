'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';

/** The bits a caller must spread onto its own drag handle button. */
export interface SortableHandle {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
}

interface SortableRowProps {
  /** Must match the id passed to the neighbouring `SortableContext`. */
  id: string;
  /**
   * False while the section is sorted by a computed order. The row stays
   * rendered — callers simply stop rendering the handle — so nothing about
   * the list jumps when the mode flips.
   */
  enabled: boolean;
  children: (handle: SortableHandle) => ReactNode;
  className?: string;
}

/**
 * One drag-and-drop row. Deliberately owns only positioning and the handle
 * plumbing: the row's own markup, and where the handle sits in it, belongs to
 * the caller.
 */
export function SortableRow({ id, enabled, children, className }: SortableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !enabled });

  const style: CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && 'relative z-10 opacity-90', className)}
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </div>
  );
}