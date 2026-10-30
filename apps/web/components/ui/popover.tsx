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
}

function PopoverContent({
  className,
  align = 'end',
  side = 'bottom',
  sideOffset = 6,
  children,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        // z-[60] > dialogs (z-50): a popover is a floating layer and must
        // paint above modal dialogs, or it reads as dead there. The token
        // lives on the absolutely positioned Positioner — the stacking
        // unit; a z-index on the static Popup inside never joins paint
        // order — plus the Popup as a belt-and-braces copy.
        className="z-[60]"
        {...props}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'bg-popover text-popover-foreground z-[60] min-w-32 rounded-lg border p-3 shadow-md',
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
