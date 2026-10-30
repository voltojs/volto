'use client';

import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export interface TraceRowProps {
  /** Tool glyph shown in the gutter while the row is collapsed. */
  icon: LucideIcon;
  /** Leading label: a tool name, "思考", "已执行 3 步"… */
  label: string;
  /** Secondary text: the command, the path, a reasoning preview. */
  detail?: string;
  /** Trailing metadata in mono, e.g. "53ms". */
  meta?: string;
  /** Trailing state glyph (check / alert / spinner). */
  status?: ReactNode;
  /** Tints the label and icon; the row's own state, not its body. */
  failed?: boolean;
  /** Row body. Its presence makes the row expandable. */
  children?: ReactNode;
  /** Controlled open state; omit together with `children` for static rows. */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  /** Makes the row an action (opens a sub-agent) instead of a disclosure. */
  onActivate?: () => void;
  /** Accessible name, when the visible label is not enough. */
  ariaLabel?: string;
  testId?: string;
}

/**
 * One line of the agent's execution trace.
 *
 * Every trace line — a tool call, a reasoning block, a folded run of steps, a
 * sub-agent delegation — is the same object: a gutter glyph, a label, a muted
 * detail, optional metadata, and an optional body. Keeping one row means the
 * call sites cannot drift in size, color, indent or hover behaviour; they only
 * choose which glyph and what text.
 *
 * The row is aligned to the prose column while its hover surface and open
 * panel reach into the gutter, so the text sits on the same left edge as the
 * answer above and below it.
 */
export function TraceRow({
  icon: Icon,
  label,
  detail,
  meta,
  status,
  failed = false,
  children,
  open,
  onOpenChange,
  onActivate,
  ariaLabel,
  testId,
}: TraceRowProps) {
  const expandable = children !== undefined && onOpenChange !== undefined;
  const expanded = expandable && open === true;

  const content = (
    <>
      <span className="absolute top-1/2 left-0 h-3 w-3 -translate-y-1/2">
        <Icon
          aria-hidden
          className={cn(
            'absolute inset-0 h-3 w-3 transition-opacity',
            failed ? 'text-destructive' : 'text-muted-foreground/60',
            expandable && (expanded ? 'opacity-0' : 'group-hover:opacity-0'),
          )}
        />
        {expandable && (
          <ChevronRight
            aria-hidden
            className={cn(
              'text-muted-foreground/50 absolute inset-0 h-3 w-3 transition-transform duration-150',
              expanded ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          />
        )}
      </span>
      <span
        className={cn(
          'shrink-0 font-mono',
          label.match(/^[a-z_]+$/) === null && 'font-sans',
          failed ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {label}
      </span>
      {detail !== undefined && detail !== '' && (
        <span className="text-muted-foreground/70 truncate">{detail}</span>
      )}
      {meta !== undefined && (
        <span className="text-muted-foreground/40 ml-auto shrink-0 font-mono text-[10px] tabular-nums">
          {meta}
        </span>
      )}
      {status !== undefined && (
        <span className={cn('shrink-0', meta === undefined && 'ml-auto')}>{status}</span>
      )}
    </>
  );

  const rowClass = cn(
    'group relative flex w-full items-center gap-1.5 rounded-md py-[2px] pr-1 pl-5',
    'text-left text-[13px] leading-[18px] transition-colors',
    'hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none',
  );

  if (!expandable) {
    return (
      <div
        data-testid={testId}
        className={cn('-ml-5 w-[calc(100%+1.25rem)] rounded-md', failed && 'text-destructive')}
      >
        {onActivate === undefined ? (
          <div className={cn(rowClass, 'select-none')}>{content}</div>
        ) : (
          <button type="button" onClick={onActivate} className={rowClass} aria-label={ariaLabel}>
            {content}
          </button>
        )}
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      data-testid={testId}
      className={cn(
        '-ml-5 w-[calc(100%+1.25rem)] rounded-md transition-colors',
        expanded && 'bg-muted/30',
      )}
    >
      <CollapsibleTrigger className={rowClass}>{content}</CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="space-y-1.5 pt-0.5 pr-2 pb-2 pl-5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
