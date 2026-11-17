'use client';

import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from '@/lib/utils';

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:data-checked:ring-primary/30 data-checked:bg-primary data-checked:text-primary-foreground relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border shadow-xs outline-none transition-all not-disabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-3',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'dark:data-checked:bg-primary-foreground pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform data-checked:translate-x-[calc(100%-2px)] data-unchecked:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
