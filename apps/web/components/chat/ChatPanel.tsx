'use client';

import { useEffect, useRef } from 'react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useChatAgent } from '@/hooks/use-chat-agent';
import { Bot } from 'lucide-react';

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const isGenerating = useChatStore((s) => s.isGenerating);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const prevSessionIdRef = useRef<string | null>(null);
  const { sendMessage, connectionState } = useChatAgent();

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

  // sendMessage creates the session itself when there is none, so the panel
  // does not need to pre-create one (doing so would race the SSE channel).
  const handleSubmit = (content: string) => sendMessage(content);

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
          <InputBar onSubmit={handleSubmit} disabled={isGenerating} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {statusBar}
      <MessageList />
      <InputBar onSubmit={handleSubmit} disabled={isGenerating} />
    </div>
  );
}
