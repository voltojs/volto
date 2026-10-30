'use client';

import * as React from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverTitle = PopoverPrimitive.Title;

interface PopoverContentProps extends PopoverPrimitive.Positioner.Props {
  className?: string;
  children?: React.ReactNode;
  /**
   * Stacking layer for the popup, applied to the absolutely positioned
   * Positioner — the stacking unit; a z-index on the static Popup inside
   * never joins paint order (the bug's real shape) — plus the Popup as a
   * belt-and-braces copy. Hosts inside a modal dialog (z-50) pass a
   * higher token so the popup paints above it; the default keeps the
   * stock dialog-level layer. Pass a full literal class name so
   * Tailwind's scanner generates it.
   */
  zIndexClassName?: string;
}

function PopoverContent({
  className,
  align = 'end',
  side = 'bottom',
  sideOffset = 6,
  zIndexClassName = 'z-50',
  children,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={zIndexClassName}
        {...props}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'bg-popover text-popover-foreground min-w-32 rounded-lg border p-3 shadow-md',
            zIndexClassName,
            className,
          )}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverTitle };
