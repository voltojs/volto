'use client';

import { useRef, useState } from 'react';
import { ChevronRight, FolderGit2, Plus, Trash2 } from 'lucide-react';
import { useConfigStore } from '@/stores/config-store';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { ensureSessionDetail } from '@/hooks/use-server-sessions';
import { deleteServerSession, renameServerSession } from '@/lib/sessions-api';
import { cancelPendingTitleWriteBack } from '@/lib/session-title';
import { runSessionDelete } from '@/lib/session-delete';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { SessionItem } from './SessionItem';

export function ProjectList() {
  const projects = useConfigStore((s) => s.projects);
  const removeProject = useConfigStore((s) => s.removeProject);
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  const [expandedId, setExpandedId] = useState<string | null>(
    projects[0]?.id ?? null,
  );
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Guards against a double-click firing two DELETE requests for the same
  // session: a ref (not state) so the check is up to date even if the second
  // click lands before a re-render from the first click's state update. The
  // guard's check-and-add is performed by `runSessionDelete`; this ref is
  // just the shared, mutable `Set` instance passed to it on every call.
  const deletingSessionIds = useRef<Set<string>>(new Set());

  const handleRemoveProject = async (
    projectId: string,
    name: string,
    sessionCount: number,
  ) => {
    // projectId is immutable and a fresh add gets a new UUID, so deleting a
    // project permanently orphans every session under it (still on the
    // server, but unreachable from the sidebar) — confirm first and say how
    // many sessions are affected.
    const confirmed = window.confirm(
      sessionCount > 0
        ? `确定删除项目「${name}」吗？其下的 ${sessionCount} 个会话也将从侧栏消失，且无法恢复。`
        : `确定删除项目「${name}」吗？此操作无法撤销。`,
    );
    if (!confirmed) return;

    setError(null);
    try {
      await removeProject(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除项目失败');
    }
  };

  const handleDeleteSession = (sessionId: string) => {
    // Ordering (server delete before local removal) and the in-flight guard
    // live in `runSessionDelete` so they're unit-testable without rendering
    // this component — see apps/web/lib/session-delete.ts. `setError` here
    // reuses this component's existing inline error affordance (also used
    // for a failed project removal above).
    void runSessionDelete({
      sessionId,
      deletingIds: deletingSessionIds.current,
      deleteServer: deleteServerSession,
      deleteLocal: (id) => useSessionStore.getState().deleteSession(id),
      setError,
    });
  };

  const openSession = (sessionId: string) => {
    // The chat panel's useConversation hook loads the session's history from
    // the session store and attaches the live channel for it.
    useSessionStore.getState().setCurrentSession(sessionId);
    // A failure is recorded on the session as a retryable `detailError`
    // (surfaced by ChatPanel); this `.catch()` only prevents an unhandled
    // rejection.
    void ensureSessionDetail(sessionId).catch(() => {});
  };

  const startSessionForProject = (projectId: string) => {
    useSessionStore.getState().setCurrentSession(null);
    useChatStore.getState().clear();
    useSessionStore.getState().setPendingProjectId(projectId);
  };

  if (projects.length === 0) {
    return (
      <div className="border-sidebar-border text-muted-foreground mx-1 mt-2 rounded-md border border-dashed px-3 py-6 text-center text-xs">
        暂无项目
        <br />
        点击右上角 <FolderGit2 className="inline h-3 w-3 align-[-1px]" />{' '}
        添加一个目录
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {error && <p className="text-destructive px-2 py-1 text-xs">{error}</p>}
      {projects.map((project) => {
        const expanded = expandedId === project.id;
        const projectSessions = sessions.filter(
          (s) => s.projectId === project.id,
        );

        return (
          <div key={project.id}>
            <div
              className={cn(
                'group text-sidebar-foreground hover:bg-sidebar-accent relative flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 transition-colors',
              )}
              onClick={() => setExpandedId(expanded ? null : project.id)}
            >
              <ChevronRight
                className={cn(
                  'text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform duration-150',
                  expanded && 'rotate-90',
                )}
              />
              <FolderGit2 className="text-primary/80 h-4 w-4 shrink-0" />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="flex-1 truncate font-mono text-[13px]">
                      {project.name}
                    </span>
                  }
                />
                <TooltipContent side="right">{project.path}</TooltipContent>
              </Tooltip>
              {projectSessions.length > 0 && (
                <span className="text-muted-foreground font-mono text-[10px]">
                  {projectSessions.length}
                </span>
              )}
              {/* Absolutely positioned so appearing on hover never pushes the
                  name/count above — a plain `hidden group-hover:flex` sibling
                  would grow the flex row and jitter the whole item. */}
              <div className="bg-sidebar-accent absolute right-1 hidden items-center gap-0.5 pl-1 group-hover:flex">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          startSessionForProject(project.id);
                        }}
                        aria-label="新建对话"
                      />
                    }
                  >
                    <Plus className="h-3 w-3" />
                  </TooltipTrigger>
                  <TooltipContent side="top">新建对话</TooltipContent>
                </Tooltip>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleRemoveProject(
                      project.id,
                      project.name,
                      projectSessions.length,
                    );
                  }}
                  aria-label="删除项目"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {expanded && (
              <div className="border-sidebar-border/70 ml-2.5 space-y-0.5 border-l py-0.5 pl-2.5">
                {projectSessions.length === 0 && (
                  <div className="text-muted-foreground px-2 py-1.5 text-xs italic">
                    暂无会话
                  </div>
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
                      const title = editingTitle.trim();
                      if (title) {
                        useSessionStore
                          .getState()
                          .updateSessionTitle(session.id, title);
                        // Cancel any in-flight derived title write-back for
                        // this session before sending the manual rename, so
                        // a slow derived PATCH can never land after (and
                        // silently overwrite) the title the user just set.
                        cancelPendingTitleWriteBack(session.id);
                        // Best-effort: a manual rename is not on the critical
                        // path either, so a failed PATCH here is swallowed —
                        // the in-memory title the user just set stands.
                        void renameServerSession(session.id, title).catch(
                          () => {},
                        );
                      }
                      setEditingSessionId(null);
                    }}
                    onClick={() => openSession(session.id)}
                    onDelete={(e) => {
                      e.stopPropagation();
                      void handleDeleteSession(session.id);
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
