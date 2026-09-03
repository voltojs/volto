'use client';

import { FolderGit2 } from 'lucide-react';
import { SidebarToggle } from '@/components/sidebar/SidebarToggle';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';
import type { ConnectionState } from '@/lib/agent-config';

interface ChatHeaderProps {
  projectName?: string | null;
  connectionState?: ConnectionState;
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

export function ChatHeader({ projectName, connectionState }: ChatHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-3">
      <SidebarToggle />
      <Separator orientation="vertical" className="h-5" />

      <div className="flex min-w-0 items-center gap-1.5">
        {projectName ? (
          <>
            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-primary/80" />
            <span className="truncate font-mono text-[13px] text-foreground/90">
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
        <ThemeToggle />
      </div>
    </header>
  );
}
