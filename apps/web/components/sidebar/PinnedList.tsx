'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useChatStore } from '@/stores/chat-store';
import { useConfigStore } from '@/stores/config-store';
import { useSessionStore } from '@/stores/session-store';
import { useSidebarStateStore } from '@/stores/sidebar-state-store';
import { ensureSessionDetail } from '@/hooks/use-server-sessions';
import { deleteServerSession, renameServerSession } from '@/lib/sessions-api';
import { runManualRename } from '@/lib/session-title';
import { runSessionDelete } from '@/lib/session-delete';
import { sortPinned, unpinSession } from '@/lib/sidebar-layout';
import { cn } from '@/lib/utils';
import type { PinnedSortMode } from '@/lib/sidebar-state-api';
import { SectionHeader } from './SectionHeader';
import { SessionItem } from './SessionItem';

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
  const generatingSessionId = useChatStore((s) =>
    s.isGenerating ? s.currentSessionId : null,
  );
  const doc = useSidebarStateStore((s) => s.state);
  const update = useSidebarStateStore((s) => s.update);
  const [error, setError] = useState<string | null>(null);
  // Shared with `runSessionDelete`, which does the check-and-add itself.
  const deletingSessionIds = useRef<Set<string>>(new Set());

  const pinned = sortPinned(sessions, doc.sortModes.pinned, doc.pinnedSessionIds);
  if (pinned.length === 0) return null;

  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  const openSession = (sessionId: string, projectId: string | null) => {
    useSessionStore.getState().setCurrentSession(sessionId);
    // Make sure the workspace is expanded so the row is also visible in its
    // own section — but never override the user's whole-section collapse.
    if (projectId !== null) {
      update((state) => {
        const expanded = state.expandedProjectIds ?? [];
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
        {pinned.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            isActive={currentSessionId === session.id}
            isGenerating={generatingSessionId === session.id}
            isPinned
            label={
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
            onClick={() => openSession(session.id, session.projectId)}
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
        ))}
      </div>
    </>
  );
}