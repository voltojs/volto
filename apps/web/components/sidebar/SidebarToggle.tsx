'use client';

import { useSessionStore } from '@/stores/session-store';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
import { PanelLeftClose, PanelLeft } from 'lucide-react';

export function SidebarToggle() {
  const { sidebarOpen, toggleSidebar } = useSessionStore();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidebar}
            aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          />
        }
      >
        {sidebarOpen ? (
          <PanelLeftClose className="h-4 w-4" />
        ) : (
          <PanelLeft className="h-4 w-4" />
        )}
      </TooltipTrigger>
      <TooltipContent>
        {sidebarOpen ? '收起侧栏' : '展开侧栏'} <Kbd>⌘B</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
