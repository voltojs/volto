'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { SidebarToggle } from '@/components/sidebar/SidebarToggle';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface ChatHeaderProps {
  /** 会话标题 / 项目名 / 欢迎语——由 ChatPanel 按当前状态解析。 */
  title: string;
  /**
   * 右侧面板切换按钮。visible = 面板当前展示（点击收起）；否则点击展开
   * （无标签时按当前会话项目开文件树）。缺省则不渲染按钮。
   */
  paneToggle?: {
    visible: boolean;
    disabled: boolean;
    onToggle: () => void;
  };
}

export function ChatHeader({ title, paneToggle }: ChatHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-3">
      <SidebarToggle />
      <Separator orientation="vertical" className="h-5 self-center" />

      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-foreground/90 truncate font-mono text-[13px]">
          {title}
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
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
