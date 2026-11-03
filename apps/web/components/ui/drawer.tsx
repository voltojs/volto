'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { XIcon } from 'lucide-react';

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerContent({
  className,
  children,
  title,
  description,
  ...props
}: DrawerPrimitive.Popup.Props & {
  /** 无障碍必需的可视标题（DrawerTitle 渲染）。 */
  title: string;
  description?: string;
}) {
  const t = useTranslations('chat');
  return (
    <DrawerPrimitive.Portal data-slot="drawer-portal">
      <DrawerPrimitive.Backdrop
        data-slot="drawer-backdrop"
        className={cn(
          'data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs',
        )}
      />
      {/* Base UI 要求 Popup 必须渲染在 Viewport 内——Viewport 是滑动关闭的
          手势面与触摸滚动锁定的宿主，缺了它 Drawer.Popup 会告警并禁用两者。 */}
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className="fixed inset-0 z-50"
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            'bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right fixed inset-y-0 right-0 z-50 flex h-full w-[min(42rem,90vw)] flex-col gap-0 border-l p-0 text-sm ring-1 duration-200 outline-none',
            className,
          )}
          {...props}
        >
          <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
            <div className="min-w-0">
              <DrawerPrimitive.Title
                data-slot="drawer-title"
                className="text-foreground truncate text-sm font-semibold"
              >
                {title}
              </DrawerPrimitive.Title>
              {description && (
                <DrawerPrimitive.Description
                  data-slot="drawer-description"
                  className="text-muted-foreground mt-0.5 truncate text-xs"
                >
                  {description}
                </DrawerPrimitive.Description>
              )}
            </div>
            <DrawerPrimitive.Close
              data-slot="drawer-close"
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <XIcon />
              <span className="sr-only">{t('close')}</span>
            </DrawerPrimitive.Close>
          </div>
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

export { Drawer, DrawerContent };
