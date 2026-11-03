'use client';

import { useSessionStore } from '@/stores/session-store';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
import { PanelLeftClose, PanelLeft } from 'lucide-react';

export function SidebarToggle() {
  const t = useTranslations('sidebar');
  const { sidebarOpen, toggleSidebar } = useSessionStore();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidebar}
            aria-label={sidebarOpen ? t('toggle.collapse') : t('toggle.expand')}
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
        {sidebarOpen ? t('toggle.collapse') : t('toggle.expand')} <Kbd>⌘B</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
