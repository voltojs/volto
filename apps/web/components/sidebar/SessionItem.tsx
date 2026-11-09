'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { formatShortDateTime } from '@/lib/time-format';
import { useLocale } from 'next-intl';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { RenameSessionDialog } from './RenameSessionDialog';
import { cn } from '@/lib/utils';
import { LoaderCircle, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';

interface SessionItemProps {
  session: { id: string; title: string; updatedAt: number };
  isActive: boolean;
  /** True while this session sits in the pinned section. */
  isPinned: boolean;
  /** Workspace name; shown in the row's tooltip rather than inline. */
  projectName?: string;
  /** Rendered ahead of the leading slot — the drag handle when the section is manually ordered. */
  dragHandle?: React.ReactNode;
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
  /** Toggles this session's pinned membership. */
  onTogglePin: () => void;
  /** Applies the title the rename dialog produced (already trimmed). */
  onRename: (title: string) => void;
  onClick: () => void;
  onDelete: () => void;
}

/** Marquee travel speed — roughly reading pace, so long titles finish fast. */
const MARQUEE_PX_PER_SECOND = 40;
/** Extra travel past the last character, so the tail isn't clipped. */
const MARQUEE_EDGE_PADDING = 4;

export function SessionItem({
  session,
  isActive,
  isPinned,
  projectName,
  dragHandle,
  isGenerating,
  onTogglePin,
  onRename,
  onClick,
  onDelete,
}: SessionItemProps) {
  const t = useTranslations('sidebar');
  const locale = useLocale();
  const [showActions, setShowActions] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  /**
   * The row's action block unmounts when the pointer leaves it. A portaled
   * menu needs its trigger to stay mounted or the popup loses its anchor and
   * jumps to the origin, so the menu holds the block open until it closes —
   * same rule as the workspace rows.
   */
  const [menuOpen, setMenuOpen] = useState(false);
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
      // While hovered, the action buttons sit absolutely over the row's
      // right edge — travel must cover them too, or the title's tail
      // ends up scrolling underneath them. The buttons mount with
      // `showActions`, so re-measuring on that state is what picks them up.
      const coveredByActions = actionsRef.current?.offsetWidth ?? 0;
      setMarqueeShift(overflow + coveredByActions + MARQUEE_EDGE_PADDING);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [session.title, showActions, menuOpen]);

  const marqueeActive = showActions && marqueeShift > 0;
  const actionsVisible = showActions || menuOpen;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              className={cn(
                'group text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                isActive && 'bg-sidebar-accent text-sidebar-foreground font-medium',
                // The action cluster carries the row's own background so the
                // title can scroll underneath it. While a menu is open the
                // pointer leaves the row, the CSS hover is lost, and that
                // background turns into a floating block behind the icons —
                // so keep the row highlighted for as long as the menu lives.
                menuOpen && 'bg-sidebar-accent',
              )}
              onClick={onClick}
              onMouseEnter={() => setShowActions(true)}
              onMouseLeave={() => {
                if (!menuOpen) setShowActions(false);
              }}
            />
          }
        >
          {/* Leading slot: the message glyph is gone but the fixed-size box
              stays, so rows never re-flow when the spinner appears; a
              streaming session gets a spinning ring in it. When the section
              is manually ordered the drag handle shares this slot and takes
              it over on hover — same spot, so no width is reserved twice. */}
          <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            {isGenerating && (
              <LoaderCircle
                className={cn(
                  'text-muted-foreground h-3.5 w-3.5 animate-spin',
                  dragHandle !== undefined &&
                    'transition-opacity group-hover:opacity-0',
                )}
              />
            )}
            {dragHandle !== undefined && (
              <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                {dragHandle}
              </span>
            )}
          </span>
          {/* Two boxes on purpose: the viewport clips (so the run can never
              slide out of the row), while the run inside owns the ellipsis
              at rest and the translation while scrolling — translating a
              truncate box itself would both escape the row and keep the
              ellipsis visible the whole way. */}
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

          {/* Always mounted, revealed by CSS: mounting on hover unmounted the
              buttons the moment a pointer transition raced the click, which
              dropped clicks and tore dialogs down. */}
          <div
            ref={actionsRef}
            className={cn(
              'bg-sidebar-accent absolute right-1 flex items-center gap-0.5 pl-1',
              actionsVisible
                ? 'opacity-100'
                : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100',
            )}
          >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-pressed={isPinned}
                aria-label={isPinned ? t('pin.unpin') : t('pin.pin')}
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
              >
                {isPinned ? (
                  <PinOff className="h-3 w-3" />
                ) : (
                  <Pin className="h-3 w-3" />
                )}
              </Button>
              <DropdownMenu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onOpenChangeComplete={(open) => {
                  if (!open) setMenuOpen(false);
                }}
              >
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('session.more')}
                      className="aria-expanded:bg-transparent"
                      onClick={(e) => e.stopPropagation()}
                    />
                  }
                >
                  <MoreHorizontal className="h-3 w-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DropdownMenuItem
                    onClick={() => {
                      setRenameOpen(true);
                    }}
                  >
                    <Pencil />
                    {t('session.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={isGenerating}
                    aria-label={
                      isGenerating ? t('session.deleteBlocked') : undefined
                    }
                    onClick={() => {
                      setConfirmOpen(true);
                    }}
                  >
                    <Trash2 />
                    {t('session.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" align="start">
          <span className="flex flex-col gap-1">
            <span className="font-medium">
              {session.title || t('session.untitled')}
            </span>
            {projectName !== undefined && (
              <span className="text-muted-foreground font-mono text-[10px]">
                {projectName}
              </span>
            )}
            <span className="opacity-70">
              {t('session.updatedAt', { time: formatShortDateTime(session.updatedAt, locale) })}
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

      {/* Mounted per open so the draft always starts from the current title. */}
      {renameOpen && (
        <RenameSessionDialog
          open
          onOpenChange={setRenameOpen}
          initialTitle={session.title}
          onSubmit={onRename}
        />
      )}
    </>
  );
}
