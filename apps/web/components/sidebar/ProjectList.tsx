'use client';

import { useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
  GripVertical,
  ChevronRight,
  Copy,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useConfigStore } from '@/stores/config-store';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { useSidebarStateStore } from '@/stores/sidebar-state-store';
import { useAddProject } from '@/hooks/use-add-project';
import { ensureSessionDetail } from '@/hooks/use-server-sessions';
import { createClickSuppressor } from '@/lib/click-suppressor';
import { deleteServerSession, renameServerSession } from '@/lib/sessions-api';
import { revealPath } from '@/lib/config-api';
import { runManualRename } from '@/lib/session-title';
import { runSessionDelete } from '@/lib/session-delete';
import {
  applyDragEnd,
  pinSession,
  sortProjects,
  toggleProjectExpanded,
} from '@/lib/sidebar-layout';
import type { ProjectSortMode } from '@/lib/sidebar-state-api';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';
import { SectionHeader } from './SectionHeader';
import { SessionItem } from './SessionItem';
import { SortableRow } from './SortableRow';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';

/**
 * The workspaces section: title row (collapse + sort + add) and one row per
 * workspace. Several workspaces can be expanded at once, and which ones is
 * part of the persisted layout document rather than local state.
 *
 * Sessions pinned into the section above are filtered out here — one row, one
 * home — while the row's session count keeps counting every session in the
 * directory.
 */
