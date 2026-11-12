'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GripVertical } from 'lucide-react';
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
import { useConfigStore } from '@/stores/config-store';
import { useSessionStore } from '@/stores/session-store';
import { useSidebarStateStore } from '@/stores/sidebar-state-store';
import { ensureSessionDetail } from '@/hooks/use-server-sessions';
import { createClickSuppressor } from '@/lib/click-suppressor';
import { deleteServerSession, renameServerSession } from '@/lib/sessions-api';
import { runManualRename } from '@/lib/session-title';
import { runSessionDelete } from '@/lib/session-delete';
import { applyDragEnd, sortPinned, unpinSession, SESSION_PREVIEW_COUNT } from '@/lib/sidebar-layout';
import { cn } from '@/lib/utils';
import type { PinnedSortMode } from '@/lib/sidebar-state-api';
import { SectionHeader } from './SectionHeader';
import { SessionItem } from './SessionItem';
import { SortableRow } from './SortableRow';

/**
 * The pinned section: sessions collected across every workspace, ordered by
 * the section's own sort mode.
 *
 * A pinned session is removed from its workspace's list (one row, one home),
 * so this is the only place it can be reached from until it is unpinned. The
 * whole section — header included — disappears when nothing is pinned.
 */
export function PinnedList() {
  const t = useTranslations('sidebar');
  const tc = useTranslations('chat');
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const projects = useConfigStore((s) => s.projects);
  const doc = useSidebarStateStore((s) => s.state);
  const update = useSidebarStateStore((s) => s.update);
  const [error, setError] = useState<string | null>(null);
  // Whether the pinned list is expanded past the preview count. Local
  // transient view state, same as the workspace lists' per-project flag.
  const [showAll, setShowAll] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // A drag ends with a pointerup, after which the row's own click would fire
  // and open the session. Swallow exactly that click.
  const clickSuppressor = useRef(createClickSuppressor()).current;
  // Shared with `runSessionDelete`, which does the check-and-add itself.
  const deletingSessionIds = useRef<Set<string>>(new Set());

  const pinned = sortPinned(sessions, doc.sortModes.pinned, doc.pinnedSessionIds);
  if (pinned.length === 0) return null;

  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  // What the workspaces section renders while `expandedProjectIds` is absent:
  // the first workspace. Opening a pinned session must not collapse it.
  const defaultExpandedId = projects[0]?.id ?? null;
  const manual = doc.sortModes.pinned === 'manual';
  const renderedIds = pinned.map((session) => session.id);
  const hiddenCount = Math.max(0, pinned.length - SESSION_PREVIEW_COUNT);
  const listedPinned =
    showAll || hiddenCount === 0
      ? pinned
      : pinned.slice(0, SESSION_PREVIEW_COUNT);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = renderedIds.indexOf(String(active.id));
    const to = renderedIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    clickSuppressor.suppress();
    update((state) => applyDragEnd(state, 'pinned', renderedIds, from, to));
  };

  const openSession = (sessionId: string, projectId: string | null) => {
    useSessionStore.getState().setCurrentSession(sessionId);
    // Make sure the workspace is expanded so the row is also visible in its
    // own section — but never override the user's whole-section collapse.
    if (projectId !== null) {
      update((state) => {
        const expanded =
          state.expandedProjectIds ??
          (defaultExpandedId === null ? [] : [defaultExpandedId]);
        if (expanded.includes(projectId)) return state;
        return { ...state, expandedProjectIds: [...expanded, projectId] };
      });
    }
    void ensureSessionDetail(sessionId, tc).catch(() => {});
  };

  return (
    <>
      {error && <p className="text-destructive px-2 py-1 text-xs">{error}</p>}
      <SectionHeader
        title={t('pinned.title')}
        count={pinned.length}
        collapsed={doc.pinnedCollapsed}
        onToggleCollapsed={() =>
          update((state) => ({ ...state, pinnedCollapsed: !state.pinnedCollapsed }))
        }
        sort={{
          value: doc.sortModes.pinned,
          options: [
            { value: 'manual', label: t('sort.manual') },
            { value: 'recent', label: t('sort.recent') },
          ],
          onChange: (value) =>
            update((state) => ({
              ...state,
              sortModes: { ...state.sortModes, pinned: value as PinnedSortMode },
            })),
        }}
      />
      {/* Hidden rather than unmounted while collapsed: the rows keep their
          scroll position and dialogs stay intact when the section reopens. */}
      <div
        className={cn(
          'space-y-0.5 px-2 pb-1',
          doc.pinnedCollapsed && 'hidden',
        )}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={renderedIds}
            strategy={verticalListSortingStrategy}
          >
        {listedPinned.map((session) => (
          <SortableRow key={session.id} id={session.id} enabled={manual}>
            {(handle) => (
          <SessionItem
            key={session.id}
            session={session}
            isActive={currentSessionId === session.id}
            isGenerating={session.running === true}
            isPinned
            projectName={
              session.projectId === null
                ? undefined
                : projectNames.get(session.projectId)
            }
            onTogglePin={() => update((state) => unpinSession(state, session.id))}
            onRename={(title) => {
              // Same ranking / retry / rollback path as the workspace rows:
              // the server owns the title, the local copy is optimistic.
              void runManualRename(
                {
                  sessionId: session.id,
                  title,
                  previousTitle: session.title,
                  setTitle: (id, next) =>
                    useSessionStore.getState().updateSessionTitle(id, next),
                  rename: renameServerSession,
                  setError,
                },
                tc,
              );
            }}
            dragHandle={
              manual ? (
                <button
                  type="button"
                  ref={handle.setActivatorNodeRef}
                  {...handle.attributes}
                  {...handle.listeners}
                  aria-label={t('drag.handle')}
                  className="text-muted-foreground hover:text-foreground flex h-3.5 w-3.5 shrink-0 cursor-grab items-center justify-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <GripVertical className="h-3 w-3" />
                </button>
              ) : undefined
            }
            onClick={() => {
              if (clickSuppressor.consume()) return;
              openSession(session.id, session.projectId);
            }}
            onDelete={() => {
              void runSessionDelete(
                {
                  sessionId: session.id,
                  deletingIds: deletingSessionIds.current,
                  deleteServer: deleteServerSession,
                  deleteLocal: (id) => useSessionStore.getState().deleteSession(id),
                  setError,
                },
                tc,
              );
            }}
          />
            )}
          </SortableRow>
        ))}
          </SortableContext>
        </DndContext>
        {/* Bottom affordance: expand the remainder, then collapse back to
            the preview once expanded — mirrors the workspace lists. */}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11px] transition-colors"
          >
            {/* Spacer mirroring the session row's leading icon slot, so this
                line's text aligns with the titles above. */}
            <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            {showAll
              ? t('showLessSessions')
              : t('showMoreSessions', { count: hiddenCount })}
          </button>
        )}
      </div>
    </>
  );
}