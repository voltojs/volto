'use client';

import * as React from 'react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { cn } from '@/lib/utils';

const DropdownMenu = MenuPrimitive.Root;

function DropdownMenuTrigger({
  ...props
}: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
  );
}

function DropdownMenuContent({
  className,
  align = 'end',
  side = 'bottom',
  sideOffset = 4,
  children,
  onClick,
  ...props
}: MenuPrimitive.Positioner.Props & {
  /**
   * Portaled content still bubbles through the React tree. Callers that
   * render a menu inside a clickable row pass `stopPropagation` here so
   * choosing an item does not also activate the row.
   */
  onClick?: React.MouseEventHandler;
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="z-50"
        {...props}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          onClick={onClick}
          className={cn(
            'bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 origin-(--transform-origin) min-w-36 rounded-lg p-1 shadow-md ring-1 outline-none',
            className,
          )}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: MenuPrimitive.Item.Props & {
  /** `destructive` tints the row and its icon for irreversible actions. */
  variant?: 'default' | 'destructive';
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dropdown-menu-separator"
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
};
