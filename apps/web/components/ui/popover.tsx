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
        {...props}
      >
        <PopoverPrimitive.Popup
          className={cn(
            'bg-popover text-popover-foreground z-50 min-w-32 rounded-lg border p-3 shadow-md',
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
