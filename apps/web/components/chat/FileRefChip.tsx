'use client';

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { FileRef } from '@volto/sdk/file-refs';
import { openFileRef } from '@/lib/open-file-ref';

/**
 * A project file reference rendered as a click target that opens the file
 * preview in the right pane. `nested` renders a span[role=button] for places
 * where a real <button> would nest inside another button (a TraceRow
 * disclosure trigger).
 */
export function FileRefChip({
  target,
  projectId,
  variant,
  nested = false,
  children,
}: {
  target: FileRef;
  /** Owning project; null = unknown and the chip is not rendered by callers. */
  projectId?: string | null;
  variant: 'code' | 'link';
  nested?: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations('chat');
  const label = t('fileLink.openInPane', { path: target.path });
  const className = cn(
    'cursor-pointer underline-offset-2 hover:underline',
    variant === 'code'
      ? 'text-primary bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]'
      : 'text-primary',
  );
  const open = (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    // The chip can sit inside a disclosure trigger; the row must not fold.
    e.stopPropagation();
    openFileRef(target, projectId);
  };
  if (nested) {
    return (
      <span
        role="button"
        tabIndex={0}
        title={label}
        aria-label={label}
        className={className}
        onClick={(e) => open(e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open(e);
          }
        }}
      >
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={className}
      onClick={(e) => open(e)}
    >
      {children}
    </button>
  );
}
