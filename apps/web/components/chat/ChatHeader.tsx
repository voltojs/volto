'use client';

import { SidebarToggle } from '@/components/sidebar/SidebarToggle';
import { useTranslations } from 'next-intl';
import { startNewSession } from '@/lib/new-session';
import { useSessionStore } from '@/stores/session-store';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Download,
  GitBranch,
  History,
  Minimize2,
  MoreHorizontal,
  PanelRightOpen,
  Plus,
} from 'lucide-react';

interface ChatHeaderProps {
  /** 会话标题 / 项目名 / 欢迎语——由 ChatPanel 按当前状态解析。 */
  title: string;
  /**
   * Right-pane expand button. Only rendered while the pane is NOT visible:
   * the collapse control lives at the pane's own far right (RightPane), so
   * the header only offers the way back in. Omitted → button not rendered.
   */
  paneToggle?: {
    visible: boolean;
    disabled: boolean;
    onToggle: () => void;
  };
  /**
   * Manual context-compaction entry for the open session. Omitted (no
   * session selected) → button not rendered. `disabled` is driven by the
   * session's generating/idle status; a busy 409 from the server is still
   * possible after the click and is surfaced as a toast by the caller.
   */
  compactAction?: {
    disabled: boolean;
    onCompact: () => void;
  };
  /** Fork the whole session into a new branch. Omitted with no session. */
  forkAction?: {
    disabled: boolean;
    onFork: () => void;
  };
  /** Branch from a chosen completed turn. Omitted with no session. */
  rewindAction?: {
    disabled: boolean;
    onRewind: () => void;
  };
  /** Download the persisted transcript as Markdown. */
  exportAction?: {
    onExport: () => void;
  };
}

export function ChatHeader({ title, paneToggle, compactAction, forkAction, rewindAction, exportAction }: ChatHeaderProps) {
  const t = useTranslations('chat');
  const sidebarOpen = useSessionStore((s) => s.sidebarOpen);
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-2.5 border-b px-3 py-1.5">
      {/* The collapse toggle lives in the sidebar nameplate; when the sidebar
          is collapsed its expand control and the new-conversation entry move
          here, next to the title. */}
      {!sidebarOpen && (
        <div className="flex shrink-0 items-center gap-1">
          <SidebarToggle />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('header.newSession')}
                  onClick={startNewSession}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded"
                />
              }
            >
              <Plus className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{t('header.newSession')}</TooltipContent>
          </Tooltip>
        </div>
      )}

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {/* One line, clipped: the hover tooltip carries the full title. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="text-foreground/90 min-w-0 truncate font-mono text-[13px]">
                {title}
              </span>
            }
          />
          <TooltipContent side="bottom">{title}</TooltipContent>
        </Tooltip>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 self-center">
        {(forkAction ?? rewindAction ?? exportAction ?? compactAction) !== undefined && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t('header.moreAria')}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded"
                />
              }
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {forkAction && (
                <DropdownMenuItem disabled={forkAction.disabled} onClick={forkAction.onFork}>
                  <GitBranch className="h-4 w-4" />
                  <span>{t('header.fork')}</span>
                </DropdownMenuItem>
              )}
              {rewindAction && (
                <DropdownMenuItem disabled={rewindAction.disabled} onClick={rewindAction.onRewind}>
                  <History className="h-4 w-4" />
                  <span>{t('header.rewind')}</span>
                </DropdownMenuItem>
              )}
              {exportAction && (
                <DropdownMenuItem onClick={exportAction.onExport}>
                  <Download className="h-4 w-4" />
                  <span>{t('header.exportTooltip')}</span>
                </DropdownMenuItem>
              )}
              {compactAction && (
                <DropdownMenuItem disabled={compactAction.disabled} onClick={compactAction.onCompact}>
                  <Minimize2 className="h-4 w-4" />
                  <span>{t('header.compact')}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {paneToggle && !paneToggle.visible && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('header.paneExpand')}
                  onClick={paneToggle.onToggle}
                  disabled={paneToggle.disabled}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded disabled:opacity-50"
                />
              }
            >
              <PanelRightOpen className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{t('header.paneExpand')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
