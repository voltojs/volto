'use client';

import { useSessionStore } from '@/stores/session-store';
import { Button } from '@/components/ui/button';
import { PanelLeftClose, PanelLeft } from 'lucide-react';

export function SidebarToggle() {
  const { sidebarOpen, toggleSidebar } = useSessionStore();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleSidebar}
      className="h-8 w-8"
    >
      {sidebarOpen ? (
        <PanelLeftClose className="h-4 w-4" />
      ) : (
        <PanelLeft className="h-4 w-4" />
      )}
    </Button>
  );
}
