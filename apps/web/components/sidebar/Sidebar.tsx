'use client';

import { useState } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  Plus,
  Search,
  Settings,
  Folder,
  FolderOpen,
  MessageSquare,
  Trash2,
  MoreHorizontal,
} from 'lucide-react';

export function Sidebar() {
  const {
    sidebarOpen,
    workspaces,
    sessions,
    currentWorkspaceId,
    currentSessionId,
    setCurrentWorkspace,
    setCurrentSession,
    createSession,
    deleteSession,
    updateSessionTitle,
  } = useSessionStore();

  const { clearMessages } = useChatStore();

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const handleNewSession = () => {
    createSession(undefined, currentWorkspaceId || undefined);
    clearMessages();
  };

  const handleSessionClick = (sessionId: string) => {
    setCurrentSession(sessionId);
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      useChatStore.setState({ messages: session.messages });
    }
  };

  const handleStartEdit = (sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId);
    setEditingTitle(currentTitle);
  };

  const handleFinishEdit = (sessionId: string) => {
    if (editingTitle.trim()) {
      updateSessionTitle(sessionId, editingTitle.trim());
    }
    setEditingSessionId(null);
  };

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    deleteSession(sessionId);
  };

  const getWorkspaceSessions = (workspaceId?: string) => {
    if (workspaceId) {
      return sessions.filter((s) => s.workspaceId === workspaceId);
    }
    return sessions.filter((s) => !s.workspaceId);
  };

  return (
    <div
      className={cn(
        'flex flex-col border-r bg-gray-50 transition-all duration-300',
        sidebarOpen ? 'w-64' : 'w-0 overflow-hidden',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">工作区</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* New Session Button */}
      <div className="p-3">
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={handleNewSession}
        >
          <Plus className="h-4 w-4" />
          新会话
        </Button>
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto px-3">
        {/* Workspace folders */}
        {workspaces.map((workspace) => (
          <div key={workspace.id} className="mb-2">
            <div
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-gray-200',
                currentWorkspaceId === workspace.id && 'bg-gray-200',
              )}
              onClick={() => setCurrentWorkspace(workspace.id)}
            >
              {currentWorkspaceId === workspace.id ? (
                <FolderOpen className="h-4 w-4 text-gray-500" />
              ) : (
                <Folder className="h-4 w-4 text-gray-500" />
              )}
              <span className="text-sm truncate">{workspace.name}</span>
            </div>

            {/* Sessions under workspace */}
            {currentWorkspaceId === workspace.id && (
              <div className="ml-4 mt-1">
                {getWorkspaceSessions(workspace.id).map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={currentSessionId === session.id}
                    isEditing={editingSessionId === session.id}
                    editingTitle={editingTitle}
                    onEditTitleChange={setEditingTitle}
                    onStartEdit={() =>
                      handleStartEdit(session.id, session.title)
                    }
                    onFinishEdit={() => handleFinishEdit(session.id)}
                    onClick={() => handleSessionClick(session.id)}
                    onDelete={(e) => handleDeleteSession(e, session.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Root sessions (no workspace) */}
        {getWorkspaceSessions().length > 0 && (
          <div className="mb-2">
            {getWorkspaceSessions().map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={currentSessionId === session.id}
                isEditing={editingSessionId === session.id}
                editingTitle={editingTitle}
                onEditTitleChange={setEditingTitle}
                onStartEdit={() => handleStartEdit(session.id, session.title)}
                onFinishEdit={() => handleFinishEdit(session.id)}
                onClick={() => handleSessionClick(session.id)}
                onDelete={(e) => handleDeleteSession(e, session.id)}
              />
            ))}
          </div>
        )}

        {sessions.length === 0 && (
          <div className="text-center text-gray-400 text-sm py-8">
            暂无会话
          </div>
        )}
      </div>

      {/* Settings Footer */}
      <div className="p-3 border-t">
        <Button variant="ghost" className="w-full justify-start gap-2">
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session Item Component
// ---------------------------------------------------------------------------

interface SessionItemProps {
  session: { id: string; title: string; updatedAt: number };
  isActive: boolean;
  isEditing: boolean;
  editingTitle: string;
  onEditTitleChange: (title: string) => void;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}

function SessionItem({
  session,
  isActive,
  isEditing,
  editingTitle,
  onEditTitleChange,
  onStartEdit,
  onFinishEdit,
  onClick,
  onDelete,
}: SessionItemProps) {
  const [showActions, setShowActions] = useState(false);

  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-gray-200 relative',
        isActive && 'bg-gray-200',
      )}
      onClick={onClick}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <MessageSquare className="h-4 w-4 text-gray-400 shrink-0" />
      {isEditing ? (
        <Input
          value={editingTitle}
          onChange={(e) => onEditTitleChange(e.target.value)}
          onBlur={onFinishEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onFinishEdit();
            if (e.key === 'Escape') onFinishEdit();
          }}
          className="h-6 text-sm"
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="text-sm truncate flex-1">{session.title}</span>
      )}

      {showActions && !isEditing && (
        <div className="absolute right-1 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
          >
            <MoreHorizontal className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-red-500 hover:text-red-600"
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
