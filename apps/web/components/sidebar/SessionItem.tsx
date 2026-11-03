'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { cn } from '@/lib/utils';
import { LoaderCircle, Trash2, Pencil } from 'lucide-react';

interface SessionItemProps {
  session: { id: string; title: string; updatedAt: number };
  isActive: boolean;
  isEditing: boolean;
  editingTitle: string;
  /**
   * True while this session's channel is actively streaming a turn. Deleting
   * such a session races the server's transcript writes: a delete landing
   * between an in-flight `appendFile` and its completion can resurrect a
   * truncated transcript (the store's `deleteSession` isn't serialised with
   * `appendEventBatch` — see `packages/stores/jsonl/src/index.ts`). The full
   * fix needs a store-side tombstone; this only closes the one-click path an
   * ordinary user can trigger by disabling delete while generating.
   */
  isGenerating: boolean;
  onEditTitleChange: (title: string) => void;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onClick: () => void;
  onDelete: () => void;
}

const updatedFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short',
  timeStyle: 'short',
});

/** Marquee travel speed — roughly reading pace, so long titles finish fast. */
const MARQUEE_PX_PER_SECOND = 40;
/** Extra travel past the last character, so the tail isn't clipped. */
const MARQUEE_EDGE_PADDING = 4;

export function SessionItem({
  session,
  isActive,
  isEditing,
  editingTitle,
  isGenerating,
  onEditTitleChange,
  onStartEdit,
  onFinishEdit,
  onClick,
  onDelete,
}: SessionItemProps) {
  const t = useTranslations('sidebar');
  const [showActions, setShowActions] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  /**
   * Pixels the marquee must travel to reveal the title's tail; 0 = the title
   * fits (or nothing is mounted) and scrolling would only move text out of
   * view. Measured on the client — jsdom/SSR have no layout — after every
   * title change and on window resize (the sidebar width changes).
   */
  const [marqueeShift, setMarqueeShift] = useState(0);
  const actionsRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = titleRef.current;
      if (el === null) {
        setMarqueeShift(0);
        return;
      }
      const overflow = el.scrollWidth - el.clientWidth;
      if (overflow <= 0) {
        setMarqueeShift(0);
        return;
      }
      // While hovered, the rename/delete buttons sit absolutely over the
      // row's right edge — travel must cover them too, or the title's tail
      // ends up scrolling underneath them. The buttons mount with
      // `showActions`, so re-measuring on that state is what picks them up.
      const coveredByActions = actionsRef.current?.offsetWidth ?? 0;
      setMarqueeShift(overflow + coveredByActions + MARQUEE_EDGE_PADDING);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [session.title, isEditing, showActions]);

  const marqueeActive = showActions && !isEditing && marqueeShift > 0;

  return (
    <>
      <Tooltip disabled={isEditing}>
        <TooltipTrigger
          render={
            <div
              className={cn(
                'group text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                isActive && 'bg-sidebar-accent text-sidebar-foreground font-medium',
              )}
              onClick={onClick}
              onMouseEnter={() => setShowActions(true)}
              onMouseLeave={() => setShowActions(false)}
            />
          }
        >
          {/* Leading slot: the message glyph is gone but the fixed-size box
              stays, so rows never re-flow when the spinner appears; a
              streaming session gets a spinning ring in it. */}
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            {isGenerating && (
              <LoaderCircle className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
            )}
          </span>
          {isEditing ? (
            <Input
              value={editingTitle}
              onChange={(e) => onEditTitleChange(e.target.value)}
              onBlur={onFinishEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onFinishEdit();
                if (e.key === 'Escape') onFinishEdit();
              }}
              className="h-6 text-xs"
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            // Two boxes on purpose: the viewport clips (so the run can never
            // slide out of the row), while the run inside owns the ellipsis
            // at rest and the translation while scrolling — translating a
            // truncate box itself would both escape the row and keep the
            // ellipsis visible the whole way.
            <span className="min-w-0 flex-1 overflow-hidden">
              <span
                ref={titleRef}
                className={cn(
                  'block text-[13px]',
                  marqueeActive
                    ? 'session-title-marquee whitespace-nowrap'
                    : 'truncate',
                )}
                style={
                  marqueeActive
                    ? ({
                        '--marquee-shift': `${marqueeShift}px`,
                        '--marquee-duration': `${(
                          marqueeShift / MARQUEE_PX_PER_SECOND
                        ).toFixed(1)}s`,
                      } as React.CSSProperties)
                    : undefined
                }
              >
                {session.title || t('session.untitled')}
              </span>
            </span>
          )}

          {showActions && !isEditing && (
            <div
              ref={actionsRef}
              className="bg-sidebar-accent absolute right-1 flex items-center gap-0.5 pl-1"
            >
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onStartEdit();
                }}
                aria-label={t('session.rename')}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-destructive hover:text-destructive hover:bg-destructive/10 disabled:pointer-events-auto disabled:opacity-40"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmOpen(true);
                }}
                disabled={isGenerating}
                aria-label={isGenerating ? t('session.deleteBlocked') : t('session.delete')}
                title={isGenerating ? t('session.deleteBlocked') : undefined}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          )}
        </TooltipTrigger>
        <TooltipContent side="right" align="start">
          <span className="flex flex-col gap-1">
            <span className="font-medium">
              {session.title || t('session.untitled')}
            </span>
            <span className="opacity-70">
              {t('session.updatedAt', { time: updatedFormatter.format(session.updatedAt) })}
            </span>
          </span>
        </TooltipContent>
      </Tooltip>

      {/* Outside the hover-gated block above: opening the dialog moves the
          pointer off the row, which unmounts those buttons — a dialog nested
          in there would be torn down the moment it appeared. */}
      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('session.delete')}
        description={t('session.deleteConfirm', { title: session.title || t('session.untitled') })}
        onConfirm={onDelete}
      />
    </>
  );
}
