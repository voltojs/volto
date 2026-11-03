'use client';

import { SidebarToggle } from '@/components/sidebar/SidebarToggle';
import { useTranslations } from 'next-intl';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Download, GitBranch, History, Minimize2, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface ChatHeaderProps {
  /** 会话标题 / 项目名 / 欢迎语——由 ChatPanel 按当前状态解析。 */
  title: string;
  /**
   * Right-pane toggle button. visible = pane is shown (click collapses);
   * otherwise click expands (with no tabs it opens the project overview).
   * Omitted → button not rendered.
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
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-2.5 border-b px-3 py-1.5">
      <SidebarToggle />
      <Separator orientation="vertical" className="h-5 !self-center" />

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {/* The full title, wrapped rather than clipped: the header is the only
            place a long auto-generated title can be read. */}
        <span className="text-foreground/90 font-mono text-[13px] break-words">
          {title}
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 self-center">
        {forkAction && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('header.forkAria')}
                  onClick={forkAction.onFork}
                  disabled={forkAction.disabled}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded disabled:opacity-50"
                />
              }
            >
              <GitBranch className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>
              {forkAction.disabled ? t('header.forkDisabled') : t('header.fork')}
            </TooltipContent>
          </Tooltip>
        )}
        {rewindAction && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('header.rewindAria')}
                  onClick={rewindAction.onRewind}
                  disabled={rewindAction.disabled}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded disabled:opacity-50"
                />
              }
            >
              <History className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>
              {rewindAction.disabled ? t('header.rewindDisabled') : t('header.rewind')}
            </TooltipContent>
          </Tooltip>
        )}
        {exportAction && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('header.exportAria')}
                  onClick={exportAction.onExport}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded"
                />
              }
            >
              <Download className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{t('header.exportTooltip')}</TooltipContent>
          </Tooltip>
        )}
        {compactAction && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('header.compactAria')}
                  onClick={compactAction.onCompact}
                  disabled={compactAction.disabled}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded disabled:opacity-50"
                />
              }
            >
              <Minimize2 className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>
              {compactAction.disabled
                ? t('header.compactDisabled')
                : t('header.compact')}
            </TooltipContent>
          </Tooltip>
        )}
        {paneToggle && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={paneToggle.visible ? t('header.paneCollapse') : t('header.paneExpand')}
                  onClick={paneToggle.onToggle}
                  disabled={paneToggle.disabled}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded disabled:opacity-50"
                />
              }
            >
              {paneToggle.visible ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeftOpen className="h-4 w-4" />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {paneToggle.visible ? t('header.paneCollapse') : t('header.paneExpand')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
