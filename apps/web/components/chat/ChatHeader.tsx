'use client';

import { SidebarToggle } from '@/components/sidebar/SidebarToggle';
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
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-3">
      <SidebarToggle />
      <Separator orientation="vertical" className="h-5 !self-center" />

      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-foreground/90 truncate font-mono text-[13px]">
          {title}
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {forkAction && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="分支会话"
                  onClick={forkAction.onFork}
                  disabled={forkAction.disabled}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded disabled:opacity-50"
                />
              }
            >
              <GitBranch className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>
              {forkAction.disabled ? '会话生成中，暂不可分支' : '从此会话创建分支'}
            </TooltipContent>
          </Tooltip>
        )}
        {rewindAction && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="从某一轮重新开始"
                  onClick={rewindAction.onRewind}
                  disabled={rewindAction.disabled}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded disabled:opacity-50"
                />
              }
            >
              <History className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>
              {rewindAction.disabled ? '会话生成中，暂不可回退' : '从某一轮重新开始（创建分支）'}
            </TooltipContent>
          </Tooltip>
        )}
        {exportAction && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="导出会话"
                  onClick={exportAction.onExport}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded"
                />
              }
            >
              <Download className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>导出为 Markdown</TooltipContent>
          </Tooltip>
        )}
        {compactAction && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="压缩上下文"
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
                ? '会话生成中，暂不可压缩'
                : '压缩上下文（摘要旧消息，释放 token）'}
            </TooltipContent>
          </Tooltip>
        )}
        {paneToggle && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={paneToggle.visible ? '收起面板' : '展开面板'}
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
              {paneToggle.visible ? '收起面板' : '展开面板'}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
