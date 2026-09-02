'use client';

import { useState } from 'react';
import { Folder, FolderOpen, Trash2 } from 'lucide-react';
import { useConfigStore } from '@/stores/config-store';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SessionItem } from './SessionItem';

export function ProjectList() {
  const projects = useConfigStore((s) => s.projects);
  const removeProject = useConfigStore((s) => s.removeProject);
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const openSession = (sessionId: string) => {
    useSessionStore.getState().setCurrentSession(sessionId);
    const session = sessions.find((s) => s.id === sessionId);
    useChatStore.setState({ messages: session?.messages ?? [] });
  };

  if (projects.length === 0) {
    return <div className="py-8 text-center text-sm text-gray-400">暂无项目</div>;
  }

  return (
    <div className="space-y-1">
      {projects.map((project) => {
        const expanded = expandedId === project.id;
        const projectSessions = sessions.filter((s) => s.projectId === project.id);

        return (
          <div key={project.id}>
            <div
              className={cn(
                'group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-200',
                expanded && 'bg-gray-200',
              )}
              onClick={() => setExpandedId(expanded ? null : project.id)}
            >
              {expanded ? (
                <FolderOpen className="h-4 w-4 shrink-0 text-gray-500" />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-gray-500" />
              )}
              <span className="flex-1 truncate text-sm" title={project.path}>
                {project.name}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="hidden h-6 w-6 text-red-500 group-hover:flex"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeProject(project.id);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>

            {expanded && (
              <div className="ml-4 mt-1 space-y-0.5">
                {projectSessions.length === 0 && (
                  <div className="px-2 py-1 text-xs text-gray-400">暂无会话</div>
                )}
                {projectSessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={currentSessionId === session.id}
                    isEditing={editingSessionId === session.id}
                    editingTitle={editingTitle}
                    onEditTitleChange={setEditingTitle}
                    onStartEdit={() => {
                      setEditingSessionId(session.id);
                      setEditingTitle(session.title);
                    }}
                    onFinishEdit={() => {
                      if (editingTitle.trim()) {
                        useSessionStore
                          .getState()
                          .updateSessionTitle(session.id, editingTitle.trim());
                      }
                      setEditingSessionId(null);
                    }}
                    onClick={() => openSession(session.id)}
                    onDelete={(e) => {
                      e.stopPropagation();
                      useSessionStore.getState().deleteSession(session.id);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
