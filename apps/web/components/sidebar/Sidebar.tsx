'use client';

import { useEffect, useState } from 'react';
import { Plus, Settings, FolderPlus, Loader2 } from 'lucide-react';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { useConfigStore } from '@/stores/config-store';
import { useAddProject } from '@/hooks/use-add-project';
import { useRecoverServerSessions } from '@/hooks/use-recover-server-sessions';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ProjectList } from './ProjectList';
import { ProvidersDialog } from '@/components/settings/ProvidersDialog';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA'
  );
}

export function Sidebar() {
  const sidebarOpen = useSessionStore((s) => s.sidebarOpen);
  const load = useConfigStore((s) => s.load);
  const error = useConfigStore((s) => s.error);

  const [showSettings, setShowSettings] = useState(false);
  const { run: addProjectViaPicker, pending: addingProject } = useAddProject();

  useEffect(() => {
    void load();
  }, [load]);

  useRecoverServerSessions();

  // ⌘B / Ctrl+B toggles the sidebar — the tooltip on SidebarToggle advertises
  // this, so the shortcut has to actually exist.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey))
        return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      useSessionStore.getState().toggleSidebar();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const startNewSession = () => {
    // Clearing the current session returns the panel to the welcome screen,
    // where the user picks the project the new session will be bound to.
    useSessionStore.getState().setCurrentSession(null);
    useChatStore.getState().clearMessages();
  };

  return (
    <div
      className={cn(
        'border-sidebar-border bg-sidebar text-sidebar-foreground flex h-full flex-col overflow-hidden border-r transition-[width] duration-200 ease-out',
        sidebarOpen ? 'w-72' : 'w-0',
      )}
    >
      <div className="flex h-full w-72 shrink-0 flex-col">
        {/* Nameplate */}
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <svg
            viewBox="0 0 24 24"
            className="text-primary h-6 w-6 shrink-0"
            aria-hidden="true"
          >
            <path
              d="M4 5 L11 19 L13 19 L20 5 L17.2 5 L12 15.5 L6.8 5 Z"
              fill="currentColor"
            />
          </svg>
          <span className="font-display text-lg font-semibold tracking-tight">
            Volto
          </span>
          <span className="text-muted-foreground ml-auto font-mono text-[10px] tracking-widest uppercase">
            control
          </span>
        </div>

        <div className="px-3 pb-3">
          <Button
            variant="secondary"
            className="w-full justify-start gap-2 font-medium"
            onClick={startNewSession}
          >
            <Plus className="h-4 w-4" />
            新会话
          </Button>
        </div>

        <Separator />

        <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
          <span className="text-muted-foreground font-mono text-[10px] font-medium tracking-[0.14em] uppercase">
            工作区
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void addProjectViaPicker()}
                  disabled={addingProject}
                  aria-label="添加工作区"
                />
              }
            >
              {addingProject ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FolderPlus className="h-3.5 w-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {addingProject ? '正在等待系统对话框…' : '添加工作区'}
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pt-1 pb-2">
          {error ? (
            <div className="border-destructive/30 bg-destructive/10 text-destructive mx-1 mt-2 rounded-md border px-2.5 py-2 text-xs">
              无法连接 agent 服务：{error}
            </div>
          ) : (
            <ProjectList />
          )}
        </div>

        <Separator />

        <div className="flex items-center gap-1 p-2">
          <Button
            variant="ghost"
            className="text-muted-foreground flex-1 justify-start gap-2"
            onClick={() => setShowSettings(true)}
          >
            <Settings className="h-4 w-4" />
            设置
          </Button>
        </div>
      </div>

      <ProvidersDialog open={showSettings} onOpenChange={setShowSettings} />
    </div>
  );
}
