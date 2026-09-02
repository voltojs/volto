'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { ProjectPicker } from './ProjectPicker';
import { ModelPicker } from './ModelPicker';
import { PermissionPicker } from './PermissionPicker';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useConfigStore } from '@/stores/config-store';
import { useChatAgent } from '@/hooks/use-chat-agent';
import { Bot } from 'lucide-react';

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const isGenerating = useChatStore((s) => s.isGenerating);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const prevSessionIdRef = useRef<string | null>(null);
  const { sendMessage, connectionState } = useChatAgent();
  const projects = useConfigStore((s) => s.projects);
  const providers = useConfigStore((s) => s.providers);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  const hasModel = providers.some((p) => p.models.length > 0);

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

  // A session persisted before project-binding shipped can have projectId/
  // providerId/modelId as null (see migrate() in session-store.ts).
  // use-chat-agent guards against actually dispatching in that case, but the
  // input should also be disabled up front so the user sees why instead of
  // typing into a box that silently does nothing.
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const missingBinding =
    currentSessionId !== null &&
    (!currentSession?.projectId || !currentSession.providerId || !currentSession.modelId);

  // Only worth surfacing once a session exists — before that there is nothing
  // to connect to yet.
  const showOffline = currentSessionId !== null && connectionState !== 'connected';
  const statusBar = showOffline ? (
    <div className="px-4 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-200">
      {connectionState === 'connecting'
        ? '正在连接 agent 服务…'
        : '未连接 agent 服务，请确认 headless-server 已在 http://localhost:3100 启动'}
    </div>
  ) : null;

  // Show welcome screen when no messages
  if (messages.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-gray-50">
        {statusBar}
        <div className="text-center max-w-2xl px-4">
          <div className="flex items-center justify-center gap-2 mb-6">
            <Bot className="h-12 w-12 text-blue-500" />
            <h2 className="text-3xl font-bold">探索未至之境</h2>
          </div>
          <p className="text-gray-500 mb-8">
            我是 Volto，你的 AI 助手。有什么我可以帮助你的吗？
          </p>
        </div>
        <div className="w-full max-w-2xl px-4">
          <div className="mb-2 flex items-center justify-center gap-2">
            <ProjectPicker value={pendingProjectId} onChange={setPendingProjectId} />
          </div>

          {projects.length === 0 ? (
            <p className="text-center text-sm text-gray-500">
              请先在左侧「工作区」添加一个项目
            </p>
          ) : !hasModel ? (
            <p className="text-center text-sm text-gray-500">
              请先在「设置」中添加供应商与模型
            </p>
          ) : (
            <InputBar
              onSubmit={startSession}
              disabled={isGenerating || !pendingProjectId}
              placeholder={pendingProjectId ? '描述你想要构建的内容…' : '请先选择项目'}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {statusBar}
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
