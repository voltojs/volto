'use client';

import { useEffect, useRef } from 'react';
import { FolderPlus, Loader2 } from 'lucide-react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { ChatHeader } from './ChatHeader';
import { ProjectPicker } from './ProjectPicker';
import { ModelPicker } from './ModelPicker';
import { PermissionPicker } from './PermissionPicker';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useConfigStore } from '@/stores/config-store';
import { useChatAgent } from '@/hooks/use-chat-agent';
import { useAddProject } from '@/hooks/use-add-project';
import { cn } from '@/lib/utils';

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const isGenerating = useChatStore((s) => s.isGenerating);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const prevSessionIdRef = useRef<string | null>(null);
  const { sendMessage, connectionState } = useChatAgent();
  const projects = useConfigStore((s) => s.projects);
  const providers = useConfigStore((s) => s.providers);
  const pendingProjectId = useSessionStore((s) => s.pendingProjectId);
  const setPendingProjectId = useSessionStore((s) => s.setPendingProjectId);
  const { run: addProjectViaPicker, pending: addingProject } = useAddProject();

  const hasModel = providers.some((p) => p.models.length > 0);

  // Defaults the welcome screen's project picker to the first workspace.
  // Only fills a genuinely empty selection — it never overrides a project
  // the user (or the sidebar's per-project "new conversation" button) has
  // already chosen, and projects can load asynchronously after mount.
  const firstProjectId = projects[0]?.id ?? null;
  useEffect(() => {
    if (pendingProjectId === null && firstProjectId) {
      setPendingProjectId(firstProjectId);
    }
  }, [pendingProjectId, firstProjectId, setPendingProjectId]);

  const startSession = (content: string) => {
    const firstProvider = providers.find((p) => p.models.length > 0);
    const id = useSessionStore.getState().createSession({
      projectId: pendingProjectId,
      providerId: firstProvider?.id ?? null,
      modelId: firstProvider?.models[0]?.id ?? null,
    });
    useSessionStore.getState().setCurrentSession(id);
    void sendMessage(content);
  };

  // Load messages when session changes
  useEffect(() => {
    if (currentSessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = currentSessionId;
      if (currentSessionId) {
        const session = sessions.find((s) => s.id === currentSessionId);
        if (session) {
          useChatStore.setState({ messages: session.messages });
        }
      } else {
        useChatStore.setState({ messages: [] });
      }
    }
  }, [currentSessionId, sessions]);

  // Save messages when they change (debounced)
  useEffect(() => {
    if (!currentSessionId) return;
    const timeoutId = setTimeout(() => {
      useSessionStore.getState().updateSessionMessages(currentSessionId, messages);
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [messages, currentSessionId]);

  // Once a session exists (the conversation branch below), sendMessage can
  // dispatch directly — the welcome screen is the only place that still needs
  // to create one first, via startSession.
  const handleSubmit = (content: string) => sendMessage(content);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const currentProject = projects.find((p) => p.id === currentSession?.projectId);

  // A session persisted before project-binding shipped can have projectId/
  // providerId/modelId as null (see migrate() in session-store.ts).
  // use-chat-agent guards against actually dispatching in that case, but the
  // input should also be disabled up front so the user sees why instead of
  // typing into a box that silently does nothing.
  const missingBinding =
    currentSessionId !== null &&
    (!currentSession?.projectId || !currentSession.providerId || !currentSession.modelId);

  // Only worth surfacing once a session exists — before that there is nothing
  // to connect to yet.
  const showOffline = currentSessionId !== null && connectionState !== 'connected';

  // Show welcome screen when no messages
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <ChatHeader />
        <div className="bg-grain flex flex-1 flex-col items-center justify-center px-4">
          <div className="mb-8 max-w-2xl text-center">
            <div className="mb-5 flex items-center justify-center gap-3">
              <svg viewBox="0 0 24 24" className="h-9 w-9 text-primary" aria-hidden="true">
                <path
                  d="M4 5 L11 19 L13 19 L20 5 L17.2 5 L12 15.5 L6.8 5 Z"
                  fill="currentColor"
                />
              </svg>
              <h2 className="font-display text-4xl font-semibold tracking-tight">
                探索未至之境
              </h2>
            </div>
            <p className="text-muted-foreground">
              我是 Volto，你的 AI 助手。有什么我可以帮助你的吗？
            </p>
          </div>

          <div className="w-full max-w-2xl">
            {projects.length === 0 ? (
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm text-muted-foreground">
                  还没有工作区，添加一个开始吧
                </p>
                <Button
                  onClick={() => void addProjectViaPicker().then((p) => p && setPendingProjectId(p.id))}
                  disabled={addingProject}
                  className="gap-2"
                >
                  {addingProject ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FolderPlus className="h-4 w-4" />
                  )}
                  {addingProject ? '正在等待系统对话框…' : '添加工作区'}
                </Button>
              </div>
            ) : !hasModel ? (
              <p className="text-center text-sm text-muted-foreground">
                请先在「设置」中添加供应商与模型
              </p>
            ) : (
              <InputBar
                onSubmit={startSession}
                disabled={isGenerating || !pendingProjectId}
                placeholder={pendingProjectId ? '描述你想要构建的内容…' : '请先选择工作区'}
                toolbar={<ProjectPicker value={pendingProjectId} onChange={setPendingProjectId} />}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader projectName={currentProject?.name} connectionState={connectionState} />
      {showOffline && (
        <div
          className={cn(
            'border-b px-4 py-1.5 text-center text-xs',
            connectionState === 'connecting'
              ? 'border-primary/20 bg-primary/10 text-primary'
              : 'border-destructive/20 bg-destructive/10 text-destructive',
          )}
        >
          {connectionState === 'connecting'
            ? '正在连接 agent 服务…'
            : '未连接 agent 服务，请确认 headless-server 已在 http://localhost:3100 启动'}
        </div>
      )}
      <MessageList />
      <InputBar
        onSubmit={handleSubmit}
        disabled={isGenerating || missingBinding}
        placeholder={missingBinding ? '此会话缺少绑定的项目或模型，无法发送消息' : undefined}
        toolbar={
          currentSessionId ? (
            <>
              <PermissionPicker sessionId={currentSessionId} />
              <ModelPicker sessionId={currentSessionId} />
            </>
          ) : null
        }
      />
    </div>
  );
}
