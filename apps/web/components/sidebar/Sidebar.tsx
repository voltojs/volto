'use client';

import { useEffect, useState } from 'react';
import { Plus, Settings, FolderPlus } from 'lucide-react';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { useConfigStore } from '@/stores/config-store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ProjectList } from './ProjectList';
import { AddProjectDialog } from './AddProjectDialog';
import { ProvidersDialog } from '@/components/settings/ProvidersDialog';

export function Sidebar() {
  const sidebarOpen = useSessionStore((s) => s.sidebarOpen);
  const load = useConfigStore((s) => s.load);
  const error = useConfigStore((s) => s.error);

  const [addingProject, setAddingProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const startNewSession = () => {
    // Clearing the current session returns the panel to the welcome screen,
    // where the user picks the project the new session will be bound to.
    useSessionStore.getState().setCurrentSession(null);
    useChatStore.getState().clearMessages();
  };

  return (
    <div
      className={cn(
        'flex flex-col border-r bg-gray-50 transition-all duration-300',
        sidebarOpen ? 'w-64' : 'w-0 overflow-hidden',
      )}
    >
      <div className="p-3">
        <Button variant="outline" className="w-full justify-start gap-2" onClick={startNewSession}>
          <Plus className="h-4 w-4" />
          新会话
        </Button>
      </div>

      <div className="flex items-center justify-between border-b px-3 pb-2">
        <span className="text-sm font-semibold">工作区</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setAddingProject(true)}
          aria-label="添加项目"
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {error ? (
          <div className="px-2 py-4 text-xs text-amber-700">
            无法连接 agent 服务：{error}
          </div>
        ) : (
          <ProjectList />
        )}
      </div>

      <div className="border-t p-3">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2"
          onClick={() => setShowSettings(true)}
        >
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>

      <AddProjectDialog open={addingProject} onOpenChange={setAddingProject} />
      <ProvidersDialog open={showSettings} onOpenChange={setShowSettings} />
    </div>
  );
}