export function ProjectList() {
  const t = useTranslations('sidebar');
  const tc = useTranslations('chat');
  const locale = useLocale();
  const projects = useConfigStore((s) => s.projects);
  const removeProject = useConfigStore((s) => s.removeProject);
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  // The chat store's buffer belongs to exactly one session at a time — the
  // one whose channel is currently attached — so "is this sidebar row
  // generating" is just "is it the buffer's session, and is it generating".
  const generatingSessionId = useChatStore((s) =>
    s.isGenerating ? s.currentSessionId : null,
  );
  const doc = useSidebarStateStore((s) => s.state);
  const update = useSidebarStateStore((s) => s.update);
  const { run: addProjectViaPicker, pending: addingProject } = useAddProject();

  const [error, setError] = useState<string | null>(null);
  // The project whose deletion is awaiting confirmation. One piece of state
  // for the whole list rather than one dialog per row: only one confirmation
  // can be open at a time anyway.
  const [projectPendingDelete, setProjectPendingDelete] = useState<{
    id: string;
    name: string;
    sessionCount: number;
  } | null>(null);
  // The row whose action menu is open. Controlled so the hover buttons stay
  // mounted while the menu is open — unmounting the trigger detaches the
  // positioner's anchor and the popup jumps to the origin.
  const [menuOpenProjectId, setMenuOpenProjectId] = useState<string | null>(
    null,
  );
  // Guards against a double-click firing two DELETE requests for the same
  // session: a ref (not state) so the check is up to date even if the second
  // click lands before a re-render from the first click's state update. The
  // guard's check-and-add is performed by `runSessionDelete`; this ref is
  // just the shared, mutable `Set` instance passed to it on every call.
  const deletingSessionIds = useRef<Set<string>>(new Set());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // A drag ends with a pointerup, after which the row's own click would fire
  // and toggle the workspace open/closed. Swallow exactly that click.
  const clickSuppressor = useRef(createClickSuppressor()).current;

  const ordered = sortProjects(projects, doc.sortModes.projects, {
    order: doc.projectOrder,
    sessions,
    locale,
  });
  // Absent expand set = "never set": open the first workspace, matching what
  // the sidebar did before the set existed. An explicit `[]` is the user
  // having collapsed everything and must survive a reload.
  const firstProjectId = ordered[0]?.id ?? null;
  const expandedIds =
    doc.expandedProjectIds ??
    (firstProjectId === null ? [] : [firstProjectId]);
  const expandedSet = new Set(expandedIds);
  const pinnedSet = new Set(doc.pinnedSessionIds);
  const manual = doc.sortModes.projects === 'manual';
  const renderedProjectIds = ordered.map((project) => project.id);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = renderedProjectIds.indexOf(String(active.id));
    const to = renderedProjectIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    clickSuppressor.suppress();
    update((state) =>
      applyDragEnd(state, 'projects', renderedProjectIds, from, to),
    );
  };

  const handleRemoveProject = async (projectId: string) => {
    setError(null);
    try {
      await removeProject(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project.deleteFailed'));
    }
  };

  const handleDeleteSession = (sessionId: string) => {
    // Ordering (server delete before local removal), the in-flight guard,
    // and cancelling a pending derived-title write-back before the server
    // delete goes out all live in `runSessionDelete` so they're
    // unit-testable without rendering this component — see
    // apps/web/lib/session-delete.ts.
    void runSessionDelete(
      {
        sessionId,
        deletingIds: deletingSessionIds.current,
        deleteServer: deleteServerSession,
        deleteLocal: (id) => useSessionStore.getState().deleteSession(id),
        setError,
      },
      tc,
    );
  };

  const openSession = (sessionId: string) => {
    // The chat panel's useConversation hook loads the session's history from
    // the session store and attaches the live channel for it.
    useSessionStore.getState().setCurrentSession(sessionId);
    // A failure is recorded on the session as a retryable `detailError`
    // (surfaced by ChatPanel); this `.catch()` only prevents an unhandled
    // rejection.
    void ensureSessionDetail(sessionId, tc).catch(() => {});
  };

  const startSessionForProject = (projectId: string) => {
    useSessionStore.getState().setCurrentSession(null);
    useChatStore.getState().clear();
    useSessionStore.getState().setPendingProjectId(projectId);
  };

  const header = (
    <SectionHeader
      title={t('workspaces')}
      collapsed={doc.projectsCollapsed}
      onToggleCollapsed={() =>
        update((state) => ({
          ...state,
          projectsCollapsed: !state.projectsCollapsed,
        }))
      }
      sort={{
        value: doc.sortModes.projects,
        options: [
          { value: 'manual', label: t('sort.manual') },
          { value: 'name', label: t('sort.name') },
          { value: 'recent', label: t('sort.recent') },
        ],
        onChange: (value) =>
          update((state) => ({
            ...state,
            sortModes: {
              ...state.sortModes,
              projects: value as ProjectSortMode,
            },
          })),
      }}
      action={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void addProjectViaPicker()}
                disabled={addingProject}
                aria-label={t('addWorkspace')}
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
            {addingProject ? t('waitingDialog') : t('addWorkspace')}
          </TooltipContent>
        </Tooltip>
      }
    />
  );

  if (projects.length === 0) {
    return (
      <>
        {header}
        <div className="border-sidebar-border text-muted-foreground mx-1 mt-2 rounded-md border border-dashed px-3 py-6 text-center text-xs">
          {t('project.empty')}
          <br />
          {t('project.emptyHintPrefix')} <FolderGit2 className="inline h-3 w-3 align-[-1px]" />{' '}
          {t('project.emptyHintAction')}
        </div>
      </>
    );
  }

  return (
    <div>
      {header}
      {error && <p className="text-destructive px-2 py-1 text-xs">{error}</p>}
      {/* Hidden rather than unmounted while the section is collapsed, so the
          rows keep their dialogs and scroll position. */}
      <div
        data-testid="workspace-rows"
        className={cn('space-y-0.5', doc.projectsCollapsed && 'hidden')}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={renderedProjectIds}
            strategy={verticalListSortingStrategy}
          >
        {ordered.map((project) => {
          const expanded = expandedSet.has(project.id);
          const projectSessions = sessions.filter(
            (s) => s.projectId === project.id,
          );
          const visibleSessions = projectSessions.filter(
            (s) => !pinnedSet.has(s.id),
          );

          return (
            <div key={project.id}>
              <SortableRow id={project.id} enabled={manual}>
                {(handle) => (
              <div
                data-testid={`project-row-${project.id}`}
                className={cn(
                  // pl-4 lines the row's chevron up with the section header's;
                  // without the old in-flow drag handle the row sat ~10px
                  // further left than everything above it.
                  'group text-sidebar-foreground relative flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-1.5 pl-4 transition-colors',
                  {
                    'bg-sidebar-accent': menuOpenProjectId === project.id,
                    'hover:bg-sidebar-accent': menuOpenProjectId !== project.id,
                  },
                )}
                onClick={() => {
                  if (clickSuppressor.consume()) return;
                  update((state) =>
                    toggleProjectExpanded(state, project.id, expandedIds),
                  );
                }}
              >
                {/* Chevron and drag handle share this slot: the handle only
                    appears on hover, when it takes the chevron's place. A
                    second slot would shift the name right by its width. */}
                <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  <ChevronRight
                    className={cn(
                      'text-muted-foreground h-3.5 w-3.5 transition-transform duration-150',
                      { 'rotate-90': expanded },
                      manual && 'transition-opacity group-hover:opacity-0',
                    )}
                  />
                  {manual && (
                    <button
                      type="button"
                      ref={handle.setActivatorNodeRef}
                      {...handle.attributes}
                      {...handle.listeners}
                      aria-label={t('drag.handle')}
                      className="text-muted-foreground hover:text-foreground absolute inset-0 flex cursor-grab items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <GripVertical className="h-3 w-3" />
                    </button>
                  )}
                </span>
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
                  <span
                    className={cn(
                      'text-muted-foreground/70 font-mono text-[10px]',
                      {
                        'opacity-0': menuOpenProjectId === project.id,
                        // Yield the right edge to the hover action buttons.
                        'group-hover:opacity-0': menuOpenProjectId !== project.id,
                      },
                    )}
                  >
                    {projectSessions.length}
                  </span>
                )}
                <div
                  className={cn(
                    'absolute right-1 flex items-center gap-0.5 pl-1',
                    {
                      'opacity-100': menuOpenProjectId === project.id,
                      'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100':
                        menuOpenProjectId !== project.id,
                    },
                  )}
                >
                  <DropdownMenu
                    onOpenChange={(open) => {
                      if (open) {
                        setMenuOpenProjectId(project.id);
                      }
                    }}
                    onOpenChangeComplete={(open) => {
                      if (!open) {
                        setMenuOpenProjectId((id) =>
                          id === project.id ? null : id,
                        );
                      }
                    }}
                  >
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('project.menuAria')}
                          className="aria-expanded:bg-transparent"
                          onClick={(e) => e.stopPropagation()}
                        />
                      }
                    >
                      <MoreHorizontal className="h-3 w-3" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DropdownMenuItem
                        onClick={async () => {
                          try {
                            await revealPath(project.path);
                          } catch (err) {
                            toast.error(
                              err instanceof Error
                                ? err.message
                                : t('project.revealUnsupported'),
                            );
                          }
                        }}
                      >
                        <FolderOpen />{t('project.reveal')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(project.path);
                            toast.success(t('project.copied'));
                          } catch {
                            toast.error(t('project.copyFailed'));
                          }
                        }}
                      >
                        <Copy />
                        {t('project.copyPath')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          setProjectPendingDelete({
                            id: project.id,
                            name: project.name,
                            sessionCount: projectSessions.length,
                          });
                        }}
                      >
                        <Trash2 />
                        {t('project.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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
                          aria-label={t('project.newConversation')}
                        />
                      }
                    >
                      <Plus className="h-3 w-3" />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t('project.newConversation')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
                )}
              </SortableRow>

              {expanded && (
                <div className="border-sidebar-border/70 ml-2.5 space-y-0.5 border-l py-0.5 pl-2.5">
                  {projectSessions.length === 0 && (
                    <div className="text-muted-foreground px-2 py-1.5 text-xs italic">
                      {t('project.noSessions')}
                    </div>
                  )}
                  {visibleSessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      isActive={currentSessionId === session.id}
                      isGenerating={generatingSessionId === session.id}
                      isPinned={false}
                      onTogglePin={() => {
                        update((state) => pinSession(state, session.id));
                      }}
                      onRename={(title) => {
                        // The server ranks title sources, so nothing needs
                        // cancelling here: a generated title that lands later
                        // cannot overwrite the name sent below.
                        // Ordering, the single delayed retry, and the
                        // rollback-on-final-failure live in `runManualRename`
                        // so they're unit-testable without rendering this
                        // component — see apps/web/lib/session-title.ts.
                        void runManualRename(
                          {
                            sessionId: session.id,
                            title,
                            previousTitle: session.title,
                            setTitle: (id, newTitle) =>
                              useSessionStore
                                .getState()
                                .updateSessionTitle(id, newTitle),
                            rename: renameServerSession,
                            setError,
                          },
                          tc,
                        );
                      }}
                      onClick={() => openSession(session.id)}
                      onDelete={() => handleDeleteSession(session.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
          </SortableContext>
        </DndContext>
      </div>

      {/* projectId is immutable and a fresh add gets a new UUID, so deleting a
          project permanently orphans every session under it (still on the
          server, but unreachable from the sidebar) — hence the session count
          in the confirmation text. */}
      <ConfirmDeleteDialog
        open={projectPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setProjectPendingDelete(null);
        }}
        title={t('project.delete')}
        description={
          projectPendingDelete === null
            ? ''
            : projectPendingDelete.sessionCount > 0
              ? t('project.deleteConfirmWithSessions', {
                  name: projectPendingDelete.name,
                  count: projectPendingDelete.sessionCount,
                })
              : t('project.deleteConfirm', { name: projectPendingDelete.name })
        }
        onConfirm={() => {
          if (projectPendingDelete) {
            void handleRemoveProject(projectPendingDelete.id);
          }
          setProjectPendingDelete(null);
        }}
      />
    </div>
  );
}