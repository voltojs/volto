'use client';

import { FolderGit2, FolderTree } from 'lucide-react';
import { SidebarToggle } from '@/components/sidebar/SidebarToggle';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';
import type { ConnectionState } from '@/lib/agent-config';

interface ChatHeaderProps {
  projectName?: string | null;
  connectionState?: ConnectionState;
  onOpenFiles?: () => void;
  filesEnabled?: boolean;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: '已连接 agent 服务',
  connecting: '正在连接 agent 服务…',
  disconnected: '未连接 agent 服务',
};

const CONNECTION_DOT: Record<ConnectionState, string> = {
  connected: 'bg-success',
  connecting: 'bg-primary animate-pulse',
  disconnected: 'bg-destructive',
};

export function ChatHeader({
  projectName,
  connectionState,
  onOpenFiles,
  filesEnabled,
}: ChatHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-3">
      <SidebarToggle />
      <Separator orientation="vertical" className="h-5 self-center" />

      <div className="flex min-w-0 items-center gap-1.5">
        {projectName ? (
          <>
            <FolderGit2 className="text-primary/80 h-3.5 w-3.5 shrink-0" />
            <span className="text-foreground/90 truncate font-mono text-[13px]">
              {projectName}
            </span>
          </>
        ) : (
          <span className="font-display text-[15px] font-medium tracking-tight">
            探索未至之境
          </span>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {connectionState && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="flex h-8 w-8 items-center justify-center">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      CONNECTION_DOT[connectionState],
                    )}
                  />
                </span>
              }
            />
            <TooltipContent>{CONNECTION_LABEL[connectionState]}</TooltipContent>
          </Tooltip>
        )}
        {(onOpenFiles !== undefined || filesEnabled !== undefined) && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="文件"
                  onClick={onOpenFiles}
                  disabled={filesEnabled !== true}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded disabled:opacity-50"
                >
                  <FolderTree className="h-4 w-4" />
                </button>
              }
            />
            <TooltipContent>
              {filesEnabled ? '浏览项目文件' : '当前会话未绑定项目'}
            </TooltipContent>
          </Tooltip>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
