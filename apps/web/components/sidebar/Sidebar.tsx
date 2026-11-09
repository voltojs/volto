'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Settings, FolderPlus, Loader2 } from 'lucide-react';
import { useSessionStore } from '@/stores/session-store';
import { useSidebarStateStore } from '@/stores/sidebar-state-store';
import { useChatStore } from '@/stores/chat-store';
import { useConfigStore } from '@/stores/config-store';
import { useAddProject } from '@/hooks/use-add-project';
import { useServerSessions } from '@/hooks/use-server-sessions';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';
import { PinnedList } from './PinnedList';
import { ProjectList } from './ProjectList';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { SidebarToggle } from '@/components/sidebar/SidebarToggle';

/** SSE 连接状态指示（原 ChatHeader 顶栏的状态点，随状态/主题移入侧栏底部行）。 */
const CONNECTION_LABEL_KEY: Record<string, string> = {
  connected: 'connection.connected',
  connecting: 'connection.connecting',
  disconnected: 'connection.disconnected',
};

const CONNECTION_DOT: Record<string, string> = {
  connected: 'bg-success',
  connecting: 'bg-primary animate-pulse',
  disconnected: 'bg-destructive',
};

/**
 * Whether a config-load failure is the gateway refusing our credentials.
 * Matched on the message because the store keeps only the text — the
 * gateway answers every rejection with the same `{"error":"Unauthorized"}`.
 */
function isUnauthorized(message: string): boolean {
  return /unauthorized/i.test(message);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA'
  );
}

export function Sidebar() {
  const t = useTranslations('sidebar');
  const sidebarOpen = useSessionStore((s) => s.sidebarOpen);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const pendingProjectId = useSessionStore((s) => s.pendingProjectId);
  const connectionState = useChatStore((s) => s.connectionState);
  const load = useConfigStore((s) => s.load);
  const error = useConfigStore((s) => s.error);

  // The settings dialog's subagents panel must resolve project-scoped
  // definitions against the workspace the user is actually in — the active
  // session's project, or the workspace picked on the welcome screen. Null
  // (no workspace anywhere) falls back to the gateway's default cwd.
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const settingsProjectId =
    currentSessionId === null
      ? pendingProjectId
      : (currentSession?.projectId ?? null);

  const [showSettings, setShowSettings] = useState(false);
  const { run: addProjectViaPicker, pending: addingProject } = useAddProject();

  useEffect(() => {
    void load();
    // The sidebar layout document is independent of the gateway config load:
    // it has its own endpoint and degrades to the default layout on failure.
    void useSidebarStateStore.getState().load();
  }, [load]);

  useServerSessions();

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
    useChatStore.getState().clear();
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
          {/* Only while the sidebar is visible: when collapsed the ChatHeader
              owns the expand control, and a hidden duplicate would stay
              focusable inside the zero-width container. */}
          {sidebarOpen && (
            <div className="ml-auto">
              <SidebarToggle />
            </div>
          )}
        </div>

        <div className="px-3 pb-3">
          <Button
            variant="secondary"
            className="w-full justify-start gap-2 font-medium"
            onClick={startNewSession}
          >
            <Plus className="h-4 w-4" />
            {t('newSession')}
          </Button>
        </div>

        <Separator />

        <div className="flex-1 overflow-y-auto px-2 pt-1 pb-2">
          {error ? (
            <div className="border-destructive/30 bg-destructive/10 text-destructive mx-1 mt-2 space-y-1.5 rounded-md border px-2.5 py-2 text-xs">
              <p>{t('connection.failed', { error })}</p>
              {/* An unauthenticated 401 is the one failure the user can fix
                  themselves, but only if told how: the launch URL is printed
                  once on the gateway's stdout and the cookie is HttpOnly, so
                  nothing on this page can recover the session on its own. */}
              {isUnauthorized(error) ? (
                <p className="opacity-90">
                  {t('connection.credentialsTitle')}
                  <span className="font-mono"> Open this URL to authenticate </span>
                  {t('connection.credentialsAction')}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {/* Pinned first: it is a cross-workspace shortcut, so it must
                  not sit below the directories it shortcuts. */}
              <PinnedList />

              <div className="flex items-center justify-between px-2 pt-3 pb-1.5">
                <span className="text-muted-foreground font-mono text-[10px] font-medium tracking-[0.14em] uppercase">
                  {t('workspaces')}
                </span>
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
              </div>

              <ProjectList />
            </>
          )}
        </div>

        <Separator />

        {/* 底部一行：连接状态（仅会话激活时有意义）+ 主题切换 + 设置 */}
        <div className="flex items-center gap-1 p-2">
          {currentSessionId !== null && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="text-muted-foreground flex h-8 min-w-0 flex-1 items-center gap-2 px-1 text-xs">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        CONNECTION_DOT[connectionState],
                      )}
                    />
                    <span className="truncate">
                      {t(CONNECTION_LABEL_KEY[connectionState] ?? 'connection.disconnected')}
                    </span>
                  </span>
                }
              />
              <TooltipContent>{t(CONNECTION_LABEL_KEY[connectionState] ?? 'connection.disconnected')}</TooltipContent>
            </Tooltip>
          )}
          {currentSessionId === null && <span className="flex-1" />}
          <ThemeToggle />
          <Button
            variant="ghost"
            className="text-muted-foreground shrink-0 gap-2"
            onClick={() => setShowSettings(true)}
          >
            <Settings className="h-4 w-4" />
            {t('settings')}
          </Button>
        </div>
      </div>

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} projectId={settingsProjectId} />
    </div>
  );
}
