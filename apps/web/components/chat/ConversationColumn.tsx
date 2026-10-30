'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The one owner of the conversation column's width.
 *
 * Messages, approvals, the todo dock, the composer and the status bar all sit
 * inside this column, so they share a single max width and a single pair of
 * gutters. Before this they each carried their own `max-w-3xl px-6`, which
 * meant the width could drift per surface and the gutters doubled up whenever
 * two of them nested.
 */
export function ConversationColumn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mx-auto flex min-h-0 w-full max-w-5xl min-w-0 flex-1 flex-col px-6',
        className,
      )}
    >
      {children}
    </div>
  );
}
